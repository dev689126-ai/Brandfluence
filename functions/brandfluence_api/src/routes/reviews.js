'use strict';
/** Two-way structured reviews after completion (section 25). */
const router = require('express').Router();
const db = require('../lib/db');
const { wrap, badRequest, conflict } = require('../lib/errors');
const { requireRole } = require('../lib/auth');
const { STATUS, loadDealFor, participants } = require('../services/dealMachine');
const { notify } = require('../services/notify');

// Business rates creator on quality/communication/professionalism/timeliness.
// Creator rates business on communication/payment/brief/professionalism.
const SCORES = {
  business: ['score_quality', 'score_communication', 'score_professionalism', 'score_timeliness'],
  creator: ['score_communication', 'score_payment', 'score_brief', 'score_professionalism'],
};

router.post('/deals/:id/reviews', requireRole('business', 'creator'), wrap(async (req, res) => {
  const app = req.app_;
  const { deal, side } = await loadDealFor(req, req.params.id);
  if (deal.status !== STATUS.COMPLETED) throw conflict('Reviews open once the deal is completed');
  if (await db.one(app, 'Reviews', `deal_id = ${deal.ROWID} AND reviewer_role = ${db.str(side)}`)) throw conflict('You have already reviewed this deal');

  const row = {};
  for (const k of SCORES[side]) {
    const v = parseInt((req.body || {})[k], 10);
    if (!(v >= 1 && v <= 5)) throw badRequest(`Rate ${k.replace('score_', '')} from 1 to 5`);
    row[k] = v;
  }
  const values = Object.values(row);
  const overall = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
  const reviewerId = side === 'business' ? deal.business_id : deal.creator_id;
  const revieweeId = side === 'business' ? deal.creator_id : deal.business_id;

  const review = await db.insert(app, 'Reviews', {
    deal_id: deal.ROWID, reviewer_role: side, reviewer_id: reviewerId, reviewee_id: revieweeId,
    ...row, overall, comment: req.body.comment ? String(req.body.comment).slice(0, 2000) : undefined,
    is_public: req.body.is_public !== false,
  });

  // Refresh the reviewee's average rating
  const all = await db.select(app, 'Reviews', `reviewee_id = ${db.id(revieweeId)} AND reviewer_role = ${db.str(side)}`, 'LIMIT 0, 300');
  const avg = Math.round((all.reduce((a, r) => a + Number(r.overall), 0) / all.length) * 100) / 100;
  await db.update(app, side === 'business' ? 'CreatorProfiles' : 'BusinessProfiles', { ROWID: revieweeId, avg_rating: avg });

  const p = await participants(app, deal);
  await notify(app, side === 'business' ? p.creatorUserId : p.businessUserId, {
    type: 'review_received', dealId: deal.ROWID, link: `/deals/${deal.ROWID}`,
    title: `You received a ${overall}★ review`, body: `For deal ${deal.deal_number}`, email: false,
  });
  res.status(201).json(review);
}));

module.exports = router;
