'use strict';
/** Admin panel API (sections 28–30). Every mutating action is audit-logged. */
const router = require('express').Router();
const db = require('../lib/db');
const { wrap, badRequest, conflict, notFound } = require('../lib/errors');
const { requireRole } = require('../lib/auth');
const { STATUS, ACTIVE, transition, participants } = require('../services/dealMachine');
const { notify } = require('../services/notify');
const { audit } = require('../services/audit');
const { recomputeCreator } = require('../services/social');
const { releaseDeal } = require('./payments');
const rzp = require('../services/razorpay');

router.use(requireRole('admin'));

/* Dashboard numbers */
router.get('/stats', wrap(async (req, res) => {
  const app = req.app_;
  const [creators, businesses, active, completed, gmv, revenue, held, disputes, pendingBiz, pendingKyc] = await Promise.all([
    db.count(app, 'UserProfiles', `role = 'creator'`),
    db.count(app, 'UserProfiles', `role = 'business'`),
    db.count(app, 'Deals', `status IN ${db.list(ACTIVE)}`),
    db.count(app, 'Deals', `status = 'completed'`),
    db.sum(app, 'Payments', 'gross_amount', `status IN ('held','released')`),
    db.sum(app, 'Payments', 'platform_fee', `status = 'released'`),
    db.sum(app, 'Payments', 'gross_amount', `status = 'held'`),
    db.count(app, 'Disputes', `status IN ('open','under_review')`),
    db.count(app, 'BusinessProfiles', `verification_status = 'submitted'`),
    db.count(app, 'CreatorProfiles', `kyc_status = 'submitted'`),
  ]);
  res.json({ users: { creators, businesses }, deals: { active, completed }, gmv, platform_revenue: revenue,
    funds_held: held, open_disputes: disputes, pending_verifications: { businesses: pendingBiz, creator_payouts: pendingKyc } });
}));

/* Users */
router.get('/users', wrap(async (req, res) => {
  const where = [];
  if (req.query.role) where.push(`role = ${db.str(req.query.role)}`);
  if (req.query.status) where.push(`status = ${db.str(req.query.status)}`);
  if (req.query.q) where.push(`email LIKE '*${db.esc(req.query.q)}*'`);
  const { tail, page, size } = db.paging(req);
  res.json({ page, size, data: await db.select(req.app_, 'UserProfiles', where.join(' AND '), `ORDER BY CREATEDTIME DESC ${tail}`) });
}));

router.post('/users/:id/status', wrap(async (req, res) => {
  const { status, reason } = req.body || {};
  if (!['active', 'suspended'].includes(status)) throw badRequest('Status must be active or suspended');
  const u = await db.mustGet(req.app_, 'UserProfiles', req.params.id, 'User');
  if (u.role === 'admin') throw conflict('Admins cannot be suspended here');
  await db.update(req.app_, 'UserProfiles', { ROWID: u.ROWID, status });
  await audit(req.app_, { actor: req.profile, entityType: 'user', entityId: u.ROWID, action: `user_${status}`, from: u.status, to: status, details: { reason }, ip: req.ip });
  res.json({ ok: true });
}));

/* Creator verification badge + payout (KYC) review */
router.get('/creators', wrap(async (req, res) => {
  const where = [];
  if (req.query.kyc_status) where.push(`kyc_status = ${db.str(req.query.kyc_status)}`);
  if (req.query.verified) where.push(`is_verified = ${req.query.verified === '1'}`);
  if (req.query.q) where.push(`(full_name LIKE '*${db.esc(req.query.q)}*' OR username LIKE '*${db.esc(req.query.q)}*')`);
  const { tail } = db.paging(req);
  const rows = await db.select(req.app_, 'CreatorProfiles', where.join(' AND '), `ORDER BY CREATEDTIME DESC ${tail}`);
  res.json({ data: rows.map(({ razorpay_account_id, ...c }) => ({ ...c, has_payout_account: Boolean(razorpay_account_id) })) });
}));

router.post('/creators/:id/verify', wrap(async (req, res) => {
  const c = await db.mustGet(req.app_, 'CreatorProfiles', req.params.id, 'Creator');
  const row = { ROWID: c.ROWID };
  if (req.body.is_verified !== undefined) row.is_verified = req.body.is_verified === true;
  if (req.body.kyc_status) {
    if (!['verified', 'rejected', 'pending'].includes(req.body.kyc_status)) throw badRequest('Invalid KYC status');
    row.kyc_status = req.body.kyc_status;
  }
  await db.update(req.app_, 'CreatorProfiles', row);
  if (row.is_verified !== undefined) await db.update(req.app_, 'UserProfiles', { ROWID: c.user_profile_id, identity_verified: row.is_verified });
  await recomputeCreator(req.app_, c.ROWID);
  await audit(req.app_, { actor: req.profile, entityType: 'creator', entityId: c.ROWID, action: 'creator_verification', details: row, ip: req.ip });
  await notify(req.app_, c.user_profile_id, { type: 'verification', title: row.is_verified === false || row.kyc_status === 'rejected' ? 'Verification update' : 'Your profile is verified ✓', body: req.body.note || '' });
  res.json({ ok: true });
}));

