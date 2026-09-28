'use strict';
/** Raising disputes (section 30). Resolution is in admin.js. */
const router = require('express').Router();
const db = require('../lib/db');
const { wrap, badRequest, conflict } = require('../lib/errors');
const { requireRole } = require('../lib/auth');
const { STATUS, transition, loadDealFor, participants } = require('../services/dealMachine');
const { notify } = require('../services/notify');

const TYPES = ['late_delivery', 'not_delivered', 'quality', 'brief_not_followed', 'payment', 'other'];
const DISPUTABLE = [STATUS.PAYMENT_SECURED, STATUS.IN_PROGRESS, STATUS.CONTENT_SUBMITTED, STATUS.REVISION_REQUESTED, STATUS.APPROVED, STATUS.PUBLISHED];

router.post('/deals/:id/disputes', requireRole('business', 'creator'), wrap(async (req, res) => {
  const app = req.app_;
  const { deal, side } = await loadDealFor(req, req.params.id);
  if (!DISPUTABLE.includes(deal.status)) throw conflict('Disputes can be raised while payment is held');
  const { issue_type, description, evidence_keys } = req.body || {};
  if (!TYPES.includes(issue_type)) throw badRequest('Choose the type of issue');
  if (!description || String(description).trim().length < 20) throw badRequest('Describe the issue (at least 20 characters)');
  const keys = Array.isArray(evidence_keys) ? evidence_keys.filter((k) => String(k).startsWith(`deals/${deal.ROWID}/`)) : [];

  const dispute = await db.insert(app, 'Disputes', {
    deal_id: deal.ROWID, raised_by_role: side, raised_by_id: req.profile.ROWID, issue_type,
    description: String(description).slice(0, 5000), amount_in_dispute: deal.agreed_amount,
    evidence_json: JSON.stringify({ prev_status: deal.status, files: keys }),
    status: 'open', payout_frozen: true,
  });
  await transition(app, deal, STATUS.DISPUTED, { actor: req.profile, details: { dispute: dispute.ROWID, issue_type }, ip: req.ip });

  const p = await participants(app, deal);
  await notify(app, side === 'business' ? p.creatorUserId : p.businessUserId, {
    type: 'dispute_opened', dealId: deal.ROWID, link: `/deals/${deal.ROWID}`,
    title: `A dispute was raised on ${deal.deal_number}`,
    body: 'Payment is on hold while our team reviews it. You can add your side in the deal chat.',
  });
  const admins = await db.select(app, 'UserProfiles', `role = 'admin' AND status = 'active'`, 'LIMIT 0, 20');
  await Promise.all(admins.map((a) => notify(app, a.ROWID, {
    type: 'admin_dispute', dealId: deal.ROWID, link: `/admin/disputes/${dispute.ROWID}`,
    title: `New dispute #${dispute.ROWID} (${issue_type})`, body: `Deal ${deal.deal_number}, ₹${deal.agreed_amount}`,
  })));
  res.status(201).json(dispute);
}));

module.exports = router;
