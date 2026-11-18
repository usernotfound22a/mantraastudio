/**
 * Reusable rate limiters.
 *
 * Limits live in the DB-less layer (in-memory) which is fine for a single-node
 * FYP deployment. If you ever run multiple API instances, swap the store for
 * `rate-limit-redis` - the middleware signature does not change.
 */
import rateLimit from 'express-rate-limit';
import { AppError } from './error.js';

const handler = (message) => (req, res, next) =>
  next(AppError.tooManyRequests(message));

/** 20 tries / 15 min per IP: protects login + register from brute force. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: handler('Too many attempts. Please try again in a few minutes.'),
});

/** 300 requests / minute per IP: general API safety net. */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: handler('Slow down a little.'),
});

/**
 * Webhooks must NOT be rate limited: Meta retries aggressively and a 429 makes
 * it re-deliver. We only cap the body size (see webhook route).
 */
export const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: handler(),
});
