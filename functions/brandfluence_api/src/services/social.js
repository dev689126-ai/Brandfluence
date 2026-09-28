'use strict';
/**
 * Social metrics fetching.
 *  - YouTube: public channel statistics via YouTube Data API v3 (needs YOUTUBE_API_KEY).
 *  - Instagram: Business Discovery API through the platform's own IG Business account
 *    (needs IG_BUSINESS_ACCOUNT_ID + IG_ACCESS_TOKEN). Works for creator/business IG accounts only.
 *  - Other platforms: self-reported ("manual") until an official integration is added; shown as unverified.
 */
const db = require('../lib/db');

/* Accept a handle, @handle or full profile link and return the bare identifier */
function normalizeHandle(platform, input) {
  let h = String(input || '').trim();
  try {
    if (/^https?:\/\//i.test(h)) {
      const u = new URL(h);
      const parts = u.pathname.split('/').filter(Boolean);
      if (platform === 'youtube') {
        if (parts[0] === 'channel' && parts[1]) return parts[1];
        if (parts[0] && parts[0].startsWith('@')) return parts[0];
        if ((parts[0] === 'c' || parts[0] === 'user') && parts[1]) return '@' + parts[1];
      }
      h = parts[0] || h;
    }
  } catch { /* not a URL */ }
  return platform === 'youtube' ? h : h.replace(/^@/, '');
}

const round2 = (n) => Math.round(n * 100) / 100;

/* YouTube Data API v3 (free key). ~3 quota units per channel.
   Real averages come from the latest 10 uploads, not lifetime totals. */
async function fetchYouTube(handleOrId) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return null;
  const h = normalizeHandle('youtube', handleOrId);
  const param = h.startsWith('UC') ? `id=${encodeURIComponent(h)}` : `forHandle=${encodeURIComponent(h.startsWith('@') ? h : '@' + h)}`;
  const API = 'https://www.googleapis.com/youtube/v3';
  const chRes = await fetch(`${API}/channels?part=statistics,snippet,contentDetails&${param}&key=${key}`);
  const ch = ((await chRes.json()).items || [])[0];
  if (!ch) return null;
  const s = ch.statistics || {};
  const subs = s.hiddenSubscriberCount ? 0 : Number(s.subscriberCount) || 0;
  let avgViews = 0; let avgLikes = 0; let avgComments = 0; let er = null;
  try {
    const uploads = ch.contentDetails.relatedPlaylists.uploads;
    const pl = await (await fetch(`${API}/playlistItems?part=contentDetails&maxResults=10&playlistId=${uploads}&key=${key}`)).json();
    const ids = (pl.items || []).map((i) => i.contentDetails.videoId).join(',');
    if (ids) {
      const vids = ((await (await fetch(`${API}/videos?part=statistics&id=${ids}&key=${key}`)).json()).items || []).map((v) => v.statistics || {});
      const n = vids.length || 1;
      const sum = (k) => vids.reduce((a, v) => a + (Number(v[k]) || 0), 0);
      avgViews = Math.round(sum('viewCount') / n);
      avgLikes = Math.round(sum('likeCount') / n);
      avgComments = Math.round(sum('commentCount') / n);
      er = avgViews ? round2(((avgLikes + avgComments) / avgViews) * 100) : null;
    }
  } catch (e) { console.error('youtube recent videos failed', e.message); }
  return {
    platform_account_id: ch.id,
    handle: ch.snippet && ch.snippet.customUrl ? ch.snippet.customUrl : h,
    profile_url: `https://www.youtube.com/channel/${ch.id}`,
    followers: subs,
    posts_count: Number(s.videoCount) || 0,
    total_views: Number(s.viewCount) || 0,
    avg_views: avgViews,
    avg_likes: avgLikes,
    avg_comments: avgComments,
    engagement_rate: er,
  };
}

