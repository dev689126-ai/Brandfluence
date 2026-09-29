'use strict';
const router = require('express').Router();
const db = require('../lib/db');
const { wrap, badRequest, notFound, conflict } = require('../lib/errors');
const { requireRole } = require('../lib/auth');
const { syncAccount, recomputeCreator, normalizeHandle } = require('../services/social');
const { joinList, hideSecrets } = require('./me');
const { ACTIVE } = require('../services/dealMachine');
const plans = require('../services/plans');

const PLATFORMS = ['instagram', 'youtube', 'facebook', 'x', 'linkedin', 'twitch', 'other'];
const creatorOnly = requireRole('creator');
const mine = (req) => req.creator.ROWID;

/* ---------- Own profile ---------- */
router.get('/me', creatorOnly, wrap(async (req, res) => res.json(await fullProfile(req.app_, mine(req), true))));

router.put('/me', creatorOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const row = db.pick(b, ['full_name', 'photo_url', 'bio', 'gender', 'age_range', 'city', 'state', 'country', 'is_available']);
  ['languages', 'categories', 'creator_types'].forEach((k) => { if (b[k] !== undefined) row[k] = joinList(b[k]); });
  if (b.username) {
    const u = String(b.username).toLowerCase().replace(/[^a-z0-9._]/g, '');
    const taken = await db.one(req.app_, 'CreatorProfiles', `username = ${db.str(u)} AND ROWID != ${mine(req)}`);
    if (taken) throw conflict('That username is taken');
    row.username = u;
  }
  await db.update(req.app_, 'CreatorProfiles', { ROWID: mine(req), ...row });
  await recomputeCreator(req.app_, mine(req));
  res.json(await fullProfile(req.app_, mine(req), true));
}));

/* Creator dashboard (section 6) */
router.get('/me/dashboard', creatorOnly, wrap(async (req, res) => {
  const app = req.app_;
  const cid = mine(req);
  const [profile, active, completed, earned, pending, accounts] = await Promise.all([
    db.one(app, 'CreatorProfiles', `ROWID = ${cid}`),
    db.count(app, 'Deals', `creator_id = ${cid} AND status IN ${db.list(ACTIVE)}`),
    db.count(app, 'Deals', `creator_id = ${cid} AND status = 'completed'`),
    db.sum(app, 'Payments', 'net_amount', `creator_id = ${cid} AND status = 'released'`),
    db.sum(app, 'Payments', 'net_amount', `creator_id = ${cid} AND status = 'held'`),
    db.select(app, 'SocialAccounts', `creator_id = ${cid} AND is_connected = true`),
  ]);
  res.json({
    name: profile.full_name,
    profile_strength: Number(profile.profile_strength) || 0,
    audience: Number(profile.total_followers) || 0,
    avg_engagement: profile.avg_engagement_rate,
    active_deals: active,
    completed_deals: completed,
    earnings: { released: earned, pending },
    social: accounts.map(publicAccount),
  });
}));

/* ---------- Social accounts ---------- */
router.post('/me/social', creatorOnly, wrap(async (req, res) => {
  const { platform, handle, followers, avg_views, engagement_rate, profile_url } = req.body || {};
  if (!PLATFORMS.includes(platform)) throw badRequest('Unsupported platform');
  if (!handle) throw badRequest('Handle is required');
  const clean = normalizeHandle(platform, handle).replace(/^@/, '').slice(0, 100);
  if (!clean) throw badRequest('Enter a handle or profile link');
  const dup = await db.one(req.app_, 'SocialAccounts',
    `creator_id = ${mine(req)} AND platform = ${db.str(platform)} AND handle = ${db.str(clean)} AND is_connected = true`);
  if (dup) throw conflict('This account is already added');
  const acc = await db.insert(req.app_, 'SocialAccounts', {
    creator_id: mine(req),
    platform,
    handle: clean,
    profile_url: /^https?:\/\//i.test(String(handle)) ? String(handle).slice(0, 255) : profile_url,
    connection_type: 'manual',
    followers: followers ? Math.max(0, parseInt(followers, 10)) : 0,
    avg_views: avg_views ? Math.max(0, parseInt(avg_views, 10)) : 0,
    engagement_rate: engagement_rate !== undefined ? Number(engagement_rate) : undefined,
  });
  // Try to verify immediately via official API (YouTube / Instagram)
  const verified = await syncAccount(req.app_, acc);
  await recomputeCreator(req.app_, mine(req));
  const fresh = await db.one(req.app_, 'SocialAccounts', `ROWID = ${acc.ROWID}`);
  res.status(201).json({ account: publicAccount(fresh), verified });
}));

