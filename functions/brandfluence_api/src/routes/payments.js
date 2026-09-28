'use strict';
/**
 * Payment protection (sections 21–22).
 * Business pays → Razorpay transfer to creator is held → released on approval / auto-release / admin decision.
 */
const router = require('express').Router();
const db = require('../lib/db');
const { wrap, badRequest, conflict } = require('../lib/errors');
const { requireRole, requireProfile } = require('../lib/auth');
const { STATUS, transition, loadDealFor, participants, computeFees } = require('../services/dealMachine');
const { notify } = require('../services/notify');
const { audit } = require('../services/audit');
const rzp = require('../services/razorpay');

/* Step 1 – business creates a payment order for a signed deal */
router.post('/deals/:id/payment-order', requireRole('business'), wrap(async (req, res) => {
  const app = req.app_;
  const { deal } = await loadDealFor(req, req.params.id);
  if (deal.status !== STATUS.CONTRACT_SIGNED) throw conflict('Both parties must sign the agreement before payment');
  const creator = await db.one(app, 'CreatorProfiles', `ROWID = ${db.id(deal.creator_id)}`);
  if (!creator.razorpay_account_id) throw conflict('The creator has not set up their payout account yet. We have reminded them.');

  const existing = await db.one(app, 'Payments', `deal_id = ${deal.ROWID} AND payment_type = 'deal_funding' AND status = 'created'`);
  const fees = computeFees(deal.agreed_amount);
  let order;
  let payment = existing;
  if (existing && existing.gateway_order_id) {
    order = { id: existing.gateway_order_id, amount: Math.round(fees.businessPays * 100) };
  } else {
    order = await rzp.createOrder({
      amount: fees.businessPays,
      receipt: deal.deal_number,
      creatorAccountId: creator.razorpay_account_id,
      creatorPayout: fees.creatorPayout,
      notes: { deal_id: String(deal.ROWID), deal_number: deal.deal_number },
    });
    payment = await db.insert(app, 'Payments', {
      deal_id: deal.ROWID, business_id: deal.business_id, creator_id: deal.creator_id,
      payment_type: 'deal_funding', gross_amount: fees.businessPays, platform_fee: fees.platformFee,
      tax_amount: fees.tax, net_amount: fees.creatorPayout, gateway: 'razorpay', gateway_order_id: order.id, status: 'created',
    });
  }
  res.json({
    key_id: process.env.RAZORPAY_KEY_ID,
    order_id: order.id,
    amount: order.amount,
    currency: 'INR',
    name: 'Brandfluence',
    description: `Deal ${deal.deal_number}`,
    fees,
    payment_id: payment.ROWID,
  });
}));

/* Step 2 – checkout success callback from the browser (webhook below is the source of truth too) */
router.post('/payments/verify', requireRole('business'), wrap(async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!rzp.verifyCheckoutSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) throw badRequest('Payment verification failed');
  const payment = await db.one(req.app_, 'Payments', `gateway_order_id = ${db.str(razorpay_order_id)}`);
  if (!payment || String(payment.business_id) !== String(req.business.ROWID)) throw badRequest('Payment not found');
  const deal = await markCaptured(req.app_, payment, razorpay_payment_id, req.profile);
  res.json({ ok: true, deal });
}));

/* Business releases held funds (after approval / publishing) */
router.post('/deals/:id/release', requireRole('business', 'admin'), wrap(async (req, res) => {
  const { deal } = await loadDealFor(req, req.params.id);
  if (![STATUS.APPROVED, STATUS.PUBLISHED].includes(deal.status)) throw conflict('Payment can be released once content is approved');
  const updated = await releaseDeal(req.app_, deal, req.profile);
  res.json({ deal: updated });
}));