/* Twitch Helix API (free, app access token). Followers total works with an app token. */
let twitchToken = null;
async function twitchAuth() {
  const id = process.env.TWITCH_CLIENT_ID;
  const secret = process.env.TWITCH_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (twitchToken && twitchToken.exp > Date.now()) return twitchToken.value;
  const r = await (await fetch(`https://id.twitch.tv/oauth2/token?client_id=${id}&client_secret=${secret}&grant_type=client_credentials`, { method: 'POST' })).json();
  if (!r.access_token) return null;
  twitchToken = { value: r.access_token, exp: Date.now() + (r.expires_in - 300) * 1000 };
  return twitchToken.value;
}
async function fetchTwitch(login) {
  const token = await twitchAuth();
  if (!token) return null;
  const headers = { 'Client-Id': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` };
  const name = normalizeHandle('twitch', login).toLowerCase();
  const user = ((await (await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(name)}`, { headers })).json()).data || [])[0];
  if (!user) return null;
  const f = await (await fetch(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${user.id}&first=1`, { headers })).json();
  const vids = ((await (await fetch(`https://api.twitch.tv/helix/videos?user_id=${user.id}&first=10&type=archive`, { headers })).json()).data || []);
  const avgViews = vids.length ? Math.round(vids.reduce((a, v) => a + (v.view_count || 0), 0) / vids.length) : 0;
  return {
    platform_account_id: user.id,
    handle: user.login,
    profile_url: `https://www.twitch.tv/${user.login}`,
    followers: Number(f.total) || 0,
    posts_count: vids.length,
    avg_views: avgViews,
    engagement_rate: null,
  };
}

async function fetchInstagram(username) {
  const igId = process.env.IG_BUSINESS_ACCOUNT_ID;
  const token = process.env.IG_ACCESS_TOKEN;
  if (!igId || !token) return null;
  const u = normalizeHandle('instagram', username);
  const fields = `business_discovery.username(${u}){id,username,followers_count,follows_count,media_count,media.limit(12){like_count,comments_count,media_type}}`;
  const res = await fetch(`https://graph.facebook.com/v19.0/${igId}?fields=${encodeURIComponent(fields)}&access_token=${token}`);
  const data = await res.json();
  const bd = data.business_discovery;
  if (!bd) return null;
  const media = (bd.media && bd.media.data) || [];
  const likes = media.reduce((a, m) => a + (m.like_count || 0), 0);
  const comments = media.reduce((a, m) => a + (m.comments_count || 0), 0);
  const n = media.length || 1;
  const followers = bd.followers_count || 0;
  const avgLikes = Math.round(likes / n);
  const avgComments = Math.round(comments / n);
  return {
    platform_account_id: bd.id,
    profile_url: `https://www.instagram.com/${bd.username}/`,
    followers,
    following: bd.follows_count || 0,
    posts_count: bd.media_count || 0,
    avg_likes: avgLikes,
    avg_comments: avgComments,
    engagement_rate: followers ? round2(((avgLikes + avgComments) / followers) * 100) : 0,
  };
}

/** Fetch fresh metrics for one SocialAccounts row, store snapshot, update the account. Returns true if verified data was fetched. */
async function syncAccount(app, account) {
  let m = null;
  try {
    if (account.platform === 'youtube') m = await fetchYouTube(account.platform_account_id || account.handle);
    if (account.platform === 'instagram') m = await fetchInstagram(account.handle);
    if (account.platform === 'twitch') m = await fetchTwitch(account.handle);
  } catch (e) {
    console.error('social sync failed', account.ROWID, e.message);
  }
  if (!m) return false;

  await db.update(app, 'SocialAccounts', {
    ROWID: account.ROWID,
    platform_account_id: m.platform_account_id,
    handle: m.handle ? String(m.handle).replace(/^@/, '') : undefined,
    profile_url: m.profile_url,
    followers: m.followers,
    avg_views: m.avg_views ?? account.avg_views,
    engagement_rate: m.engagement_rate ?? account.engagement_rate,
    connection_type: 'api',
    last_synced_at: db.now(),
  });
  await db.insert(app, 'SocialMetrics', {
    social_account_id: account.ROWID,
    snapshot_date: db.today(),
    followers: m.followers,
    following: m.following,
    posts_count: m.posts_count,
    total_views: m.total_views,
    avg_likes: m.avg_likes,
    avg_comments: m.avg_comments,
    avg_views: m.avg_views,
    engagement_rate: m.engagement_rate,
  });
  return true;
}

/** Recompute creator totals + profile strength after social/rates/portfolio changes. */
async function recomputeCreator(app, creatorId) {
  const cid = db.id(creatorId);
  const creator = await db.one(app, 'CreatorProfiles', `ROWID = ${cid}`);
  if (!creator) return;
  const accounts = await db.select(app, 'SocialAccounts', `creator_id = ${cid} AND is_connected = true`);
  const rates = await db.select(app, 'RateCards', `creator_id = ${cid} AND is_active = true`);
  const portfolio = await db.count(app, 'PortfolioItems', `creator_id = ${cid}`);

  const total = accounts.reduce((a, x) => a + (Number(x.followers) || 0), 0);
  const withEr = accounts.filter((x) => x.engagement_rate !== null && x.engagement_rate !== undefined && x.engagement_rate !== '');
  const er = withEr.length
    ? round2(withEr.reduce((a, x) => a + Number(x.engagement_rate) * (Number(x.followers) || 1), 0) /
             withEr.reduce((a, x) => a + (Number(x.followers) || 1), 0))
    : null;
  const contentRates = rates.filter((r) => (r.rate_kind || 'content') === 'content').map((r) => Number(r.price));
  const minRate = contentRates.length ? Math.min(...contentRates) : null;

  const checks = [creator.photo_url, creator.bio, creator.categories, creator.city, creator.languages,
    accounts.length > 0, accounts.some((a) => a.connection_type === 'api'), rates.length > 0, portfolio > 0,
    creator.is_verified === true || creator.is_verified === 'true'];
  const strength = Math.round((checks.filter(Boolean).length / checks.length) * 100);

  await db.update(app, 'CreatorProfiles', {
    ROWID: creator.ROWID,
    total_followers: total,
    avg_engagement_rate: er,
    min_rate: minRate,
    profile_strength: strength,
  });
}

/** Which platforms can be verified automatically right now (keys present) */
function autoSyncPlatforms() {
  const out = [];
  if (process.env.YOUTUBE_API_KEY) out.push('youtube');
  if (process.env.IG_BUSINESS_ACCOUNT_ID && process.env.IG_ACCESS_TOKEN) out.push('instagram');
  if (process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET) out.push('twitch');
  return out;
}

module.exports = { normalizeHandle, fetchYouTube, fetchInstagram, fetchTwitch, syncAccount, recomputeCreator, autoSyncPlatforms };
