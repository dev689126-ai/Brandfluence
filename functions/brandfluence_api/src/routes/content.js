'use strict';
/**
 * Content workflow: draft upload → review → revisions → approval → publish → metrics (sections 18, 19, 26).
 */
const router = require('express').Router();
const db = require('../lib/db');
const { wrap, badRequest, conflict, notFound } = require('../lib/errors');
const { requireRole, requireProfile } = require('../lib/auth');
const { STATUS, transition, loadDealFor, participants } = require('../services/dealMachine');
const { notify } = require('../services/notify');
const { audit } = require('../services/audit');

const WORKING = [STATUS.PAYMENT_SECURED, STATUS.IN_PROGRESS, STATUS.CONTENT_SUBMITTED, STATUS.REVISION_REQUESTED, STATUS.APPROVED];

async function loadDeliverable(req) {
  const d = await db.one(req.app_, 'Deliverables', `ROWID = ${db.id(req.params.id)}`);
  if (!d) throw notFound('Deliverable not found');
  const { deal, side } = await loadDealFor(req, d.deal_id);
  return { d, deal, side };
}

/* Creator marks product received (shipping deals) / starts work */
router.post('/deals/:id/start', requireRole('creator'), wrap(async (req, res) => {
  const { deal } = await loadDealFor(req, req.params.id);
  if (deal.status !== STATUS.PAYMENT_SECURED) throw conflict('Work can start once payment is secured');
  const updated = await transition(req.app_, deal, STATUS.IN_PROGRESS, { actor: req.profile, details: { product_received: req.body.product_received === true }, ip: req.ip });
  res.json({ deal: updated });
}));

/* Creator submits a draft for a deliverable */
router.post('/deliverables/:id/submissions', requireRole('creator'), wrap(async (req, res) => {
  const app = req.app_;
  const { d, deal } = await loadDeliverable(req);
  if (!WORKING.includes(deal.status)) throw conflict('Content cannot be submitted at this stage');
  if (!['pending', 'revision_requested'].includes(d.status)) throw conflict('This deliverable is not awaiting a draft');
  const { media_key, caption, hashtags, mentions } = req.body || {};
  if (!media_key && !caption) throw badRequest('Upload a file or add a caption');
  if (media_key && !String(media_key).startsWith(`deals/${deal.ROWID}/`)) throw badRequest('Invalid file reference');

  const revisionNo = Number(d.revision_count) || 0;
  const sub = await db.insert(app, 'ContentSubmissions', {
    deliverable_id: d.ROWID, deal_id: deal.ROWID, revision_no: revisionNo,
    media_key, caption, hashtags, mentions: mentions ? String(mentions).slice(0, 255) : undefined, status: 'submitted',
  });
  await db.update(app, 'Deliverables', { ROWID: d.ROWID, status: 'submitted' });
  await transition(app, deal, STATUS.CONTENT_SUBMITTED, { actor: req.profile, details: { deliverable: d.ROWID, revision: revisionNo }, ip: req.ip });
  const p = await participants(app, deal);
  await notify(app, p.businessUserId, {
    type: 'content_submitted', dealId: deal.ROWID, link: `/deals/${deal.ROWID}`,
    title: `New content submitted — ${deal.deal_number}`, body: `${p.creator.full_name} submitted ${d.platform} ${d.content_type} #${d.sequence_no} for review.`,
  });
  res.status(201).json(sub);
}));

/* Business approves a submission */
router.post('/submissions/:id/approve', requireRole('business'), wrap(async (req, res) => {
  const app = req.app_;
  const { sub, d, deal } = await loadSubmission(req);
  await db.update(app, 'ContentSubmissions', { ROWID: sub.ROWID, status: 'approved', business_feedback: req.body.feedback, reviewed_at: db.now() });
  await db.update(app, 'Deliverables', { ROWID: d.ROWID, status: 'approved' });
  await audit(app, { actor: req.profile, entityType: 'deal', entityId: deal.ROWID, action: 'content_approved', details: { deliverable: d.ROWID, submission: sub.ROWID }, ip: req.ip });

  const all = await db.select(app, 'Deliverables', `deal_id = ${deal.ROWID}`);
  let updated = deal;
  if (all.every((x) => ['approved', 'published'].includes(x.status))) {
    updated = await transition(app, deal, STATUS.APPROVED, { actor: req.profile, ip: req.ip });
  }
  const p = await participants(app, deal);
  await notify(app, p.creatorUserId, {
    type: 'content_approved', dealId: deal.ROWID, link: `/deals/${deal.ROWID}`,
    title: `Content approved — ${deal.deal_number}`, body: `Your ${d.platform} ${d.content_type} #${d.sequence_no} is approved. You can publish it now.`,
  });
  res.json({ deal: updated });
}));

