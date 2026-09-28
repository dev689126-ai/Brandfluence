'use strict';
const router = require('express').Router();
const db = require('../lib/db');
const { wrap, badRequest, conflict } = require('../lib/errors');
const { requireProfile } = require('../lib/auth');
const { loadDealFor, participants } = require('../services/dealMachine');
const { notify } = require('../services/notify');

// GET /deals/:id/messages?after=<ROWID>
router.get('/deals/:id/messages', requireProfile, wrap(async (req, res) => {
  const app = req.app_;
  const { deal, side } = await loadDealFor(req, req.params.id);
  const where = [`deal_id = ${deal.ROWID}`];
  if (req.query.after) where.push(`ROWID > ${db.id(req.query.after)}`);
  const rows = await db.select(app, 'Messages', where.join(' AND '), 'ORDER BY ROWID ASC LIMIT 0, 200');
  if (side !== 'admin') {
    const unread = rows.filter((m) => String(m.is_read) !== 'true' && String(m.sender_profile_id) !== String(req.profile.ROWID));
    await Promise.all(unread.map((m) => db.update(app, 'Messages', { ROWID: m.ROWID, is_read: true })));
  }
  res.json({ data: rows.map((m) => ({ ...m, mine: String(m.sender_profile_id) === String(req.profile.ROWID) })) });
}));

router.post('/deals/:id/messages', requireProfile, wrap(async (req, res) => {
  const app = req.app_;
  const { deal, side } = await loadDealFor(req, req.params.id);
  if (['rejected', 'cancelled'].includes(deal.status) && side !== 'admin') throw conflict('This deal is closed');
  const body = String((req.body || {}).body || '').trim();
  const attachment = (req.body || {}).attachment_key;
  if (!body && !attachment) throw badRequest('Message is empty');
  if (body.length > 5000) throw badRequest('Message is too long');
  if (attachment && !String(attachment).startsWith(`deals/${deal.ROWID}/`)) throw badRequest('Invalid attachment');

  const msg = await db.insert(app, 'Messages', {
    deal_id: deal.ROWID, sender_profile_id: req.profile.ROWID, sender_role: side,
    message_type: attachment ? 'attachment' : 'text', body, attachment_key: attachment,
  });
  const p = await participants(app, deal);
  const to = side === 'business' ? p.creatorUserId : side === 'creator' ? p.businessUserId : null;
  if (to) {
    const from = side === 'business' ? p.business.company_name : p.creator.full_name;
    await notify(app, to, { type: 'message', dealId: deal.ROWID, link: `/deals/${deal.ROWID}#chat`,
      title: `New message from ${from}`, body: body.slice(0, 140), email: false });
  }
  res.status(201).json(msg);
}));

module.exports = router;
