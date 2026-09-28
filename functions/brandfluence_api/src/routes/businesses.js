'use strict';
const router = require('express').Router();
const db = require('../lib/db');
const { wrap, badRequest, notFound } = require('../lib/errors');
const { requireRole } = require('../lib/auth');
const { ACTIVE } = require('../services/dealMachine');

const bizOnly = requireRole('business');
const mine = (req) => req.business.ROWID;

const BIZ_FIELDS = ['company_name', 'logo_url', 'category', 'website', 'contact_email', 'contact_phone', 'address',
  'city', 'state', 'country', 'gstin', 'about'];
const CAMPAIGN_FIELDS = ['name', 'promotion_type', 'goal', 'product_name', 'brief', 'platforms', 'content_types',
  'category', 'budget_min', 'budget_max', 'start_date', 'end_date'];

/* ---------- Business profile ---------- */
router.get('/me', bizOnly, wrap(async (req, res) => res.json(req.business)));

router.put('/me', bizOnly, wrap(async (req, res) => {
  const row = db.pick(req.body, BIZ_FIELDS);
  if (row.gstin && !/^[0-9A-Z]{15}$/.test(String(row.gstin).toUpperCase())) throw badRequest('GSTIN must be 15 characters');
  if (row.gstin) row.gstin = String(row.gstin).toUpperCase();
  await db.update(req.app_, 'BusinessProfiles', { ROWID: mine(req), ...row });
  res.json({ ...req.business, ...row });
}));

/* Submit verification documents (keys from /uploads into the docs bucket) */
router.post('/me/verification', bizOnly, wrap(async (req, res) => {
  const docs = (req.body || {}).document_keys;
  if (!Array.isArray(docs) || !docs.length) throw badRequest('Upload at least one document');
  const prefix = `kyc/${req.profile.ROWID}/`;
  if (docs.some((k) => !String(k).startsWith(prefix))) throw badRequest('Invalid document reference');
  await db.update(req.app_, 'BusinessProfiles', { ROWID: mine(req), verification_docs: JSON.stringify(docs), verification_status: 'submitted' });
  res.json({ ok: true, verification_status: 'submitted' });
}));

/* Business dashboard (section 10) */
router.get('/me/dashboard', bizOnly, wrap(async (req, res) => {
  const app = req.app_;
  const bid = mine(req);
  const [activeCampaigns, activeDeals, spent, held, published, creatorsDeals] = await Promise.all([
    db.count(app, 'Campaigns', `business_id = ${bid} AND status = 'active'`),
    db.count(app, 'Deals', `business_id = ${bid} AND status IN ${db.list(ACTIVE)}`),
    db.sum(app, 'Payments', 'gross_amount', `business_id = ${bid} AND status = 'released'`),
    db.sum(app, 'Payments', 'gross_amount', `business_id = ${bid} AND status = 'held'`),
    db.count(app, 'Deals', `business_id = ${bid} AND status IN ('published','completed')`),
    db.select(app, 'Deals', `business_id = ${bid} AND status IN ${db.list(ACTIVE)}`, 'LIMIT 0, 300'),
  ]);
  res.json({
    company: req.business.company_name,
    active_campaigns: activeCampaigns,
    active_deals: activeDeals,
    creators_working: new Set(creatorsDeals.map((d) => String(d.creator_id))).size,
    total_spent: spent,
    funds_held: held,
    content_published: published,
  });
}));

/* ---------- Campaigns (section 17 & 40) ---------- */
router.get('/me/campaigns', bizOnly, wrap(async (req, res) => {
  const where = [`business_id = ${mine(req)}`];
  if (req.query.status) where.push(`status = ${db.str(req.query.status)}`);
  const { tail } = db.paging(req);
  res.json({ data: await db.select(req.app_, 'Campaigns', where.join(' AND '), `ORDER BY CREATEDTIME DESC ${tail}`) });
}));

router.post('/me/campaigns', bizOnly, wrap(async (req, res) => {
  const row = normCampaign(req.body);
  if (!row.name) throw badRequest('Campaign name is required');
  const created = await db.insert(req.app_, 'Campaigns', { business_id: mine(req), status: 'draft', ...row });
  res.status(201).json(created);
}));