/* Business requests changes (limited by revision_limit) */
router.post('/submissions/:id/request-changes', requireRole('business'), wrap(async (req, res) => {
  const app = req.app_;
  const { sub, d, deal } = await loadSubmission(req);
  const feedback = String((req.body || {}).feedback || '').trim();
  if (!feedback) throw badRequest('Tell the creator what to change');
  const used = Number(d.revision_count) || 0;
  const limit = Number(deal.revision_limit) || 0;
  if (used >= limit) throw conflict(`The agreed revision limit (${limit}) has been reached. Approve, or agree extra revisions with the creator.`);

  await db.update(app, 'ContentSubmissions', { ROWID: sub.ROWID, status: 'changes_requested', business_feedback: feedback, reviewed_at: db.now() });
  await db.update(app, 'Deliverables', { ROWID: d.ROWID, status: 'revision_requested', revision_count: used + 1 });
  const updated = await transition(app, deal, STATUS.REVISION_REQUESTED, { actor: req.profile, details: { deliverable: d.ROWID, revision: used + 1, feedback }, ip: req.ip });
  const p = await participants(app, deal);
  await notify(app, p.creatorUserId, {
    type: 'revision_requested', dealId: deal.ROWID, link: `/deals/${deal.ROWID}`,
    title: `Revision #${used + 1} requested — ${deal.deal_number}`, body: feedback.slice(0, 300),
  });
  res.json({ deal: updated, revisions_left: limit - used - 1 });
}));

/* Creator publishes approved content and shares the live link */
router.post('/deliverables/:id/publish', requireRole('creator'), wrap(async (req, res) => {
  const app = req.app_;
  const { d, deal } = await loadDeliverable(req);
  if (d.status !== 'approved') throw conflict('Only approved content can be marked as published');
  const url = String((req.body || {}).published_url || '');
  if (!/^https:\/\/[^\s]+$/.test(url)) throw badRequest('Paste the live https:// link to the post');
  await db.update(app, 'Deliverables', { ROWID: d.ROWID, status: 'published', published_url: url, published_at: db.now() });

  const all = await db.select(app, 'Deliverables', `deal_id = ${deal.ROWID}`);
  let updated = deal;
  if (all.every((x) => x.status === 'published' || String(x.ROWID) === String(d.ROWID))) {
    updated = await transition(app, deal, STATUS.PUBLISHED, { actor: req.profile, ip: req.ip });
    const p = await participants(app, deal);
    await notify(app, p.businessUserId, {
      type: 'content_published', dealId: deal.ROWID, link: `/deals/${deal.ROWID}`,
      title: `All content is live — ${deal.deal_number}`,
      body: `Please release payment or raise a dispute within ${process.env.AUTO_RELEASE_DAYS || 7} days; after that it is released automatically.`,
    });
  }
  res.json({ deal: updated });
}));

/* Record performance metrics for a published deliverable (creator self-report or admin; API sync later) */
router.put('/deliverables/:id/metrics', requireRole('creator', 'admin'), wrap(async (req, res) => {
  const { d } = await loadDeliverable(req);
  if (d.status !== 'published') throw conflict('Metrics can be added after publishing');
  const keys = ['views', 'reach', 'impressions', 'likes', 'comments', 'shares', 'saves', 'clicks'];
  const m = {};
  keys.forEach((k) => { if (req.body[k] !== undefined) m[k] = Math.max(0, parseInt(req.body[k], 10) || 0); });
  m.source = req.profile.role === 'admin' ? 'admin' : 'self_reported';
  m.updated_at = db.now();
  await db.update(req.app_, 'Deliverables', { ROWID: d.ROWID, metrics_json: JSON.stringify(m) });
  res.json({ metrics: m });
}));

async function loadSubmission(req) {
  const sub = await db.one(req.app_, 'ContentSubmissions', `ROWID = ${db.id(req.params.id)}`);
  if (!sub) throw notFound('Submission not found');
  const { deal } = await loadDealFor(req, sub.deal_id);
  if (sub.status !== 'submitted') throw conflict('This submission has already been reviewed');
  const d = await db.one(req.app_, 'Deliverables', `ROWID = ${db.id(sub.deliverable_id)}`);
  return { sub, d, deal };
}

module.exports = router;
