'use strict';
const router = require('express').Router();
const db = require('../lib/db');
const { wrap, badRequest, conflict } = require('../lib/errors');
const { isAdminEmail } = require('../lib/auth');
const { audit } = require('../services/audit');
const { planInfo } = require('../services/plans');

// GET /me – who am I, and have I onboarded?
router.get('/', wrap(async (req, res) => {
  res.json({
    user: { id: req.user.user_id, email: req.user.email_id, first_name: req.user.first_name, last_name: req.user.last_name },
    profile: req.profile,
    creator: req.creator ? hideSecrets(req.creator) : null,
    plan: req.creator ? await planInfo(req.app_, req.creator) : null,
    business: req.business || null,
    onboarded: Boolean(req.profile && String(req.profile.onboarding_complete) === 'true'),
    can_be_admin: isAdminEmail(req.user.email_id),
  });
}));

/**
 * POST /me/onboard – "What are you here to do?"
 * body: { role: 'creator'|'business'|'admin', phone, creator:{...} | business:{...} }
 */
router.post('/onboard', wrap(async (req, res) => {
  const app = req.app_;
  const { role } = req.body || {};
  if (!['creator', 'business', 'admin'].includes(role)) throw badRequest('Choose Creator or Business');
  if (role === 'admin' && !isAdminEmail(req.user.email_id)) throw badRequest('Admin role is not available for this account');
  if (req.profile) throw conflict('You have already onboarded');

  const profile = await db.insert(app, 'UserProfiles', {
    catalyst_user_id: String(req.user.user_id),
    role,
    email: req.user.email_id,
    phone: req.body.phone,
    email_verified: Boolean(req.user.is_confirmed),
    onboarding_complete: role === 'admin',
    last_login: db.now(),
  });

  let roleProfile = null;
  if (role === 'creator') {
    const c = req.body.creator || {};
    if (!c.full_name || !c.username) throw badRequest('Name and username are required');
    const username = String(c.username).toLowerCase().replace(/[^a-z0-9._]/g, '');
    if (await db.one(app, 'CreatorProfiles', `username = ${db.str(username)}`)) throw conflict('That username is taken');
    roleProfile = await db.insert(app, 'CreatorProfiles', {
      user_profile_id: profile.ROWID,
      full_name: c.full_name,
      username,
      bio: c.bio,
      gender: c.gender,
      age_range: c.age_range,
      city: c.city,
      state: c.state,
      country: c.country || 'India',
      languages: joinList(c.languages),
      categories: joinList(c.categories),
      creator_types: joinList(c.creator_types),
    });
  }
  if (role === 'business') {
    const b = req.body.business || {};
    if (!b.company_name) throw badRequest('Company name is required');
    roleProfile = await db.insert(app, 'BusinessProfiles', {
      user_profile_id: profile.ROWID,
      company_name: b.company_name,
      category: b.category,
      website: b.website,
      contact_email: b.contact_email || req.user.email_id,
      contact_phone: b.contact_phone || req.body.phone,
      address: b.address,
      city: b.city,
      state: b.state,
      country: b.country || 'India',
      gstin: b.gstin,
      about: b.about,
    });
  }
  if (roleProfile) await db.update(app, 'UserProfiles', { ROWID: profile.ROWID, onboarding_complete: true });
  await audit(app, { actor: profile, entityType: 'user', entityId: profile.ROWID, action: 'onboarded', details: { role } });
  res.status(201).json({ profile, [role]: roleProfile });
}));

function joinList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).join(',').slice(0, 255);
  return v ? String(v).slice(0, 255) : undefined;
}
function hideSecrets(c) {
  const { razorpay_account_id, ...rest } = c;
  return { ...rest, payouts_ready: Boolean(razorpay_account_id) };
}

module.exports = router;
module.exports.joinList = joinList;
module.exports.hideSecrets = hideSecrets;
