'use strict';
/**
 * Post performance tracking + Instagram login.
 *   (public)  GET  /oauth/instagram/callback        Instagram sends the creator back here
 *   (creator) GET  /social/instagram/connect        → { url } to start Instagram login
 *   (creator) POST /social/instagram/disconnect
 *   (both)    POST /deliverables/:id/metrics/refresh  check a live post now
 *   (both)    GET  /deals/:id/performance            totals + per-post numbers + history
 */
const express = require('express');
const catalyst = require('zcatalyst-sdk-node');
const db = require('../lib/db');
const { wrap, conflict, notFound } = require('../lib/errors');
const { requireRole, requireProfile } = require('../lib/auth');
const { loadDealFor } = require('../services/dealMachine');
const { recomputeCreator, syncAccount } = require('../services/social');
const t = require('../services/postTracking');
const { audit } = require('../services/audit');

/* ---------- Public: OAuth callback (identified by the signed state, not the session) ---------- */
const oauth = express.Router();
oauth.get('/instagram/callback', async (req, res) => {
  const back = (q) => res.redirect(`${t.origin()}/app/index.html#/profile/social?${q}`);
  const creatorId = t.readState(req.query.state);
  if (!creatorId) return back('ig=expired');
  if (req.query.error || !req.query.code) return back('ig=cancelled');
  try {
    const app = catalyst.initialize(req, { scope: 'admin' });
    const { token, expiresIn, me } = await t.exchangeInstagramCode(String(req.query.code));
    if (me.account_type && !['BUSINESS', 'MEDIA_CREATOR', 'CREATOR'].includes(String(me.account_type).toUpperCase())) return back('ig=personal');
    const handle = String(me.username || '').toLowerCase();
    const existing = (await db.select(app, 'SocialAccounts', `creator_id = ${db.id(creatorId)} AND platform = 'instagram' AND is_connected = true`))
      .find((a) => String(a.handle).toLowerCase() === handle || String(a.platform_account_id) === String(me.user_id || me.id));
    const row = {
      platform_account_id: String(me.user_id || me.id), handle, profile_url: `https://www.instagram.com/${handle}/`,
      access_token: token, token_expires_at: db.now(expiresIn * 1000), connection_type: 'oauth', is_connected: true,
      followers: Number(me.followers_count) || 0,
    };
    const acc = existing
      ? { ...existing, ...row, ...(await db.update(app, 'SocialAccounts', { ROWID: existing.ROWID, ...row })) }
      : await db.insert(app, 'SocialAccounts', { creator_id: creatorId, platform: 'instagram', ...row });
    await syncAccount(app, { ...acc, ...row });
    await recomputeCreator(app, creatorId);
    await audit(app, { entityType: 'creator', entityId: creatorId, action: 'instagram_connected', details: { handle } });
    return back('ig=connected');
  } catch (e) {
    console.error('instagram callback failed', e.message);
    return back('ig=error');
  }
});

/* ---------- Signed-in routes ---------- */
const router = express.Router();

router.get('/social/instagram/connect', requireRole('creator'), wrap(async (req, res) => {
  if (!t.igConfigured()) throw conflict('Instagram connection is not set up yet. Ask the Brandfluence team to add the Instagram app keys.');
  res.json({ url: t.instagramAuthUrl(req.creator.ROWID) });
}));

router.post('/social/instagram/disconnect', requireRole('creator'), wrap(async (req, res) => {
  const accs = await db.select(req.app_, 'SocialAccounts', `creator_id = ${req.creator.ROWID} AND platform = 'instagram' AND connection_type = 'oauth'`);
  for (const a of accs) await db.update(req.app_, 'SocialAccounts', { ROWID: a.ROWID, access_token: '', connection_type: 'api' });
  res.json({ ok: true });
}));

router.post('/deliverables/:id/metrics/refresh', requireProfile, wrap(async (req, res) => {
  const d = await db.one(req.app_, 'Deliverables', `ROWID = ${db.id(req.params.id)}`);
  if (!d) throw notFound('Deliverable not found');
  const { deal } = await loadDealFor(req, d.deal_id);
  if (d.status !== 'published' || !d.published_url) throw conflict('Numbers are available once the post is live');
  const r = await t.trackDeliverable(req.app_, d, { creatorId: deal.creator_id });
  res.json(r);
}));

router.get('/deals/:id/performance', requireProfile, wrap(async (req, res) => {
  const app = req.app_;
  const { deal } = await loadDealFor(req, req.params.id);
  const [dels, history, igAcc] = await Promise.all([
    db.select(app, 'Deliverables', `deal_id = ${deal.ROWID}`, 'ORDER BY sequence_no ASC'),
    db.select(app, 'PostMetrics', `deal_id = ${deal.ROWID}`, 'ORDER BY CREATEDTIME ASC LIMIT 0, 300'),
    db.one(app, 'SocialAccounts', `creator_id = ${db.id(deal.creator_id)} AND platform = 'instagram' AND connection_type = 'oauth' AND is_connected = true`),
  ]);
  const posts = dels.filter((d) => d.status === 'published').map((d) => ({
    ROWID: d.ROWID, platform: d.platform, content_type: d.content_type, sequence_no: d.sequence_no,
    published_url: d.published_url, published_at: d.published_at, metrics: t.safeJson(d.metrics_json) || {},
    history: history.filter((h) => String(h.deliverable_id) === String(d.ROWID))
      .map((h) => ({ at: h.CREATEDTIME, views: h.views, reach: h.reach, likes: h.likes, interactions: h.interactions })),
  }));
  const sum = (k) => posts.reduce((a, p) => a + (Number(p.metrics[k]) || 0), 0);
  const totals = { views: sum('views'), reach: sum('reach'), likes: sum('likes'), comments: sum('comments'), shares: sum('shares'), saves: sum('saves'), interactions: sum('interactions') };
  totals.engagement_rate = totals.reach ? Math.round((totals.interactions / totals.reach) * 10000) / 100 : null;
  const spend = Number(deal.agreed_amount) || 0;
  totals.cost_per_view = totals.views ? Math.round((spend / totals.views) * 100) / 100 : null;
  totals.cost_per_engagement = totals.interactions ? Math.round((spend / totals.interactions) * 100) / 100 : null;
  res.json({ posts, totals, instagram_insights_connected: Boolean(igAcc), live: posts.length, total: dels.length });
}));

module.exports = router;
module.exports.oauth = oauth;
