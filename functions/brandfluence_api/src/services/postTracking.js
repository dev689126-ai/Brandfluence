'use strict';
/**
 * Automatic performance tracking for published deal posts.
 *
 *  Instagram (reels, posts, stories)
 *    - Best: the creator connects Instagram once ("Instagram API with Instagram Login").
 *      We then read the post's real insights: reach, views, likes, comments, shares, saves.
 *      Stories only keep insights for 24 hours, so the hourly job captures them before they expire.
 *    - Fallback: public likes and comments through Business Discovery (no reach or views).
 *  YouTube (videos, shorts): public views, likes and comments via the Data API key.
 *  Anything else: the creator can still enter results by hand.
 */
const db = require('../lib/db');

const IG_GRAPH = () => `https://graph.instagram.com/${process.env.IG_GRAPH_VERSION || 'v23.0'}`;
const FB_GRAPH = 'https://graph.facebook.com/v23.0';

/* ---------- Link parsing ---------- */
function parsePostUrl(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'instagram.com') {
    if (parts[0] === 'stories' && parts[2]) return { platform: 'instagram', kind: 'story', id: parts[2], username: parts[1] };
    const i = parts.findIndex((p) => ['p', 'reel', 'reels', 'tv'].includes(p));
    if (i >= 0 && parts[i + 1]) return { platform: 'instagram', kind: parts[i] === 'p' ? 'post' : 'reel', shortcode: parts[i + 1] };
    return null;
  }
  if (host === 'youtu.be' && parts[0]) return { platform: 'youtube', kind: 'video', id: parts[0] };
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    if (u.searchParams.get('v')) return { platform: 'youtube', kind: 'video', id: u.searchParams.get('v') };
    if (['shorts', 'live', 'embed'].includes(parts[0]) && parts[1]) return { platform: 'youtube', kind: parts[0] === 'shorts' ? 'short' : 'video', id: parts[1] };
  }
  return null;
}

const n = (v) => (v === undefined || v === null || v === '' ? undefined : Math.max(0, Math.round(Number(v)) || 0));

async function getJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = (data.error && (data.error.message || data.error.error_user_msg)) || `HTTP ${res.status}`;
    const e = new Error(msg); e.code = data.error && data.error.code; throw e;
  }
  return data;
}

