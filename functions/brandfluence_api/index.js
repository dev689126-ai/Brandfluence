'use strict';
/**
 * Brandfluence API — Catalyst Advanced I/O function (modular monolith).
 * Base URL: https://<project-domain>/server/brandfluence_api/
 */
const express = require('express');
const { authenticate } = require('./src/lib/auth');
const { errorHandler, notFound } = require('./src/lib/errors');
const { securityHeaders, rateLimit } = require('./src/lib/security');

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(securityHeaders);

// Webhooks need the raw body for signature checks → mount BEFORE express.json()
app.use('/webhooks', express.raw({ type: '*/*', limit: '1mb' }), require('./src/routes/webhooks'));
app.use(express.json({ limit: '1mb' }));

// Unauthenticated
app.get('/health', (_req, res) => res.json({ ok: true, service: 'brandfluence_api', time: new Date().toISOString() }));
app.use('/internal', require('./src/routes/internal'));

// Everything below requires a signed-in Catalyst user
app.use(authenticate);
app.use(rateLimit);
app.use('/me', require('./src/routes/me'));
app.use('/meta', require('./src/routes/meta'));
app.use('/creators', require('./src/routes/creators'));
app.use('/businesses', require('./src/routes/businesses'));
app.use('/discover', require('./src/routes/discovery'));
app.use('/deals', require('./src/routes/deals'));
app.use('/', require('./src/routes/content'));       // /deals/:id/start, /deliverables/*, /submissions/*
app.use('/', require('./src/routes/messages'));      // /deals/:id/messages
app.use('/', require('./src/routes/payments'));      // /deals/:id/payment-order, /payments/verify, /deals/:id/release, /wallet
app.use('/', require('./src/routes/reviews'));       // /deals/:id/reviews
app.use('/', require('./src/routes/disputes'));      // /deals/:id/disputes
app.use('/notifications', require('./src/routes/notifications'));
app.use('/uploads', require('./src/routes/uploads'));
app.use('/admin', require('./src/routes/admin'));

app.use((_req, _res, next) => next(notFound('Endpoint not found')));
app.use(errorHandler);

module.exports = app;
