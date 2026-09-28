'use strict';
/**
 * Presigned Stratus URLs. Files go straight from the browser to storage (no size load on the function).
 * Key layout decides who may read a file:
 *   public/<profileId>/...     avatars, logos, portfolio  (any signed-in user)
 *   deals/<dealId>/...         drafts, chat attachments, dispute evidence (deal participants + admin)
 *   kyc/<profileId>/...        verification documents (owner + admin)       [docs bucket]
 *   contracts/<dealId>/...     generated agreements (participants + admin)  [docs bucket]
 */
const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { wrap, badRequest, forbidden } = require('../lib/errors');
const { requireProfile } = require('../lib/auth');
const { loadDealFor } = require('../services/dealMachine');
const { signedUrl, putObject, getObject, safeName } = require('../services/storage');

const MEDIA = () => process.env.MEDIA_BUCKET;
const DOCS = () => process.env.DOCS_BUCKET;
const ALLOWED_TYPES = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|quicktime|webm)|application\/pdf)$/;

const MAX_BYTES = 50 * 1024 * 1024;

// Decide where a new file goes, and check the caller may put it there
async function placeFor(req, { purpose, filename, content_type, deal_id }) {
  if (content_type && !ALLOWED_TYPES.test(content_type)) throw badRequest('Only images, videos (mp4/mov/webm) and PDFs are allowed');
  const stamp = `${Date.now()}-${safeName(filename)}`;
  if (['avatar', 'logo', 'portfolio'].includes(purpose)) return { bucket: MEDIA(), key: `public/${req.profile.ROWID}/${purpose}/${stamp}` };
  if (['submission', 'attachment', 'evidence'].includes(purpose)) {
    const { deal } = await loadDealFor(req, deal_id);
    return { bucket: MEDIA(), key: `deals/${deal.ROWID}/${purpose}/${stamp}` };
  }
  if (purpose === 'kyc') return { bucket: DOCS(), key: `kyc/${req.profile.ROWID}/${stamp}` };
  throw badRequest('Unknown upload purpose');
}

// Decide which bucket holds an existing file, and check the caller may read it
async function checkRead(req, key) {
  if (!key || key.includes('..')) throw badRequest('Invalid key');
  const parts = key.split('/');
  const isAdmin = req.profile.role === 'admin';
  if (parts[0] === 'public') return MEDIA();
  if (parts[0] === 'deals') { await loadDealFor(req, parts[1]); return MEDIA(); }
  if (parts[0] === 'contracts') { await loadDealFor(req, parts[1]); return DOCS(); }
  if (parts[0] === 'kyc') { if (!isAdmin && parts[1] !== String(req.profile.ROWID)) throw forbidden(); return DOCS(); }
  throw badRequest('Invalid key');
}

/* Upload through the API: POST /uploads/file?purpose=avatar&filename=me.jpg[&deal_id=]  body = raw file bytes */
router.post('/file', requireProfile, express.raw({ type: () => true, limit: MAX_BYTES }), wrap(async (req, res) => {
  const contentType = String(req.get('content-type') || '').split(';')[0];
  const body = req.body;
  if (!Buffer.isBuffer(body) || !body.length) throw badRequest('The file is empty');
  const { bucket, key } = await placeFor(req, { ...req.query, content_type: contentType });
  await putObject(req.app_, bucket, key, body, contentType);
  res.status(201).json({ key, size: body.length });
}));

/* Read through the API: GET /uploads/file?key=...  (works directly as <img src> / <video src>) */
router.get('/file', requireProfile, wrap(async (req, res) => {
  const key = String(req.query.key || '');
  const bucketName = await checkRead(req, key);
  const obj = await getObject(req.app_, bucketName, key);
  const ext = (key.split('.').pop() || '').toLowerCase();
  const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', pdf: 'application/pdf', html: 'text/html' };
  res.set('Content-Type', TYPES[ext] || 'application/octet-stream');
  res.set('Cache-Control', 'private, max-age=600');
  if (obj && typeof obj.pipe === 'function') return obj.pipe(res);
  res.send(Buffer.isBuffer(obj) ? obj : Buffer.from(obj));
}));

/* Older presigned-URL route, kept for large files once bucket CORS is configured */
router.post('/url', requireProfile, wrap(async (req, res) => {
  const { bucket, key } = await placeFor(req, req.body || {});
  const url = await signedUrl(req.app_, bucket, key, 'PUT', 900);
  res.json({ upload_url: url, key, method: 'PUT', expires_in: 900 });
}));

router.get('/url', requireProfile, wrap(async (req, res) => {
  const key = String(req.query.key || '');
  if (!key || key.includes('..')) throw badRequest('Invalid key');
  const parts = key.split('/');
  const isAdmin = req.profile.role === 'admin';
  let bucket = MEDIA();
  if (parts[0] === 'public') { /* any signed-in user */ }
  else if (parts[0] === 'deals') await loadDealFor(req, parts[1]);
  else if (parts[0] === 'contracts') { bucket = DOCS(); await loadDealFor(req, parts[1]); }
  else if (parts[0] === 'kyc') { bucket = DOCS(); if (!isAdmin && parts[1] !== String(req.profile.ROWID)) throw forbidden(); }
  else throw badRequest('Invalid key');
  const url = await signedUrl(req.app_, bucket, key, 'GET', 600);
  res.json({ url, expires_in: 600 });
}));

module.exports = router;