/* Business verification */
router.get('/businesses', wrap(async (req, res) => {
  const where = [];
  if (req.query.verification_status) where.push(`verification_status = ${db.str(req.query.verification_status)}`);
  if (req.query.q) where.push(`company_name LIKE '*${db.esc(req.query.q)}*'`);
  const { tail } = db.paging(req);
  res.json({ data: await db.select(req.app_, 'BusinessProfiles', where.join(' AND '), `ORDER BY CREATEDTIME DESC ${tail}`) });
}));

router.post('/businesses/:id/verify', wrap(async (req, res) => {
  const { status, note } = req.body || {};
  if (!['verified', 'rejected', 'pending'].includes(status)) throw badRequest('Invalid status');
  const b = await db.mustGet(req.app_, 'BusinessProfiles', req.params.id, 'Business');
  await db.update(req.app_, 'BusinessProfiles', { ROWID: b.ROWID, verification_status: status });
  await audit(req.app_, { actor: req.profile, entityType: 'business', entityId: b.ROWID, action: 'business_verification', from: b.verification_status, to: status, details: { note }, ip: req.ip });
  await notify(req.app_, b.user_profile_id, { type: 'verification', title: status === 'verified' ? 'Your business is verified ✓' : 'Business verification update', body: note || '' });
  res.json({ ok: true });
}));

/* Deals & payments oversight */
router.get('/deals', wrap(async (req, res) => {
  const where = [];
  if (req.query.status) where.push(`status IN ${db.list(String(req.query.status).split(','))}`);
  if (req.query.q) where.push(`deal_number LIKE '*${db.esc(req.query.q)}*'`);
  const { tail } = db.paging(req);
  res.json({ data: await db.select(req.app_, 'Deals', where.join(' AND '), `ORDER BY MODIFIEDTIME DESC ${tail}`) });
}));

router.get('/payments', wrap(async (req, res) => {
  const where = [];
  if (req.query.status) where.push(`status = ${db.str(req.query.status)}`);
  const { tail } = db.paging(req);
  res.json({ data: await db.select(req.app_, 'Payments', where.join(' AND '), `ORDER BY CREATEDTIME DESC ${tail}`) });
}));

router.get('/audit', wrap(async (req, res) => {
  const where = [];
  if (req.query.entity_type) where.push(`entity_type = ${db.str(req.query.entity_type)}`);
  if (req.query.entity_id) where.push(`entity_id = ${db.id(req.query.entity_id)}`);
  const { tail } = db.paging(req, 200);
  res.json({ data: await db.select(req.app_, 'AuditLogs', where.join(' AND '), `ORDER BY CREATEDTIME DESC ${tail}`) });
}));

/* Disputes */
router.get('/disputes', wrap(async (req, res) => {
  const where = [];
  if (req.query.status) where.push(`status IN ${db.list(String(req.query.status).split(','))}`);
  const { tail } = db.paging(req);
  res.json({ data: await db.select(req.app_, 'Disputes', where.join(' AND '), `ORDER BY CREATEDTIME DESC ${tail}`) });
}));

// Everything an admin needs to decide: contract, chat, files, approvals, payments (section 30 "Evidence")
router.get('/disputes/:id', wrap(async (req, res) => {
  const app = req.app_;
  const d = await db.mustGet(app, 'Disputes', req.params.id, 'Dispute');
  const did = db.id(d.deal_id);
  const [deal, messages, submissions, deliverables, payments, offers, timeline] = await Promise.all([
    db.one(app, 'Deals', `ROWID = ${did}`),
    db.select(app, 'Messages', `deal_id = ${did}`, 'ORDER BY ROWID ASC LIMIT 0, 300'),
    db.select(app, 'ContentSubmissions', `deal_id = ${did}`, 'ORDER BY CREATEDTIME ASC'),
    db.select(app, 'Deliverables', `deal_id = ${did}`),
    db.select(app, 'Payments', `deal_id = ${did}`),
    db.select(app, 'OfferVersions', `deal_id = ${did}`, 'ORDER BY version_no ASC'),
    db.select(app, 'AuditLogs', `entity_type = 'deal' AND entity_id = ${did}`, 'ORDER BY CREATEDTIME ASC LIMIT 0, 300'),
  ]);
  const p = await participants(app, deal);
  res.json({ dispute: d, deal, business: p.business, creator: p.creator, messages, submissions, deliverables, payments, offers, timeline });
}));

router.post('/disputes/:id/review', wrap(async (req, res) => {
  const d = await db.mustGet(req.app_, 'Disputes', req.params.id, 'Dispute');
  if (d.status !== 'open') throw conflict('Dispute is not open');
  await db.update(req.app_, 'Disputes', { ROWID: d.ROWID, status: 'under_review' });
  await audit(req.app_, { actor: req.profile, entityType: 'dispute', entityId: d.ROWID, action: 'under_review', ip: req.ip });
  res.json({ ok: true });
}));

