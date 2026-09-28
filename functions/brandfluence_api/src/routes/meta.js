'use strict';
const router = require('express').Router();
const db = require('../lib/db');
const { wrap } = require('../lib/errors');
const { autoSyncPlatforms } = require('../services/social');

// GET /meta/categories?group=creator|business|creator_type
router.get('/categories', wrap(async (req, res) => {
  const where = ['is_active = true'];
  if (req.query.group) where.push(`category_group = ${db.str(req.query.group)}`);
  const rows = await db.select(req.app_, 'Categories', where.join(' AND '), 'ORDER BY sort_order ASC');
  res.json({ data: rows.map((r) => ({ id: r.ROWID, name: r.name, slug: r.slug, group: r.category_group })) });
}));

// Static option lists used by forms
router.get('/options', (_req, res) => {
  res.json({
    platforms: ['instagram', 'youtube', 'facebook', 'x', 'linkedin', 'twitch', 'other'],
    service_types: {
      instagram: ['story', 'static_post', 'carousel', 'reel', 'reel_story', 'product_review', 'live'],
      youtube: ['short', 'dedicated_video', 'integrated_mention', 'live'],
      facebook: ['post', 'video', 'story'],
      other: ['post', 'video'],
    },
    rate_kinds: ['content', 'usage_rights', 'whitelisting', 'paid_ads_rights', 'exclusivity', 'extra_revision', 'travel', 'event_appearance'],
    campaign_goals: ['brand_awareness', 'product_launch', 'sales', 'app_installs', 'event', 'engagement'],
    promotion_types: ['product', 'service', 'app', 'event', 'brand_awareness'],
    dispute_types: ['late_delivery', 'not_delivered', 'quality', 'brief_not_followed', 'payment', 'other'],
    auto_sync: autoSyncPlatforms(),
  });
});

module.exports = router;