/* Wallet / earnings summary (section 22) */
router.get('/wallet', requireProfile, wrap(async (req, res) => {
  const app = req.app_;
  if (req.profile.role === 'creator') {
    const cid = req.creator.ROWID;
    const [released, held, list] = await Promise.all([
      db.sum(app, 'Payments', 'net_amount', `creator_id = ${cid} AND status = 'released'`),
      db.sum(app, 'Payments', 'net_amount', `creator_id = ${cid} AND status = 'held'`),
      db.select(app, 'Payments', `creator_id = ${cid} AND status IN ('held','released','refunded','partially_refunded')`, 'ORDER BY CREATEDTIME DESC LIMIT 0, 50'),
    ]);
    return res.json({ total_earned: released, pending: held, payouts_ready: Boolean(req.creator.razorpay_account_id),
      note: 'Released funds settle to your linked bank/UPI account on Razorpay\'s settlement schedule.',
      transactions: list.map(({ gateway_transfer_id, gateway_order_id, ...x }) => x) });
  }
  if (req.profile.role === 'business') {
    const bid = req.business.ROWID;
    const [spent, held, list] = await Promise.all([
      db.sum(app, 'Payments', 'gross_amount', `business_id = ${bid} AND status = 'released'`),
      db.sum(app, 'Payments', 'gross_amount', `business_id = ${bid} AND status = 'held'`),
      db.select(app, 'Payments', `business_id = ${bid}`, 'ORDER BY CREATEDTIME DESC LIMIT 0, 50'),
    ]);
    return res.json({ completed_spend: spent, funds_held: held,
      transactions: list.map(({ gateway_transfer_id, ...x }) => x) });
  }
  res.json({});
}));

/* ---------- shared logic (also used by webhook, scheduler, admin) ---------- */
async function markCaptured(app, payment, gatewayPaymentId, actor) {
  const deal = await db.one(app, 'Deals', `ROWID = ${db.id(payment.deal_id)}`);
  if (payment.status === 'held' || payment.status === 'released') return deal; // idempotent
  let transferId;
  try {
    const t = await rzp.paymentTransfers(gatewayPaymentId);
    transferId = t.items && t.items[0] && t.items[0].id;
  } catch (e) { console.error('fetch transfers failed', e.message); }
  await db.update(app, 'Payments', { ROWID: payment.ROWID, gateway_payment_id: gatewayPaymentId, gateway_transfer_id: transferId, status: 'held' });
  let updated = deal;
  if (deal.status === STATUS.CONTRACT_SIGNED) {
    updated = await transition(app, deal, STATUS.PAYMENT_SECURED, { actor, extra: { payment_status: 'held' }, details: { payment: payment.ROWID } });
    const p = await participants(app, deal);
    await notify(app, p.creatorUserId, {
      type: 'payment_secured', dealId: deal.ROWID, link: `/deals/${deal.ROWID}`,
      title: `Payment secured — start creating! (${deal.deal_number})`,
      body: `₹${Number(payment.net_amount).toLocaleString('en-IN')} is held safely and will be released after approval.`,
    });
  }
  return updated;
}

async function releaseDeal(app, deal, actor) {
  const open = await db.select(app, 'Disputes', `deal_id = ${deal.ROWID} AND status IN ('open','under_review')`);
  if (open.length) throw conflict('There is an open dispute on this deal');
  const payment = await db.one(app, 'Payments', `deal_id = ${deal.ROWID} AND payment_type = 'deal_funding' AND status = 'held'`);
  if (!payment) throw conflict('No held payment found for this deal');
  let transferId = payment.gateway_transfer_id;
  if (!transferId && payment.gateway_payment_id) {
    const t = await rzp.paymentTransfers(payment.gateway_payment_id);
    transferId = t.items && t.items[0] && t.items[0].id;
  }
  if (!transferId) throw conflict('Transfer not found at the payment gateway; contact support');
  await rzp.releaseTransfer(transferId);
  await db.update(app, 'Payments', { ROWID: payment.ROWID, status: 'released', released_at: db.now(), gateway_transfer_id: transferId });
  let d = deal;
  if (d.status === STATUS.APPROVED) d = await transition(app, d, STATUS.PUBLISHED, { actor, details: { note: 'released before publish confirmation' } });
  d = await transition(app, d, STATUS.COMPLETED, { actor, extra: { payment_status: 'released' }, details: { payment: payment.ROWID } });
  const p = await participants(app, deal);
  await notify(app, p.creatorUserId, {
    type: 'payment_released', dealId: deal.ROWID, link: `/earnings`,
    title: `Payment released: ₹${Number(payment.net_amount).toLocaleString('en-IN')}`,
    body: `Deal ${deal.deal_number} is complete. Please leave a review for the brand.`,
  });
  await notify(app, p.businessUserId, {
    type: 'deal_completed', dealId: deal.ROWID, link: `/deals/${deal.ROWID}`,
    title: `Deal completed — ${deal.deal_number}`, body: 'Please review the creator.',
  });
  await audit(app, { actor, entityType: 'payment', entityId: payment.ROWID, action: 'released', details: { transferId } });
  return d;
}

module.exports = router;
module.exports.markCaptured = markCaptured;
module.exports.releaseDeal = releaseDeal;
