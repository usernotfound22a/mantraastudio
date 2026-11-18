/**
 * Auth + tenant (workspace) authorisation middleware.
 *
 * Request flow for any tenant-scoped endpoint:
 *
 *   Authorization: Bearer <accessToken>
 *   X-Workspace-Id: 3                 <- which tenant the call targets
 *
 *   authenticate      -> decodes the JWT, loads the user, sets req.user
 *   loadWorkspace     -> resolves X-Workspace-Id (or :workspaceId) + membership
 *   requireRole(...)  -> optional per-route permission check
 *
 * Every SQL query in the app is then filtered by `req.workspace.id`, which is
 * how one deployment can host many isolated workspaces.
 */
import { verifyToken } from '../services/token.service.js';
import { findMembership } from '../services/membership.service.js';
import { queryOne } from '../db/pool.js';
import { AppError, asyncHandler } from './error.js';

/** Pulls the raw token out of the Authorization header. */
function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  // Fall back to a query param for the widget handshake and EventSource use.
  return req.query?.access_token || null;
}

/**
 * Requires a valid access token. Attaches `req.user`.
 */
export const authenticate = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) throw AppError.unauthorized('Missing access token');

  const payload = verifyToken(token, 'access');
  const user = await queryOne(
    `SELECT id, email, full_name, avatar_url, job_title, status
       FROM users WHERE id = ? LIMIT 1`,
    [payload.sub],
  );
  if (!user) throw AppError.unauthorized('Account no longer exists');
  if (user.status === 'disabled') throw AppError.forbidden('Account is disabled');

  req.user = user;
  req.tokenPayload = payload;
  next();
});

/**
 * Attaches `req.user` when a valid token is present, but never rejects.
 * Used by endpoints that behave differently for guests (e.g. the widget
 * bootstrap route).
 */
export const optionalAuthenticate = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) return next();
  try {
    const payload = verifyToken(token, 'access');
    const user = await queryOne(
      'SELECT id, email, full_name, avatar_url, job_title, status FROM users WHERE id = ? LIMIT 1',
      [payload.sub],
    );
    if (user && user.status === 'active') req.user = user;
  } catch {
    // An invalid token is simply treated as anonymous here.
  }
  next();
});

/**
 * Resolves the active workspace + the caller's membership.
 * Workspace id comes from `?workspaceId=`, the `X-Workspace-Id` header, or the
 * `:workspaceId` route param (in that order).
 */
export const loadWorkspace = asyncHandler(async (req, res, next) => {
  const workspaceId =
    req.params.workspaceId ?? req.query.workspaceId ?? req.headers['x-workspace-id'];

  if (!workspaceId) throw AppError.badRequest('X-Workspace-Id header is required');

  const workspace = await queryOne(
    'SELECT id, name, slug, logo_url, timezone, locale, ai_enabled, ai_auto_send, settings FROM workspaces WHERE id = ? LIMIT 1',
    [workspaceId],
  );
  if (!workspace) throw AppError.notFound('Workspace not found');

  const membership = await findMembership(req.user.id, workspace.id);
  if (!membership) throw AppError.forbidden('You are not a member of this workspace');
  if (membership.status !== 'active') {
    throw AppError.forbidden('Your membership is not active yet');
  }

  req.workspace = workspace;
  req.member = membership;
  next();
});

/**
 * Restricts a route to certain roles. Use AFTER loadWorkspace.
 *
 * The returned middleware carries `.requiresRoles` so tooling can audit which
 * routes are role-gated (see scripts/routes.js) without a database.
 *
 * @param  {...('owner'|'admin'|'agent')} roles
 */
export const requireRole = (...roles) => {
  const guard = (req, res, next) => {
    if (!req.member) return next(AppError.forbidden('Workspace context missing'));
    if (!roles.includes(req.member.role)) {
      return next(
        AppError.forbidden(`This action requires one of: ${roles.join(', ')}`),
      );
    }
    return next();
  };
  guard.requiresRoles = roles;
  return guard;
};

/** Convenience: owner or admin (settings, channels, FAQ, billing, team). */
export const requireAdmin = requireRole('owner', 'admin');
/** Convenience: owner only (delete workspace, transfer ownership). */
export const requireOwner = requireRole('owner');
