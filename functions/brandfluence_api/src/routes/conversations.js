'use strict';
/**
 * Direct chats between a creator and a business, outside any deal.
 *   - A creator starting a chat = a "pitch". Free creators get a small monthly allowance, Pro creators more.
 *   - A business can message any creator; replying in an existing chat is always free.
 *   - The business turns a good chat into a deal by sending an offer (POST /deals with conversation_id).
 *
 *   GET  /conversations                 my chats (newest first)
 *   POST /conversations                 start a chat { business_id | creator_id, subject?, body }
 *   GET  /conversations/:id?after=ROWID one chat with its messages (marks them read)
 *   POST /conversations/:id/messages    { body }
 *   POST /conversations/:id/close
 */
const router = require('express').Router();
const db = require('../lib/db');
const { wrap, badRequest, forbidden, conflict, HttpError } = require('../lib/errors');
const { requireRole } = require('../lib/auth');
const { notify } = require('../services/notify');
const plans = require('../services/plans');

const parties = requireRole('creator', 'business');
const MAX_BODY = 2000;

function cleanBody(v) {
  const body = String(v || '').trim();
  if (!body) throw badRequest('Write a message');
  if (body.length > MAX_BODY) throw badRequest(`Keep messages under ${MAX_BODY} characters`);
  return body;
}

const side = (req) => req.profile.role; // 'creator' | 'business'
const myId = (req) => (side(req) === 'creator' ? req.creator.ROWID : req.business.ROWID);
const unreadCol = (role) => (role === 'creator' ? 'creator_unread' : 'business_unread');

async function loadFor(req, rowId) {
  const c = await db.mustGet(req.app_, 'Conversations', rowId, 'Chat');
  const mine = side(req) === 'creator' ? String(c.creator_id) === String(req.creator.ROWID) : String(c.business_id) === String(req.business.ROWID);
  if (!mine) throw forbidden('You are not part of this chat');
  return c;
}

function bizCard(b) {
  return b ? { ROWID: b.ROWID, name: b.company_name, photo: b.logo_url, city: b.city, category: b.category,
    verified: b.verification_status === 'verified', user_profile_id: b.user_profile_id } : null;
}
function creatorCard(c) {
  return c ? { ROWID: c.ROWID, name: c.full_name, username: c.username, photo: c.photo_url, city: c.city,
    followers: c.total_followers, is_pro: plans.isPro(c), user_profile_id: c.user_profile_id } : null;
}
const publicCard = ({ user_profile_id, ...x }) => x;

async function counterparts(app, convs, role) {
  const ids = [...new Set(convs.map((c) => String(role === 'creator' ? c.business_id : c.creator_id)))];
  if (!ids.length) return [];
  return role === 'creator'
    ? (await db.select(app, 'BusinessProfiles', `ROWID IN ${db.list(ids, db.id)}`)).map(bizCard)
    : (await db.select(app, 'CreatorProfiles', `ROWID IN ${db.list(ids, db.id)}`)).map(creatorCard);
}

/* ---------- List ---------- */
router.get('/', parties, wrap(async (req, res) => {
  const app = req.app_;
  const role = side(req);
  const where = [`${role === 'creator' ? 'creator_id' : 'business_id'} = ${myId(req)}`];
  if (req.query.status) where.push(`status = ${db.str(req.query.status)}`);
  const convs = await db.select(app, 'Conversations', where.join(' AND '), 'ORDER BY MODIFIEDTIME DESC LIMIT 0, 100');
  const people = await counterparts(app, convs, role);
  const out = convs.map((c) => {
    const otherId = String(role === 'creator' ? c.business_id : c.creator_id);
    const other = people.find((p) => p && String(p.ROWID) === otherId);
    return { ...c, unread: Number(c[unreadCol(role)]) || 0, with: other ? publicCard(other) : null };
  });
  res.json({ data: out, unread: out.reduce((s, c) => s + c.unread, 0),
    plan: role === 'creator' ? await plans.planInfo(app, req.creator) : undefined });
}));

