/**
 * JWT issuing + verification.
 *
 * Two tokens per session:
 *   access  - short lived (15m), sent on every API call via
 *             `Authorization: Bearer <token>`
 *   refresh - long lived (7d), sent only to /api/auth/refresh so the SPA can
 *             silently renew without the user logging in again.
 *
 * The token payload carries `type` ('access' | 'refresh') and we reject a
 * refresh token used as an access token (and vice versa) - a classic token
 * confusion bug that is easy to miss in a demo and easy to prevent here.
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AppError } from '../middleware/error.js';

const ISSUER = 'socialhub';
const AUDIENCE = 'socialhub-api';

/** Signs a token for a user. `ttl` is a jsonwebtoken string like '15m'. */
function sign(user, type, ttl) {
  return jwt.sign(
    {
      sub: String(user.id),
      email: user.email,
      name: user.full_name,
      role: user.role ?? null, // set on refresh tokens for convenience
      type,
    },
    env.JWT_SECRET,
    { expiresIn: ttl, issuer: ISSUER, audience: AUDIENCE },
  );
}

export const signAccessToken = (user) => sign(user, 'access', env.JWT_ACCESS_TTL);
export const signRefreshToken = (user) => sign(user, 'refresh', env.JWT_REFRESH_TTL);

/**
 * Verifies a token and returns its payload.
 * @param {string} token
 * @param {'access'|'refresh'} expectedType
 */
export function verifyToken(token, expectedType) {
  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET, { issuer: ISSUER, audience: AUDIENCE });
  } catch (error) {
    if (error.name === 'TokenExpiredError') throw AppError.unauthorized('Session expired');
    throw AppError.unauthorized('Invalid token');
  }
  if (payload.type !== expectedType) {
    throw AppError.unauthorized(`Expected a ${expectedType} token`);
  }
  return payload;
}

/** Convenience for clients: a brand new token pair. */
export const issueTokenPair = (user) => ({
  accessToken: signAccessToken(user),
  refreshToken: signRefreshToken(user),
  expiresIn: env.JWT_ACCESS_TTL,
});

/** Opaque random string (used for widget keys, invite codes, ...). */
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('hex');
