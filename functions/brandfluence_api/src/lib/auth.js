'use strict';
const catalyst = require('zcatalyst-sdk-node');
const db = require('./db');
const { unauthorized, forbidden } = require('./errors');

/**
 * Every request gets:
 *   req.userApp  – user-scoped Catalyst app (identity only)
 *   req.app_     – admin-scoped Catalyst app (all data access; authorization is enforced in code)
 *   req.user     – Catalyst user
 *   req.profile  – UserProfiles row (null until onboarding)
 *   req.creator / req.business – role profile row
 */
async function authenticate(req, _res, next) {
  try {
    req.userApp = catalyst.initialize(req);
    req.app_ = catalyst.initialize(req, { scope: 'admin' });
    let user;
    try {
      user = await req.userApp.userManagement().getCurrentUser();
    } catch (e) {
      throw unauthorized();
    }
    if (!user || !user.user_id) throw unauthorized();
    req.user = user;

    const profile = await db.one(req.app_, 'UserProfiles', `catalyst_user_id = ${db.id(user.user_id)}`);
    req.profile = profile;
    if (profile) {
      if (profile.status === 'suspended') throw forbidden('Your account is suspended. Contact support.');
      if (profile.role === 'creator') req.creator = await db.one(req.app_, 'CreatorProfiles', `user_profile_id = ${profile.ROWID}`);
      if (profile.role === 'business') req.business = await db.one(req.app_, 'BusinessProfiles', `user_profile_id = ${profile.ROWID}`);
    }
    next();
  } catch (e) { next(e); }
}

const requireProfile = (req, _res, next) => (req.profile ? next() : next(forbidden('Please complete onboarding first')));

const requireRole = (...roles) => (req, _res, next) => {
  if (!req.profile) return next(forbidden('Please complete onboarding first'));
  if (!roles.includes(req.profile.role)) return next(forbidden());
  if (req.profile.role === 'creator' && !req.creator) return next(forbidden('Creator profile missing'));
  if (req.profile.role === 'business' && !req.business) return next(forbidden('Business profile missing'));
  next();
};

const isAdminEmail = (email) =>
  (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    .includes(String(email || '').toLowerCase());

module.exports = { authenticate, requireProfile, requireRole, isAdminEmail };