/**
 * POST /admin/disputes/:id/resolve
 * { resolution: 'release' | 'refund' | 'partial' | 'dismiss', refund_amount?, notes }
 *  release – pay creator in full, deal completed
 *  refund  – reverse the held transfer and refund the business, deal cancelled
 *  partial – refund part to business, release the rest to creator, deal completed
 *  dismiss – no money movement; deal returns to its previous working status
 */
router.post('/disputes/:id/resolve', wrap(async (req, res) => {
  const app = req.app_;
  const { resolution, refund_amount, notes } = req.body || {};
  if (!['release', 'refund', 'partial', 'dismiss'].includes(resolution)) throw badRequest('Invalid resolution');
  if (!notes || String(notes).trim().length < 10) throw badRequest('Add resolution notes for the record');
  const dispute = await db.mustGet(app, 'Disputes', req.params.id, 'Dispute');
  if (!['open', 'under_review'].includes(dispute.status)) throw conflict('Dispute already resolved');
  const deal = await db.one(app, 'Deals', `ROWID = ${db.id(dispute.deal_id)}`);
  const payment = await db.one(app, 'Payments', `deal_id = ${deal.ROWID} AND payment_type = 'deal_funding' AND status = 'held'`);
  if (resolution !== 'dismiss' && !payment) throw conflict('No held payment found for this deal');

  // Close the dispute first so releaseDeal() is not blocked by it
  const closeDispute = (extra = {}) => db.update(app, 'Disputes', {
    ROWID: dispute.ROWID, status: 'resolved', resolution, resolution_notes: String(notes).slice(0, 5000),
    payout_frozen: false, resolved_by: req.profile.ROWID, resolved_at: db.now(), ...extra,
  });

  let updatedDeal = deal;
  if (resolution === 'dismiss') {
    const prev = (safeJson(dispute.evidence_json) || {}).prev_status;
    const back = prev === STATUS.PUBLISHED ? STATUS.PUBLISHED : STATUS.IN_PROGRESS;
    await closeDispute();
    updatedDeal = await transition(app, deal, back, { actor: req.profile, details: { dispute: dispute.ROWID, resolution }, ip: req.ip });
  }
  if (resolution === 'release') {
    await closeDispute();
    updatedDeal = await releaseDeal(app, deal, req.profile);
  }
  if (resolution === 'refund' || resolution === 'partial') {
    const creatorShare = Number(payment.net_amount);
    const refund = resolution === 'refund' ? creatorShare : db.num(refund_amount, 'refund amount');
    if (!(refund > 0 && refund <= creatorShare)) throw badRequest(`Refund must be between 1 and ${creatorShare}`);
    // Pull the refunded portion back from the creator's held transfer, then refund the business
    await rzp.reverseTransfer(payment.gateway_transfer_id, refund);
    await rzp.refundPayment(payment.gateway_payment_id, refund);
    await closeDispute({ refund_amount: refund });
    if (resolution === 'refund') {
      await db.update(app, 'Payments', { ROWID: payment.ROWID, status: 'refunded', net_amount: 0 });
      updatedDeal = await transition(app, deal, STATUS.CANCELLED, { actor: req.profile, extra: { payment_status: 'refunded' }, details: { dispute: dispute.ROWID, refund }, ip: req.ip });
    } else {
      await rzp.releaseTransfer(payment.gateway_transfer_id);
      await db.update(app, 'Payments', { ROWID: payment.ROWID, status: 'partially_refunded', net_amount: creatorShare - refund, released_at: db.now() });
      updatedDeal = await transition(app, deal, STATUS.COMPLETED, { actor: req.profile, extra: { payment_status: 'partially_refunded' }, details: { dispute: dispute.ROWID, refund }, ip: req.ip });
    }
  }

  await audit(app, { actor: req.profile, entityType: 'dispute', entityId: dispute.ROWID, action: `resolved_${resolution}`, details: { refund_amount, notes }, ip: req.ip });
  const p = await participants(app, deal);
  const msg = { type: 'dispute_resolved', dealId: deal.ROWID, link: `/deals/${deal.ROWID}`, title: `Dispute resolved — ${deal.deal_number}`, body: String(notes).slice(0, 300) };
  await Promise.all([notify(app, p.businessUserId, msg), notify(app, p.creatorUserId, msg)]);
  res.json({ ok: true, deal: updatedDeal });
}));

/* Categories management */
router.post('/categories', wrap(async (req, res) => {
  const row = db.pick(req.body, ['name', 'slug', 'category_group', 'sort_order', 'is_active']);
  if (!row.name || !row.slug || !row.category_group) throw badRequest('name, slug and category_group are required');
  res.status(201).json(await db.insert(req.app_, 'Categories', row));
}));
router.put('/categories/:id', wrap(async (req, res) => {
  const c = await db.mustGet(req.app_, 'Categories', req.params.id, 'Category');
  const row = db.pick(req.body, ['name', 'slug', 'sort_order', 'is_active']);
  await db.update(req.app_, 'Categories', { ROWID: c.ROWID, ...row });
  res.json({ ...c, ...row });
}));

const safeJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

module.exports = router;
