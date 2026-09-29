'use strict';
/**
 * Creator discovery (sections 11–12).
 * GET /discover/creators?q=&category=&city=&state=&language=&platform=&min_followers=&max_followers=
 *        &min_engagement=&max_price=&verified=1&available=1&sort=followers|engagement|price|rating&page=&size=
 */
const router = require('express').Router();
const crypto = require('crypto');
const db = require('../lib/db');
const { wrap } = require('../lib/errors');
const { requireRole } = require('../lib/auth');
const { publicAccount } = require('./creators');
const plans = require('../services/plans');

const SORTS = {
  followers: 'total_followers DESC',
  engagement: 'avg_engagement_rate DESC',
  price: 'min_rate ASC',
  rating: 'avg_rating DESC',
  strength: 'profile_strength DESC',
};

router.get('/creators', requireRole('business', 'admin'), wrap(async (req, res) => {
  const app = req.app_;
  const q = req.query;
  const { page, size, tail } = db.paging(req, 50);

  const cacheKey = 'disc_' + crypto.createHash('md5').update(JSON.stringify(q)).digest('hex');
  const cached = await cacheGet(app, cacheKey);
  if (cached) return res.json(cached);

  const where = [];
  if (q.q) {
    const s = db.esc(q.q);
    where.push(`(full_name LIKE '*${s}*' OR username LIKE '*${s}*' OR bio LIKE '*${s}*')`);
  }
  if (q.category) where.push(`categories LIKE '*${db.esc(q.category)}*'`);
  if (q.creator_type) where.push(`creator_types LIKE '*${db.esc(q.creator_type)}*'`);
  if (q.language) where.push(`languages LIKE '*${db.esc(q.language)}*'`);
  if (q.city) where.push(`city = ${db.str(q.city)}`);
  if (q.state) where.push(`state = ${db.str(q.state)}`);
  if (q.country) where.push(`country = ${db.str(q.country)}`);
  if (q.gender) where.push(`gender = ${db.str(q.gender)}`);
  if (q.min_followers) where.push(`total_followers >= ${db.num(q.min_followers)}`);
  if (q.max_followers) where.push(`total_followers <= ${db.num(q.max_followers)}`);
  if (q.min_engagement) where.push(`avg_engagement_rate >= ${db.num(q.min_engagement)}`);
  if (q.max_price) where.push(`min_rate <= ${db.num(q.max_price)}`);
  if (q.verified === '1') where.push('is_verified = true');
  if (q.available === '1') where.push('is_available = true');

  // Platform-specific filter: find creators with a matching account first
  if (q.platform) {
    const accWhere = [`platform = ${db.str(q.platform)}`, 'is_connected = true'];
    if (q.platform_min_followers) accWhere.push(`followers >= ${db.num(q.platform_min_followers)}`);
    if (q.min_avg_views) accWhere.push(`avg_views >= ${db.num(q.min_avg_views)}`);
    const accs = await db.select(app, 'SocialAccounts', accWhere.join(' AND '), 'LIMIT 0, 300');
    const ids = [...new Set(accs.map((a) => String(a.creator_id)))];
    if (!ids.length) return res.json({ data: [], page, size });
    where.push(`ROWID IN ${db.list(ids, (x) => db.id(x))}`);
  }

  const order = SORTS[q.sort] || SORTS.followers;
  const creators = await db.select(app, 'CreatorProfiles', where.join(' AND '), `ORDER BY ${order} ${tail}`);

  // Attach social summary + starting prices for the result cards
  const ids = creators.map((c) => c.ROWID);
  let accounts = [];
  let rates = [];
  if (ids.length) {
    [accounts, rates] = await Promise.all([
      db.select(app, 'SocialAccounts', `creator_id IN ${db.list(ids, db.id)} AND is_connected = true`),
      db.select(app, 'RateCards', `creator_id IN ${db.list(ids, db.id)} AND is_active = true AND rate_kind = 'content'`),
    ]);
  }
  const data = creators.map((c) => {
    const { razorpay_account_id, ...pub } = c;
    const acc = accounts.filter((a) => String(a.creator_id) === String(c.ROWID)).map(publicAccount);
    const r = rates.filter((x) => String(x.creator_id) === String(c.ROWID));
    const starting = {};
    r.forEach((x) => { const k = `${x.platform}:${x.service_type}`; starting[k] = Math.min(starting[k] ?? Infinity, Number(x.price)); });
    return { ...pub, is_pro: plans.isPro(c), social: acc, starting_prices: starting };
  });
  // Pro creators are shown first on each results page (stable: keeps the chosen sort within each group)
  data.sort((a, b) => Number(b.is_pro) - Number(a.is_pro));

  const payload = { data, page, size };
  await cachePut(app, cacheKey, payload);
  res.json(payload);
}));

async function cacheGet(app, key) {
  try {
    const seg = process.env.CACHE_SEGMENT_ID;
    if (!seg) return null;
    const v = await app.cache().segment(seg).getValue(key);
    return v ? JSON.parse(v) : null;
  } catch { return null; }
}
async function cachePut(app, key, value) {
  try {
    const seg = process.env.CACHE_SEGMENT_ID;
    if (!seg) return;
    const s = JSON.stringify(value);
    if (s.length < 60000) await app.cache().segment(seg).put(key, s, 1); // 1 hour
  } catch { /* cache is optional */ }
}

module.exports = router;
