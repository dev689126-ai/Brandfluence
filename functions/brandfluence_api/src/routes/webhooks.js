'use strict';
/** Razorpay webhook – mounted with express.raw() so the signature can be verified on the exact bytes. */
const router = require('express').Router();
const catalyst = require('zcatalyst-sdk-node');
const db = require('../lib/db');
const rzp = require('../services/razorpay');
const { markCaptured } = require('./payments');
const { activateOnPayment } = require('./plans');
const { audit } = require('../services/audit');

router.post('/razorpay', async (req, res) => {
  const raw = req.body instanceof Buffer ? req.body : Buffer.from(req.body || '');
  if (!rzp.verifyWebhookSignature(raw, req.get('x-razorpay-signature'))) return res.status(400).json({ ok: false });
  try {
    const app = catalyst.initialize(req, { scope: 'admin' });
    const evt = JSON.parse(raw.toString('utf8'));
    if (evt.event === 'payment.captured' || evt.event === 'order.paid') {
      const pay = evt.payload.payment && evt.payload.payment.entity;
      if (pay && pay.order_id) {
        const payment = await db.one(app, 'Payments', `gateway_order_id = ${db.str(pay.order_id)}`);
        if (payment) await markCaptured(app, payment, pay.id, null);
        else {
          // Creator Pro plan payment
          const sub = await db.one(app, 'CreatorSubscriptions', `gateway_order_id = ${db.str(pay.order_id)}`);
          if (sub) await activateOnPayment(app, sub, pay.id, null);
        }
      }
    }
    if (evt.event === 'payment.failed') {
      const pay = evt.payload.payment.entity;
      const payment = await db.one(app, 'Payments', `gateway_order_id = ${db.str(pay.order_id)}`);
      if (payment && payment.status === 'created') await audit(app, { entityType: 'payment', entityId: payment.ROWID, action: 'payment_failed', details: { reason: pay.error_description } });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('webhook error', e);
    res.status(500).json({ ok: false }); // Razorpay will retry
  }
});

module.exports = router;
