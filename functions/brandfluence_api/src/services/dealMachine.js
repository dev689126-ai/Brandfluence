'use strict';
/**
 * The Deal is the central object of Brandfluence.
 * Every status change goes through transition() so rules and audit are enforced in one place.
 */
const db = require('../lib/db');
const { badRequest, forbidden } = require('../lib/errors');
const { audit } = require('./audit');

const STATUS = {
  OFFER_SENT: 'offer_sent',
  NEGOTIATION: 'negotiation',
  ACCEPTED: 'accepted',
  CONTRACT_SIGNED: 'contract_signed',
  PAYMENT_SECURED: 'payment_secured',
  IN_PROGRESS: 'in_progress',
  CONTENT_SUBMITTED: 'content_submitted',
  REVISION_REQUESTED: 'revision_requested',
  APPROVED: 'approved',
  PUBLISHED: 'published',
  COMPLETED: 'completed',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  DISPUTED: 'disputed',
};

// from -> allowed next statuses
const FLOW = {
  offer_sent: ['negotiation', 'accepted', 'rejected', 'cancelled'],
  negotiation: ['negotiation', 'accepted', 'rejected', 'cancelled'],
  accepted: ['contract_signed', 'cancelled'],
  contract_signed: ['payment_secured', 'cancelled'],
  payment_secured: ['in_progress', 'content_submitted', 'disputed'],
  in_progress: ['content_submitted', 'disputed'],
  content_submitted: ['content_submitted', 'revision_requested', 'approved', 'disputed'],
  revision_requested: ['content_submitted', 'disputed'],
  approved: ['content_submitted', 'published', 'disputed'],
  published: ['completed', 'disputed'],
  disputed: ['in_progress', 'published', 'completed', 'cancelled'],
  completed: [],
  rejected: [],
  cancelled: [],
};

const ACTIVE = ['offer_sent', 'negotiation', 'accepted', 'contract_signed', 'payment_secured', 'in_progress',
  'content_submitted', 'revision_requested', 'approved', 'published', 'disputed'];

async function transition(app, deal, to, { actor, details, extra = {}, ip } = {}) {
  const from = deal.status;
  if (from !== to && !(FLOW[from] || []).includes(to)) {
    throw badRequest(`This deal cannot move from "${from}" to "${to}"`);
  }
  const row = { ROWID: deal.ROWID, status: to, ...extra };
  if (to === STATUS.COMPLETED) row.completed_at = db.now();
  await db.update(app, 'Deals', row);
  await audit(app, { actor, entityType: 'deal', entityId: deal.ROWID, action: 'status_change', from, to, details, ip });
  return { ...deal, ...row };
}

/** Load a deal and check the caller is a participant (or admin). Returns { deal, side }. */
async function loadDealFor(req, dealId) {
  const deal = await db.mustGet(req.app_, 'Deals', dealId, 'Deal');
  const role = req.profile && req.profile.role;
  let side = null;
  if (role === 'admin') side = 'admin';
  else if (role === 'business' && req.business && String(deal.business_id) === String(req.business.ROWID)) side = 'business';
  else if (role === 'creator' && req.creator && String(deal.creator_id) === String(req.creator.ROWID)) side = 'creator';
  if (!side) throw forbidden('You are not part of this deal');
  return { deal, side };
}

/** UserProfiles.ROWID for each side of a deal (for notifications / messages). */
async function participants(app, deal) {
  const [b, c] = await Promise.all([
    db.one(app, 'BusinessProfiles', `ROWID = ${db.id(deal.business_id)}`),
    db.one(app, 'CreatorProfiles', `ROWID = ${db.id(deal.creator_id)}`),
  ]);
  return { business: b, creator: c, businessUserId: b && b.user_profile_id, creatorUserId: c && c.user_profile_id };
}

function computeFees(amount) {
  const a = Math.round(Number(amount) * 100) / 100;
  const bPct = Number(process.env.BUSINESS_FEE_PERCENT || 10);
  const cPct = Number(process.env.CREATOR_FEE_PERCENT || 0);
  const gstPct = Number(process.env.GST_ON_FEE_PERCENT || 18);
  const businessFee = round2((a * bPct) / 100);
  const creatorFee = round2((a * cPct) / 100);
  const platformFee = round2(businessFee + creatorFee);
  const tax = round2((platformFee * gstPct) / 100);
  return {
    agreed: a,
    businessFee,
    creatorFee,
    platformFee,
    tax,
    businessPays: round2(a + businessFee + (businessFee ? (businessFee * gstPct) / 100 : 0)),
    creatorPayout: round2(a - creatorFee - (creatorFee ? (creatorFee * gstPct) / 100 : 0)),
  };
}
const round2 = (n) => Math.round(n * 100) / 100;

function newDealNumber() {
  return 'DL-' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
}

module.exports = { STATUS, FLOW, ACTIVE, transition, loadDealFor, participants, computeFees, newDealNumber };
