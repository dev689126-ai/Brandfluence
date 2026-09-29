'use strict';
/**
 * Creator Pro plan: see plan, pay (Razorpay), activate.
 *   GET  /plans/me
 *   POST /plans/checkout   { period: 'month' | 'year' }
 *   POST /plans/verify     { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 */
const router = require('express').Router();
const db = require('../lib/db');
const { wrap, badRequest, conflict } = require('../lib/errors');
const { requireRole } = require('../lib/auth');
const rzp = require('../services/razorpay');
const plans = require('../services/plans');
const { audit } = require('../services/audit');
const { notify } = require('../services/notify');

const creatorOnly = requireRole('creator');

router.get('/me', creatorOnly, wrap(async (req, res) => {
  const info = await plans.planInfo(req.app_, req.creator);
  const history = await db.select(req.app_, 'CreatorSubscriptions',
    `creator_id = ${req.creator.ROWID} AND status = 'active'`, 'ORDER BY CREATEDTIME DESC LIMIT 0, 12');
  res.json({ ...info, payments_enabled: rzp.configured(),
    history: history.map(({ gateway_order_id, gateway_payment_id, ...h }) => h) });
}));

router.post('/checkout', creatorOnly, wrap(async (req, res) => {
  const period = (req.body || {}).period;
  const price = plans.PRICES()[period];
  if (!price) throw badRequest('Choose monthly or yearly');
  if (!rzp.configured()) throw conflict('Online payment is not switched on yet. Contact support and we will upgrade your account.');
  const receipt = `pro_${req.creator.ROWID}_${Date.now()}`.slice(0, 40);
  const order = await rzp.createPlainOrder({
    amount: price, receipt,
    notes: { kind: 'creator_plan', creator_id: String(req.creator.ROWID), period },
  });
  await db.insert(req.app_, 'CreatorSubscriptions', {
    creator_id: req.creator.ROWID, plan: 'pro', period, amount: price, status: 'created', source: 'payment', gateway_order_id: order.id,
  });
  res.json({
    key_id: process.env.RAZORPAY_KEY_ID, order_id: order.id, amount: order.amount, currency: 'INR',
    name: 'Brandfluence', description: period === 'year' ? 'Creator Pro, 1 year' : 'Creator Pro, 1 month',
  });
}));

router.post('/verify', creatorOnly, wrap(async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!rzp.verifyCheckoutSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) throw badRequest('Payment verification failed');
  const sub = await db.one(req.app_, 'CreatorSubscriptions', `gateway_order_id = ${db.str(razorpay_order_id)}`);
  if (!sub || String(sub.creator_id) !== String(req.creator.ROWID)) throw badRequest('Subscription not found');
  const active = await activateOnPayment(req.app_, sub, razorpay_payment_id, req.profile);
  res.json({ ok: true, ends_at: active.ends_at });
}));

async function activateOnPayment(app, sub, paymentId, actor) {
  const wasActive = sub.status === 'active';
  const active = await plans.activateSubscription(app, sub, paymentId);
  if (!wasActive) {
    await audit(app, { actor, entityType: 'subscription', entityId: sub.ROWID, action: 'pro_activated', details: { period: sub.period, amount: sub.amount, ends_at: active.ends_at } });
    const c = await db.one(app, 'CreatorProfiles', `ROWID = ${db.id(sub.creator_id)}`);
    if (c) await notify(app, c.user_profile_id, { type: 'plan', link: '/plan', title: 'You are now a Pro creator',
      body: `Pro is active until ${String(active.ends_at).slice(0, 10)}. Start pitching brands from "Find brands".` });
  }
  return active;
}

module.exports = router;
module.exports.activateOnPayment = activateOnPayment;
