'use strict';
/**
 * Background tasks, triggered daily by the bf_scheduler job function.
 * Protected by a shared secret header (x-scheduler-secret).
 */
const router = require('express').Router();
const crypto = require('crypto');
const catalyst = require('zcatalyst-sdk-node');
const db = require('../lib/db');
const { STATUS } = require('../services/dealMachine');
const { syncAccount, recomputeCreator } = require('../services/social');
const { notify } = require('../services/notify');
const { releaseDeal } = require('./payments');
const { trackDeliverable, isDue, refreshInstagramToken } = require('../services/postTracking');

router.post('/run/:task', async (req, res) => {
  const secret = process.env.SCHEDULER_SECRET || '';
  const given = String(req.get('x-scheduler-secret') || '');
  if (!secret || given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return res.status(401).json({ ok: false });
  }
  const app = catalyst.initialize(req, { scope: 'admin' });
  try {
    const fn = TASKS[req.params.task];
    if (!fn) return res.status(404).json({ ok: false, error: 'unknown task' });
    const result = await fn(app);
    res.json({ ok: true, task: req.params.task, result });
  } catch (e) {
    console.error('task failed', req.params.task, e);
    res.status(500).json({ ok: false });
  }
});

const TASKS = {
  /* Hourly: pull reach, views and engagement for published deal posts */
  async track_posts(app) {
    const since = db.now(-31 * 86400000);
    const rows = await db.select(app, 'Deliverables', `status = 'published' AND published_at >= '${since}'`, 'ORDER BY published_at DESC LIMIT 0, 300');
    const due = rows.filter((d) => isDue(d)).slice(0, 80);
    let ok = 0;
    for (const d of due) { try { if ((await trackDeliverable(app, d)).ok) ok += 1; } catch (e) { console.error('track', d.ROWID, e.message); } }
    return { published: rows.length, checked: due.length, updated: ok };
  },

  /* Refresh follower/engagement numbers for verifiable accounts */
  async sync_metrics(app) {
    const accounts = await db.select(app, 'SocialAccounts',
      `is_connected = true AND platform IN ('youtube','instagram','twitch')`, 'ORDER BY last_synced_at ASC LIMIT 0, 150');
    let ok = 0;
    const creators = new Set();
    for (const a of accounts) {
      if (await syncAccount(app, a)) { ok += 1; creators.add(String(a.creator_id)); }
    }
    for (const c of creators) await recomputeCreator(app, c);
    // Instagram logins last 60 days: renew any that expire within 10 days
    let renewed = 0;
    const soon = db.now(10 * 86400000);
    const igs = await db.select(app, 'SocialAccounts', `platform = 'instagram' AND connection_type = 'oauth' AND is_connected = true AND token_expires_at <= '${soon}'`, 'LIMIT 0, 100');
    for (const a of igs) { try { if (a.access_token && await refreshInstagramToken(app, a)) renewed += 1; } catch (e) { console.error('ig token refresh', a.ROWID, e.message); } }
    return { checked: accounts.length, synced: ok, instagram_logins_renewed: renewed };
  },

  /* Release held funds N days after all content is published, if nobody objected */
  async auto_release(app) {
    const days = Number(process.env.AUTO_RELEASE_DAYS || 7);
    const cutoff = db.now(-days * 86400000);
    const deals = await db.select(app, 'Deals', `status = '${STATUS.PUBLISHED}' AND MODIFIEDTIME <= '${cutoff}'`, 'LIMIT 0, 50');
    const results = [];
    for (const d of deals) {
      try { await releaseDeal(app, d, null); results.push({ deal: d.deal_number, released: true }); }
      catch (e) { results.push({ deal: d.deal_number, released: false, reason: e.message }); }
    }
    return results;
  },

  /* Deadline reminders + stale offer nudges */
  async reminders(app) {
    const tomorrow = db.now(86400000).slice(0, 10);
    const due = await db.select(app, 'Deliverables',
      `due_date = '${tomorrow}' AND status IN ('pending','revision_requested')`, 'LIMIT 0, 200');
    for (const d of due) {
      const deal = await db.one(app, 'Deals', `ROWID = ${db.id(d.deal_id)}`);
      if (!deal || ['cancelled', 'rejected', 'disputed'].includes(deal.status)) continue;
      const c = await db.one(app, 'CreatorProfiles', `ROWID = ${db.id(deal.creator_id)}`);
      await notify(app, c.user_profile_id, { type: 'deadline', dealId: deal.ROWID, link: `/deals/${deal.ROWID}`,
        title: `Due tomorrow: ${d.platform} ${d.content_type} #${d.sequence_no}`, body: `Deal ${deal.deal_number}` });
    }
    const stale = await db.select(app, 'Deals', `status = 'offer_sent' AND CREATEDTIME <= '${db.now(-3 * 86400000)}' AND CREATEDTIME > '${db.now(-4 * 86400000)}'`, 'LIMIT 0, 100');
    for (const deal of stale) {
      const c = await db.one(app, 'CreatorProfiles', `ROWID = ${db.id(deal.creator_id)}`);
      await notify(app, c.user_profile_id, { type: 'offer_reminder', dealId: deal.ROWID, link: `/deals/${deal.ROWID}`,
        title: 'You have an offer waiting', body: `Deal ${deal.deal_number} is waiting for your reply.`, email: true });
    }
    return { deadline_reminders: due.length, offer_reminders: stale.length };
  },
};

module.exports = router;