/* ---------- YouTube ---------- */
async function youtubeVideo(id) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return null;
  const d = await getJson(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(id)}&key=${key}`);
  const s = d.items && d.items[0] && d.items[0].statistics;
  if (!s) return null;
  return { source: 'youtube_api', media_id: id, views: n(s.viewCount), likes: n(s.likeCount), comments: n(s.commentCount) };
}

/* ---------- Instagram with the creator's own login (full insights) ---------- */
const METRIC_SETS = {
  REELS: ['reach', 'views', 'likes', 'comments', 'shares', 'saved', 'total_interactions'],
  FEED: ['reach', 'views', 'likes', 'comments', 'shares', 'saved', 'total_interactions'],
  STORY: ['reach', 'views', 'replies', 'shares', 'total_interactions'],
};
const FALLBACK_METRICS = ['reach', 'likes', 'comments', 'saved'];

async function findOwnMedia(token, parsed, knownId) {
  if (knownId) return { id: knownId };
  const G = IG_GRAPH();
  if (parsed.kind === 'story') {
    const s = await getJson(`${G}/me/stories?fields=id,permalink,media_type,timestamp&access_token=${token}`);
    return (s.data || []).find((m) => String(m.id) === String(parsed.id) || String(m.permalink || '').includes(parsed.id)) || null;
  }
  let next = `${G}/me/media?fields=id,shortcode,permalink,media_type,media_product_type,timestamp&limit=50&access_token=${token}`;
  for (let page = 0; page < 4 && next; page += 1) {
    const r = await getJson(next);
    const hit = (r.data || []).find((m) => m.shortcode === parsed.shortcode || String(m.permalink || '').includes(`/${parsed.shortcode}`));
    if (hit) return hit;
    next = r.paging && r.paging.next;
  }
  return null;
}

async function insights(token, mediaId, productType) {
  const G = IG_GRAPH();
  const wanted = METRIC_SETS[productType] || METRIC_SETS.FEED;
  let rows;
  try {
    rows = (await getJson(`${G}/${mediaId}/insights?metric=${wanted.join(',')}&access_token=${token}`)).data;
  } catch (e) {
    // Some metrics don't exist for some media types or ages: ask for a smaller safe set
    rows = (await getJson(`${G}/${mediaId}/insights?metric=${(productType === 'STORY' ? ['reach', 'views'] : FALLBACK_METRICS).join(',')}&access_token=${token}`)).data;
  }
  const v = {};
  (rows || []).forEach((r) => { v[r.name] = r.total_value ? r.total_value.value : r.values && r.values[0] ? r.values[0].value : undefined; });
  return v;
}

async function instagramOwn(account, parsed, knownId) {
  const token = account.access_token;
  const media = await findOwnMedia(token, parsed, knownId);
  if (!media) return null;
  const product = parsed.kind === 'story' ? 'STORY' : (media.media_product_type || (parsed.kind === 'reel' ? 'REELS' : 'FEED'));
  const v = await insights(token, media.id, product);
  return {
    source: 'instagram_insights', media_id: media.id, media_type: product,
    reach: n(v.reach), views: n(v.views), impressions: n(v.impressions ?? v.views),
    likes: n(v.likes), comments: n(v.comments), shares: n(v.shares), saves: n(v.saved),
    replies: n(v.replies), interactions: n(v.total_interactions),
  };
}

/* ---------- Instagram public fallback (likes and comments only) ---------- */
async function instagramPublic(username, parsed) {
  const igId = process.env.IG_BUSINESS_ACCOUNT_ID;
  const token = process.env.IG_ACCESS_TOKEN;
  if (!igId || !token || !username || parsed.kind === 'story') return null;
  const f = `business_discovery.username(${username}){media.limit(50){id,permalink,like_count,comments_count,media_product_type}}`;
  const d = await getJson(`${FB_GRAPH}/${igId}?fields=${encodeURIComponent(f)}&access_token=${token}`);
  const list = (d.business_discovery && d.business_discovery.media && d.business_discovery.media.data) || [];
  const m = list.find((x) => String(x.permalink || '').includes(`/${parsed.shortcode}`));
  if (!m) return null;
  return { source: 'instagram_public', media_id: m.id, media_type: m.media_product_type, likes: n(m.like_count), comments: n(m.comments_count) };
}

/* ---------- Main: fetch, store a snapshot, update the deliverable ---------- */
async function trackDeliverable(app, d, { creatorId } = {}) {
  const parsed = parsePostUrl(d.published_url);
  const prev = safeJson(d.metrics_json) || {};
  if (!parsed) return { ok: false, reason: 'unsupported_link', metrics: prev };

  let m = null;
  let reason = null;
  try {
    if (parsed.platform === 'youtube') {
      m = await youtubeVideo(parsed.id);
      if (!m) reason = process.env.YOUTUBE_API_KEY ? 'not_found' : 'youtube_not_configured';
    } else {
      const cid = creatorId || (await db.one(app, 'Deals', `ROWID = ${db.id(d.deal_id)}`) || {}).creator_id;
      const accounts = cid ? await db.select(app, 'SocialAccounts', `creator_id = ${db.id(cid)} AND platform = 'instagram' AND is_connected = true`) : [];
      const own = accounts.find((a) => a.connection_type === 'oauth' && a.access_token);
      if (own) {
        try { m = await instagramOwn(own, parsed, prev.source === 'instagram_insights' ? prev.media_id : null); }
        catch (e) { reason = /token|session|OAuth/i.test(e.message) ? 'instagram_login_expired' : 'instagram_error'; console.error('ig insights', d.ROWID, e.message); }
        if (!m && !reason) reason = 'not_found_on_account';
      }
      if (!m) {
        const handle = (accounts[0] && accounts[0].handle) || parsed.username;
        const pub = await instagramPublic(handle, parsed).catch(() => null);
        if (pub) { m = pub; if (!own) reason = 'connect_instagram_for_reach'; }
        else if (!reason) reason = own ? 'not_found_on_account' : 'connect_instagram';
      }
    }
  } catch (e) {
    console.error('track post failed', d.ROWID, e.message);
    reason = 'error';
  }

  if (!m) {
    // Keep whatever we had (auto or hand-entered); just record why the check failed
    const kept = { ...prev, last_check_at: db.now(), last_check_error: reason };
    await db.update(app, 'Deliverables', { ROWID: d.ROWID, metrics_json: JSON.stringify(kept) });
    return { ok: false, reason, metrics: kept };
  }

  // Public data has no reach/views: keep earlier full numbers (from insights or typed by the creator) and update the rest
  const defined = Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined));
  const base = m.reach === undefined && m.views === undefined ? prev : {};
  const merged = { ...base, ...defined };
  const interactions = m.interactions ?? ((merged.likes || 0) + (merged.comments || 0) + (merged.shares || 0) + (merged.saves || 0));
  m = merged;
  const latest = {
    ...m,
    interactions,
    // per reach when we know reach (Instagram insights), otherwise per view (YouTube)
    engagement_rate: m.reach ? Math.round((interactions / m.reach) * 10000) / 100 : m.views ? Math.round((interactions / m.views) * 10000) / 100 : undefined,
    platform: parsed.platform, kind: parsed.kind,
    updated_at: db.now(), last_check_at: db.now(), last_check_error: reason || undefined,
    auto: true,
  };
  await db.update(app, 'Deliverables', { ROWID: d.ROWID, metrics_json: JSON.stringify(latest) });
  await db.insert(app, 'PostMetrics', {
    deliverable_id: d.ROWID, deal_id: d.deal_id, platform: parsed.platform, source: m.source,
    views: m.views, reach: m.reach, impressions: m.impressions, likes: m.likes, comments: m.comments,
    shares: m.shares, saves: m.saves, interactions,
  });
  return { ok: true, reason, metrics: latest };
}

/** Which published posts are due for a check this hour. */
function isDue(d, nowMs = Date.now()) {
  const m = safeJson(d.metrics_json) || {};
  const published = Date.parse(String(d.published_at || '').replace(' ', 'T') + '+05:30') || nowMs;
  const last = m.last_check_at ? Date.parse(String(m.last_check_at).replace(' ', 'T') + '+05:30') : 0;
  const age = (nowMs - published) / 3600000;
  const since = (nowMs - last) / 3600000;
  const parsed = parsePostUrl(d.published_url) || {};
  if (parsed.kind === 'story') return age <= 26;           // stories: every hour until they expire
  if (age <= 48) return since >= 0.9;                         // first 2 days: hourly
  if (age <= 7 * 24) return since >= 6;                       // first week: every 6 hours
  if (age <= 30 * 24) return since >= 24;                     // first month: daily
  return false;
}

/* ---------- Instagram login (OAuth) ---------- */
const crypto = require('crypto');
const stateKey = () => process.env.OAUTH_STATE_SECRET || process.env.SCHEDULER_SECRET || '';
function signState(creatorId) {
  const body = `${creatorId}.${Date.now() + 15 * 60000}`;
  const sig = crypto.createHmac('sha256', stateKey()).update(body).digest('hex').slice(0, 32);
  return `${body}.${sig}`;
}
function readState(state) {
  const [cid, exp, sig] = String(state || '').split('.');
  if (!cid || !exp || !sig || Number(exp) < Date.now()) return null;
  const good = crypto.createHmac('sha256', stateKey()).update(`${cid}.${exp}`).digest('hex').slice(0, 32);
  return good.length === sig.length && crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig)) ? cid : null;
}
function origin() {
  try { return new URL(process.env.APP_URL).origin; } catch { return ''; }
}
const redirectUri = () => process.env.IG_REDIRECT_URI || `${origin()}/server/brandfluence_api/oauth/instagram/callback`;
const igConfigured = () => Boolean(process.env.IG_APP_ID && process.env.IG_APP_SECRET);

function instagramAuthUrl(creatorId) {
  const q = new URLSearchParams({
    client_id: process.env.IG_APP_ID, redirect_uri: redirectUri(), response_type: 'code',
    scope: 'instagram_business_basic,instagram_business_manage_insights', state: signState(creatorId),
  });
  return `https://www.instagram.com/oauth/authorize?${q}`;
}