router.post('/me/social/:id/sync', creatorOnly, wrap(async (req, res) => {
  const acc = await ownRow(req, 'SocialAccounts', req.params.id);
  const verified = await syncAccount(req.app_, acc);
  await recomputeCreator(req.app_, mine(req));
  res.json({ account: publicAccount(await db.one(req.app_, 'SocialAccounts', `ROWID = ${acc.ROWID}`)), verified });
}));

router.delete('/me/social/:id', creatorOnly, wrap(async (req, res) => {
  const acc = await ownRow(req, 'SocialAccounts', req.params.id);
  await db.update(req.app_, 'SocialAccounts', { ROWID: acc.ROWID, is_connected: false });
  await recomputeCreator(req.app_, mine(req));
  res.json({ ok: true });
}));

router.get('/me/social/:id/history', creatorOnly, wrap(async (req, res) => {
  const acc = await ownRow(req, 'SocialAccounts', req.params.id);
  const rows = await db.select(req.app_, 'SocialMetrics', `social_account_id = ${acc.ROWID}`, 'ORDER BY snapshot_date DESC LIMIT 0, 90');
  res.json({ data: rows });
}));

/* ---------- Rate card ---------- */
crud('rates', 'RateCards', ['platform', 'service_type', 'rate_kind', 'price', 'currency', 'description', 'is_active'], (r) => {
  if (r.price !== undefined && !(Number(r.price) >= 0)) throw badRequest('Price must be a positive number');
  if (r.platform !== undefined && !PLATFORMS.includes(r.platform) && r.platform !== 'any') throw badRequest('Unsupported platform');
});

/* ---------- Portfolio ---------- */
crud('portfolio', 'PortfolioItems', ['title', 'brand_name', 'item_type', 'platform', 'media_url', 'thumbnail_url',
  'views', 'likes', 'engagement_rate', 'description', 'sort_order']);

/* ---------- Availability ---------- */
crud('availability', 'Availability', ['start_date', 'end_date', 'status', 'note'], (r) => {
  if (r.status !== undefined && !['available', 'booked', 'unavailable'].includes(r.status)) throw badRequest('Invalid status');
  if (r.start_date && r.end_date && r.start_date > r.end_date) throw badRequest('Start date must be before end date');
});

/* ---------- Payout account (Razorpay Route linked account) ---------- */
router.put('/me/payout-account', creatorOnly, wrap(async (req, res) => {
  const acc = String((req.body || {}).razorpay_account_id || '');
  if (!/^acc_[A-Za-z0-9]{8,20}$/.test(acc)) throw badRequest('Enter a valid Razorpay linked account ID (acc_...)');
  await db.update(req.app_, 'CreatorProfiles', { ROWID: mine(req), razorpay_account_id: acc, kyc_status: 'submitted' });
  res.json({ ok: true });
}));

