'use strict';
/**
 * Razorpay Route integration (marketplace payments with held transfers).
 * Flow: Business pays an Order → transfer to creator's linked account is created ON HOLD
 *       → released when the business approves / auto-release window passes / admin resolves.
 * Docs: https://razorpay.com/docs/payments/route/
 */
const crypto = require('crypto');
const { HttpError } = require('../lib/errors');

const BASE = 'https://api.razorpay.com/v1';

function configured() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

async function call(method, path, body) {
  if (!configured()) throw new HttpError(503, 'Payments are not configured yet (Razorpay keys missing)');
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.description) || `Razorpay error ${res.status}`;
    throw new HttpError(502, msg);
  }
  return data;
}

const paise = (rupees) => Math.round(Number(rupees) * 100);

/** Create an order whose captured amount auto-transfers creatorPayout to the creator, held. */
function createOrder({ amount, receipt, creatorAccountId, creatorPayout, notes }) {
  return call('POST', '/orders', {
    amount: paise(amount),
    currency: 'INR',
    receipt,
    notes,
    transfers: [{
      account: creatorAccountId,
      amount: paise(creatorPayout),
      currency: 'INR',
      on_hold: 1,
      notes,
    }],
  });
}

const paymentTransfers = (paymentId) => call('GET', `/payments/${encodeURIComponent(paymentId)}/transfers`);
const releaseTransfer = (transferId) => call('PATCH', `/transfers/${encodeURIComponent(transferId)}`, { on_hold: 0 });
const reverseTransfer = (transferId, amount) =>
  call('POST', `/transfers/${encodeURIComponent(transferId)}/reversals`, amount ? { amount: paise(amount) } : {});
const refundPayment = (paymentId, amount) =>
  call('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, amount ? { amount: paise(amount) } : {});

function verifyCheckoutSignature(orderId, paymentId, signature) {
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
    .update(`${orderId}|${paymentId}`).digest('hex');
  return safeEqual(expected, signature);
}

function verifyWebhookSignature(rawBody, signature) {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) return false;
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
  return safeEqual(expected, signature);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { configured, createOrder, paymentTransfers, releaseTransfer, reverseTransfer, refundPayment,
  verifyCheckoutSignature, verifyWebhookSignature };