async function exchangeInstagramCode(code) {
  const form = new URLSearchParams({ client_id: process.env.IG_APP_ID, client_secret: process.env.IG_APP_SECRET,
    grant_type: 'authorization_code', redirect_uri: redirectUri(), code });
  const res = await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', body: form });
  const raw = await res.json().catch(() => ({}));
  const short = raw.data && raw.data[0] ? raw.data[0] : raw;
  if (!short.access_token) throw new Error(raw.error_message || 'Instagram did not return a token');
  const long = await getJson(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(process.env.IG_APP_SECRET)}&access_token=${encodeURIComponent(short.access_token)}`);
  const me = await getJson(`${IG_GRAPH()}/me?fields=user_id,username,account_type,followers_count,media_count&access_token=${long.access_token}`);
  return { token: long.access_token, expiresIn: Number(long.expires_in) || 60 * 86400, me };
}

async function refreshInstagramToken(app, account) {
  const r = await getJson(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(account.access_token)}`);
  await db.update(app, 'SocialAccounts', { ROWID: account.ROWID, access_token: r.access_token, token_expires_at: db.now((Number(r.expires_in) || 60 * 86400) * 1000) });
  return true;
}

/** Profile numbers for an Instagram account the creator connected themselves. */
async function instagramOwnProfile(token) {
  const G = IG_GRAPH();
  const me = await getJson(`${G}/me?fields=user_id,username,followers_count,follows_count,media_count&access_token=${token}`);
  const media = ((await getJson(`${G}/me/media?fields=like_count,comments_count&limit=12&access_token=${token}`)).data) || [];
  const cnt = media.length || 1;
  const avgLikes = Math.round(media.reduce((a, x) => a + (x.like_count || 0), 0) / cnt);
  const avgComments = Math.round(media.reduce((a, x) => a + (x.comments_count || 0), 0) / cnt);
  const followers = me.followers_count || 0;
  return {
    platform_account_id: String(me.user_id || me.id), handle: me.username, profile_url: `https://www.instagram.com/${me.username}/`,
    followers, following: me.follows_count || 0, posts_count: me.media_count || 0, avg_likes: avgLikes, avg_comments: avgComments,
    engagement_rate: followers ? Math.round(((avgLikes + avgComments) / followers) * 10000) / 100 : 0,
  };
}

function safeJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

module.exports = {
  parsePostUrl, trackDeliverable, isDue, instagramAuthUrl, exchangeInstagramCode, refreshInstagramToken,
  instagramOwnProfile, readState, igConfigured, redirectUri, origin, safeJson,
};