/* ---------- Who viewed my profile (count for everyone, the brands themselves for Pro) ---------- */
router.get('/me/views', creatorOnly, wrap(async (req, res) => {
  const app = req.app_;
  const since = new Date(Date.now() - 30 * 86400000 + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const rows = await db.select(app, 'ProfileViews', `creator_id = ${mine(req)} AND viewed_on >= ${db.str(since)}`, 'ORDER BY viewed_on DESC LIMIT 0, 300');
  const brands = [...new Set(rows.map((r) => String(r.business_id)))];
  const pro = plans.isPro(req.creator);
  let list = [];
  if (pro && brands.length) {
    const biz = await db.select(app, 'BusinessProfiles', `ROWID IN ${db.list(brands.slice(0, 100), db.id)}`);
    list = brands.slice(0, 100).map((id) => {
      const b = biz.find((x) => String(x.ROWID) === id);
      const last = rows.find((r) => String(r.business_id) === id);
      return b ? { ROWID: b.ROWID, company_name: b.company_name, logo_url: b.logo_url, city: b.city, category: b.category, last_viewed: last && last.viewed_on } : null;
    }).filter(Boolean);
  }
  res.json({ days: 30, views: rows.length, brands: brands.length, locked: !pro, data: list });
}));

/* ---------- Public creator profile (seen by businesses) ---------- */
router.get('/:id', wrap(async (req, res) => {
  const p = await fullProfile(req.app_, db.id(req.params.id), false);
  if (req.business) {
    // Remember that this brand looked (once per brand per day); never block the page on it
    try {
      const day = db.today();
      const seen = await db.one(req.app_, 'ProfileViews', `creator_id = ${p.creator.ROWID} AND business_id = ${req.business.ROWID} AND viewed_on = ${db.str(day)}`);
      if (!seen) await db.insert(req.app_, 'ProfileViews', { creator_id: p.creator.ROWID, business_id: req.business.ROWID, viewed_on: day });
      const chat = await db.one(req.app_, 'Conversations', `creator_id = ${p.creator.ROWID} AND business_id = ${req.business.ROWID} AND status = 'open'`);
      p.open_chat_id = chat ? chat.ROWID : null;
    } catch (e) { console.error('profile view log failed', e.message); }
  }
  res.json(p);
}));

/* ---------- helpers ---------- */
function crud(path, table, fields, validate = () => {}) {
  router.get(`/me/${path}`, creatorOnly, wrap(async (req, res) => {
    res.json({ data: await db.select(req.app_, table, `creator_id = ${mine(req)}`, 'ORDER BY CREATEDTIME DESC') });
  }));
  router.post(`/me/${path}`, creatorOnly, wrap(async (req, res) => {
    const row = db.pick(req.body, fields);
    validate(row);
    const created = await db.insert(req.app_, table, { creator_id: mine(req), ...row });
    await recomputeCreator(req.app_, mine(req));
    res.status(201).json(created);
  }));
  router.put(`/me/${path}/:id`, creatorOnly, wrap(async (req, res) => {
    const existing = await ownRow(req, table, req.params.id);
    const row = db.pick(req.body, fields);
    validate(row);
    await db.update(req.app_, table, { ROWID: existing.ROWID, ...row });
    await recomputeCreator(req.app_, mine(req));
    res.json({ ...existing, ...row });
  }));
  router.delete(`/me/${path}/:id`, creatorOnly, wrap(async (req, res) => {
    const existing = await ownRow(req, table, req.params.id);
    await db.remove(req.app_, table, existing.ROWID);
    await recomputeCreator(req.app_, mine(req));
    res.json({ ok: true });
  }));
}

async function ownRow(req, table, rowId) {
  const row = await db.one(req.app_, table, `ROWID = ${db.id(rowId)} AND creator_id = ${mine(req)}`);
  if (!row) throw notFound();
  return row;
}

function publicAccount(a) {
  const { access_token, refresh_token, token_expires_at, ...rest } = a;
  return { ...rest, verified: a.connection_type === 'api' || (a.connection_type === 'oauth' && Boolean(a.last_synced_at)) };
}

async function fullProfile(app, creatorId, isOwner) {
  const c = await db.one(app, 'CreatorProfiles', `ROWID = ${db.id(creatorId)}`);
  if (!c) throw notFound('Creator not found');
  const [social, rates, portfolio, availability, reviews] = await Promise.all([
    db.select(app, 'SocialAccounts', `creator_id = ${c.ROWID} AND is_connected = true`),
    db.select(app, 'RateCards', `creator_id = ${c.ROWID}${isOwner ? '' : ' AND is_active = true'}`),
    db.select(app, 'PortfolioItems', `creator_id = ${c.ROWID}`, 'ORDER BY sort_order ASC'),
    db.select(app, 'Availability', `creator_id = ${c.ROWID} AND end_date >= ${db.str(db.today())}`, 'ORDER BY start_date ASC'),
    db.select(app, 'Reviews', `reviewee_id = ${c.ROWID} AND reviewer_role = 'business' AND is_public = true`, 'ORDER BY CREATEDTIME DESC LIMIT 0, 20'),
  ]);
  return { creator: { ...hideSecrets(c), is_pro: plans.isPro(c) }, social: social.map(publicAccount), rates, portfolio, availability, reviews };
}

module.exports = router;
module.exports.publicAccount = publicAccount;