router.get('/me/campaigns/:id', bizOnly, wrap(async (req, res) => {
  const app = req.app_;
  const c = await ownCampaign(req);
  const deals = await db.select(app, 'Deals', `campaign_id = ${c.ROWID}`, 'ORDER BY CREATEDTIME DESC');
  const dealIds = deals.map((d) => d.ROWID);
  const deliverables = dealIds.length ? await db.select(app, 'Deliverables', `deal_id IN ${db.list(dealIds, db.id)}`) : [];
  const creatorIds = [...new Set(deals.map((d) => String(d.creator_id)))];
  const creators = creatorIds.length
    ? await db.select(app, 'CreatorProfiles', `ROWID IN ${db.list(creatorIds, db.id)}`) : [];

  // Aggregate published metrics (section 26)
  const totals = { views: 0, likes: 0, comments: 0, shares: 0, saves: 0, reach: 0, impressions: 0 };
  deliverables.forEach((d) => {
    try { const m = JSON.parse(d.metrics_json || '{}'); Object.keys(totals).forEach((k) => { totals[k] += Number(m[k]) || 0; }); } catch { /* ignore */ }
  });
  const committed = deals.filter((d) => !['rejected', 'cancelled'].includes(d.status))
    .reduce((a, d) => a + (Number(d.agreed_amount) || 0), 0);
  res.json({
    campaign: { ...c, committed_amount: committed },
    deals: deals.map((d) => ({ ...d, creator: pickCreator(creators.find((x) => String(x.ROWID) === String(d.creator_id))) })),
    stats: {
      creators: creatorIds.length,
      deliverables_total: deliverables.length,
      deliverables_published: deliverables.filter((d) => d.status === 'published').length,
      committed,
      ...totals,
      engagement_rate: totals.views ? Math.round(((totals.likes + totals.comments + totals.shares + totals.saves) / totals.views) * 10000) / 100 : null,
      cost_per_1k_reach: totals.reach ? Math.round((committed / totals.reach) * 1000) : null,
    },
  });
}));

router.put('/me/campaigns/:id', bizOnly, wrap(async (req, res) => {
  const c = await ownCampaign(req);
  const row = normCampaign(req.body);
  if (req.body.status) {
    if (!['draft', 'active', 'paused', 'completed', 'archived'].includes(req.body.status)) throw badRequest('Invalid status');
    row.status = req.body.status;
  }
  await db.update(req.app_, 'Campaigns', { ROWID: c.ROWID, ...row });
  res.json({ ...c, ...row });
}));

/* Public business card shown to creators receiving an offer */
router.get('/:id', wrap(async (req, res) => {
  const b = await db.one(req.app_, 'BusinessProfiles', `ROWID = ${db.id(req.params.id)}`);
  if (!b) throw notFound('Business not found');
  const reviews = await db.select(req.app_, 'Reviews', `reviewee_id = ${b.ROWID} AND reviewer_role = 'creator' AND is_public = true`, 'ORDER BY CREATEDTIME DESC LIMIT 0, 20');
  const { gstin, verification_docs, contact_phone, address, ...pub } = b;
  res.json({ business: pub, reviews });
}));

function normCampaign(body) {
  const row = db.pick(body, CAMPAIGN_FIELDS);
  ['platforms', 'content_types'].forEach((k) => { if (Array.isArray(row[k])) row[k] = row[k].join(','); });
  if (body && body.target_audience !== undefined) row.target_audience_json = JSON.stringify(body.target_audience);
  ['budget_min', 'budget_max'].forEach((k) => { if (row[k] !== undefined) row[k] = db.num(row[k], k); });
  if (row.budget_min && row.budget_max && row.budget_min > row.budget_max) throw badRequest('Minimum budget is higher than maximum');
  return row;
}
async function ownCampaign(req) {
  const c = await db.one(req.app_, 'Campaigns', `ROWID = ${db.id(req.params.id)} AND business_id = ${mine(req)}`);
  if (!c) throw notFound('Campaign not found');
  return c;
}
function pickCreator(c) {
  return c ? { id: c.ROWID, full_name: c.full_name, username: c.username, photo_url: c.photo_url, total_followers: c.total_followers } : null;
}

module.exports = router;