/* ---------- Start a chat ---------- */
router.post('/', parties, wrap(async (req, res) => {
  const app = req.app_;
  const role = side(req);
  const b = req.body || {};
  const body = cleanBody(b.body);
  const subject = String(b.subject || '').trim().slice(0, 200) || undefined;

  let creator;
  let business;
  if (role === 'creator') {
    creator = req.creator;
    business = await db.one(app, 'BusinessProfiles', `ROWID = ${db.id(b.business_id, 'business')}`);
    if (!business) throw badRequest('Business not found');
  } else {
    business = req.business;
    creator = await db.one(app, 'CreatorProfiles', `ROWID = ${db.id(b.creator_id, 'creator')}`);
    if (!creator) throw badRequest('Creator not found');
  }

  // One open chat per creator–business pair: add to it instead of opening another
  const existing = await db.one(app, 'Conversations',
    `creator_id = ${creator.ROWID} AND business_id = ${business.ROWID} AND status = 'open'`);
  if (existing) {
    const msg = await addMessage(req, existing, body);
    return res.status(200).json({ conversation: existing, message: msg, existing: true });
  }

  if (role === 'creator') {
    const info = await plans.planInfo(app, creator);
    if (info.pitches.left <= 0) {
      throw new HttpError(402, info.is_pro
        ? `You've used all ${info.pitches.limit} pitches this month. More open on the 1st.`
        : 'You have used your free pitch for this month. Upgrade to Pro to pitch up to 30 brands a month.',
      { upgrade: !info.is_pro, pitches: info.pitches });
    }
  }

  const conv = await db.insert(app, 'Conversations', {
    creator_id: creator.ROWID, business_id: business.ROWID, started_by: role, status: 'open', subject,
    last_message_at: db.now(), last_message: body.slice(0, 250), creator_unread: 0, business_unread: 0,
  });
  const msg = await addMessage(req, conv, body, { first: true, creator, business });
  res.status(201).json({ conversation: conv, message: msg });
}));

/* ---------- One chat ---------- */
router.get('/:id', parties, wrap(async (req, res) => {
  const app = req.app_;
  const role = side(req);
  const conv = await loadFor(req, req.params.id);
  const where = [`conversation_id = ${conv.ROWID}`];
  if (req.query.after) where.push(`ROWID > ${db.id(req.query.after)}`);
  const rows = await db.select(app, 'ConversationMessages', where.join(' AND '), 'ORDER BY ROWID ASC LIMIT 0, 300');
  if (Number(conv[unreadCol(role)]) > 0) await db.update(app, 'Conversations', { ROWID: conv.ROWID, [unreadCol(role)]: 0 });
  const [other] = await counterparts(app, [conv], role);
  res.json({
    conversation: { ...conv, unread: 0 },
    with: other ? publicCard(other) : null,
    messages: rows.map((m) => ({ ROWID: m.ROWID, body: m.body, sender_role: m.sender_role, CREATEDTIME: m.CREATEDTIME,
      mine: String(m.sender_profile_id) === String(req.profile.ROWID) })),
  });
}));

router.post('/:id/messages', parties, wrap(async (req, res) => {
  const conv = await loadFor(req, req.params.id);
  if (conv.status === 'closed') throw conflict('This chat is closed');
  const msg = await addMessage(req, conv, cleanBody((req.body || {}).body));
  res.status(201).json(msg);
}));

router.post('/:id/close', parties, wrap(async (req, res) => {
  const conv = await loadFor(req, req.params.id);
  await db.update(req.app_, 'Conversations', { ROWID: conv.ROWID, status: 'closed' });
  res.json({ ok: true });
}));

/* ---------- helpers ---------- */
async function addMessage(req, conv, body, { first = false, creator, business } = {}) {
  const app = req.app_;
  const role = side(req);
  const msg = await db.insert(app, 'ConversationMessages', {
    conversation_id: conv.ROWID, sender_profile_id: req.profile.ROWID, sender_role: role, body,
  });
  const otherRole = role === 'creator' ? 'business' : 'creator';
  const fresh = await db.one(app, 'Conversations', `ROWID = ${conv.ROWID}`);
  await db.update(app, 'Conversations', {
    ROWID: conv.ROWID, last_message_at: db.now(), last_message: body.slice(0, 250),
    [unreadCol(otherRole)]: (Number(fresh && fresh[unreadCol(otherRole)]) || 0) + 1,
  });

  const c = creator || await db.one(app, 'CreatorProfiles', `ROWID = ${db.id(conv.creator_id)}`);
  const b = business || await db.one(app, 'BusinessProfiles', `ROWID = ${db.id(conv.business_id)}`);
  const to = role === 'creator' ? b && b.user_profile_id : c && c.user_profile_id;
  const from = role === 'creator' ? c && c.full_name : b && b.company_name;
  if (to) {
    await notify(app, to, {
      type: 'chat', link: `/messages/${conv.ROWID}`,
      title: first ? (role === 'creator' ? `${from} wants to work with you` : `${from} sent you a message`) : `New message from ${from}`,
      body: body.slice(0, 140),
      email: first, // email only for the first message of a chat
    });
  }
  return { ROWID: msg.ROWID, body, sender_role: role, CREATEDTIME: msg.CREATEDTIME, mine: true };
}

module.exports = router;
