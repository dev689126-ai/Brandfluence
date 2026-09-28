'use strict';
/**
 * Security middleware: response headers + rate limiting.
 *
 * Rate limits use the shared Catalyst Cache (so every function instance sees the same counts),
 * with an in-memory fallback. If the cache is unreachable the request is allowed ("fail open"),
 * so an outage in the limiter never takes the app down.
 */

/* ---------- Security headers ---------- */
function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(self "https://checkout.razorpay.com")',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  // API data is personal: never let browsers or proxies cache it (files set their own cache header)
  if (!req.path.startsWith('/uploads/file')) res.set('Cache-Control', 'no-store');
  res.removeHeader('X-Powered-By');
  next();
}

/* ---------- Rate limiting ---------- */
// [method, path pattern, max requests, window seconds, name]
const RULES = [
  ['POST', /^\/me\/onboard$/, 5, 3600, 'onboard'],
  ['POST', /^\/deals$/, 30, 3600, 'offers'],
  ['POST', /^\/deals\/\d+\/(counter|accept|reject|cancel|sign)$/, 60, 3600, 'deal_actions'],
  ['POST', /^\/deals\/\d+\/messages$/, 40, 60, 'messages'],
  ['POST', /^\/deals\/\d+\/(disputes|reviews)$/, 10, 3600, 'trust'],
  ['POST', /^\/deals\/\d+\/payment-order$/, 20, 3600, 'payments'],
  ['POST', /^\/uploads\/(file|url)$/, 30, 600, 'uploads'],
  ['POST', /^\/creators\/me\/social(\/\d+\/sync)?$/, 30, 3600, 'social_sync'],
  ['GET', /^\/discover\/creators$/, 120, 60, 'search'],
  ['*', /.*/, 300, 60, 'general'], // everything else, per user per minute
];

const memory = new Map();
function memHit(key, windowSec) {
  const now = Date.now();
  const e = memory.get(key);
  if (!e || e.reset < now) { memory.set(key, { n: 1, reset: now + windowSec * 1000 }); return 1; }
  e.n += 1;
  if (memory.size > 5000) for (const [k, v] of memory) if (v.reset < now) memory.delete(k);
  return e.n;
}

async function cacheHit(app, key, windowSec) {
  const seg = process.env.CACHE_SEGMENT_ID;
  if (!seg || !app) return null;
  const segment = app.cache().segment(seg);
  const current = Number(await segment.getValue(key)) || 0;
  const next = current + 1;
  const hours = Math.max(1, Math.ceil(windowSec / 3600)); // Catalyst cache expiry is in hours
  await segment.put(key, String(next), hours);
  return next;
}

function rateLimit(req, res, next) {
  // webhooks and scheduler have their own protection (signatures / shared secret)
  if (req.path.startsWith('/webhooks') || req.path.startsWith('/internal') || req.path === '/health') return next();
  const rule = RULES.find(([m, re]) => (m === '*' || m === req.method) && re.test(req.path));
  if (!rule) return next();
  const [, , max, windowSec, name] = rule;
  const who = (req.user && req.user.user_id) || req.get('x-forwarded-for') || req.ip || 'anon';
  const windowNo = Math.floor(Date.now() / 1000 / windowSec);
  const key = `rl_${name}_${String(who).replace(/[^a-zA-Z0-9]/g, '')}_${windowNo}`;

  const done = (count) => {
    const remaining = Math.max(0, max - count);
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(remaining));
    if (count > max) {
      const retry = windowSec - (Math.floor(Date.now() / 1000) % windowSec);
      res.set('Retry-After', String(retry));
      return res.status(429).json({ status: 'error', message: `Too many requests. Please wait ${retry < 120 ? retry + ' seconds' : Math.ceil(retry / 60) + ' minutes'} and try again.` });
    }
    next();
  };

  const local = memHit(key, windowSec);
  // Cheap path: the general bucket uses memory only; sensitive buckets also check the shared cache
  if (name === 'general') return done(local);
  cacheHit(req.app_, key, windowSec)
    .then((shared) => done(Math.max(local, shared || 0)))
    .catch(() => done(local)); // fail open
}

module.exports = { securityHeaders, rateLimit, RULES };
