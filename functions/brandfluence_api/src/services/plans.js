'use strict';
/**
 * Creator plans: Free and Pro.
 *
 * Pro creators can pitch businesses directly (start a chat), see brands' open campaigns,
 * appear first in brand searches with a Pro badge, and see which brands viewed their profile.
 * Prices and limits come from environment variables so they can change without a code deploy.
 */
const db = require('../lib/db');

const envNum = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== '' && process.env[name] !== undefined ? v : fallback;
};

const PRICES = () => ({
  month: envNum('CREATOR_PRO_MONTHLY', 499),
  year: envNum('CREATOR_PRO_YEARLY', 4999),
});
const PERIOD_DAYS = { month: 30, year: 365 };

const LIMITS = () => ({
  free: { pitches_per_month: envNum('CREATOR_FREE_PITCHES', 1) },
  pro: { pitches_per_month: envNum('CREATOR_PRO_PITCHES', 30) },
});

const FEATURES = {
  free: ['Receive offers from brands', 'Chat inside your deals', 'Reply to brands who message you', '1 direct pitch to a brand each month'],
  pro: ['Pitch brands directly: 30 new chats a month', 'See brands\' open campaigns and budgets', 'Pro badge and top placement in brand searches', 'See which brands viewed your profile'],
};

// Catalyst datetime strings are IST "yyyy-MM-dd HH:mm:ss"
function toDate(s) { return new Date(String(s).replace(' ', 'T') + '+05:30'); }
function fmt(d) { return new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19); }

function isPro(creator) {
  if (!creator || creator.plan !== 'pro' || !creator.plan_expires_at) return false;
  return String(creator.plan_expires_at) > db.now();
}

function monthStart() { return db.now().slice(0, 7) + '-01 00:00:00'; }

async function pitchesUsed(app, creatorId) {
  return db.count(app, 'Conversations',
    `creator_id = ${db.id(creatorId)} AND started_by = 'creator' AND CREATEDTIME >= ${db.str(monthStart())}`);
}

async function planInfo(app, creator) {
  const pro = isPro(creator);
  const plan = pro ? 'pro' : 'free';
  const limit = LIMITS()[plan].pitches_per_month;
  const used = app ? await pitchesUsed(app, creator.ROWID) : 0;
  return {
    plan,
    is_pro: pro,
    expires_at: pro ? creator.plan_expires_at : null,
    pitches: { used, limit, left: Math.max(0, limit - used) },
    prices: PRICES(),
    features: FEATURES,
  };
}

/** Extend (or start) Pro for a creator. Returns the new expiry. */
async function extendPro(app, creatorId, period) {
  const days = PERIOD_DAYS[period];
  if (!days) throw new Error('Unknown period');
  const c = await db.one(app, 'CreatorProfiles', `ROWID = ${db.id(creatorId)}`);
  const base = isPro(c) ? toDate(c.plan_expires_at) : new Date();
  const ends = fmt(new Date(base.getTime() + days * 86400000));
  await db.update(app, 'CreatorProfiles', { ROWID: c.ROWID, plan: 'pro', plan_expires_at: ends });
  return ends;
}

/** Mark a paid subscription active (idempotent: webhook and browser callback may both arrive). */
async function activateSubscription(app, sub, gatewayPaymentId) {
  if (sub.status === 'active') return sub;
  const starts = db.now();
  const ends = await extendPro(app, sub.creator_id, sub.period);
  const row = { ROWID: sub.ROWID, status: 'active', starts_at: starts, ends_at: ends, gateway_payment_id: gatewayPaymentId };
  await db.update(app, 'CreatorSubscriptions', row);
  return { ...sub, ...row };
}

module.exports = { PRICES, LIMITS, FEATURES, PERIOD_DAYS, isPro, planInfo, pitchesUsed, extendPro, activateSubscription, fmt, toDate };
