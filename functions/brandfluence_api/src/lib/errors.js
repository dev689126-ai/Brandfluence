'use strict';
class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
const badRequest = (m, d) => new HttpError(400, m, d);
const unauthorized = (m = 'Please sign in') => new HttpError(401, m);
const forbidden = (m = 'You do not have access to this') => new HttpError(403, m);
const notFound = (m = 'Not found') => new HttpError(404, m);
const conflict = (m) => new HttpError(409, m);

// Wrap async route handlers so thrown errors reach the error middleware
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) console.error('[brandfluence_api]', req.method, req.originalUrl, err);
  res.status(status).json({
    status: 'error',
    message: status >= 500 ? 'Something went wrong. Please try again.' : err.message,
    details: status >= 500 ? undefined : err.details,
  });
}

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict, wrap, errorHandler };
