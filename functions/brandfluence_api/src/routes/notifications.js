'use strict';
const router = require('express').Router();
const db = require('../lib/db');
const { wrap } = require('../lib/errors');
const { requireProfile } = require('../lib/auth');

router.get('/', requireProfile, wrap(async (req, res) => {
  const pid = req.profile.ROWID;
  const where = [`user_profile_id = ${pid}`];
  if (req.query.unread === '1') where.push('is_read = false');
  const { tail } = db.paging(req, 50);
  const [data, unread] = await Promise.all([
    db.select(req.app_, 'Notifications', where.join(' AND '), `ORDER BY CREATEDTIME DESC ${tail}`),
    db.count(req.app_, 'Notifications', `user_profile_id = ${pid} AND is_read = false`),
  ]);
  res.json({ data, unread });
}));

router.post('/:id/read', requireProfile, wrap(async (req, res) => {
  const n = await db.one(req.app_, 'Notifications', `ROWID = ${db.id(req.params.id)} AND user_profile_id = ${req.profile.ROWID}`);
  if (n) await db.update(req.app_, 'Notifications', { ROWID: n.ROWID, is_read: true });
  res.json({ ok: true });
}));

router.post('/read-all', requireProfile, wrap(async (req, res) => {
  const rows = await db.select(req.app_, 'Notifications', `user_profile_id = ${req.profile.ROWID} AND is_read = false`, 'LIMIT 0, 200');
  if (rows.length) await req.app_.datastore().table('Notifications').updateRows(rows.map((r) => ({ ROWID: r.ROWID, is_read: true })));
  res.json({ ok: true, updated: rows.length });
}));

module.exports = router;
