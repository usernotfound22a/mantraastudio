/**
 * Public API authentication (plugin system 3).
 *
 * Separate from the dashboard's JWT auth on purpose:
 *   - a dashboard token is scoped to a USER and carries role permissions
 *   - an API key is scoped to a WORKSPACE and carries explicit scopes
 *
 * Mixing them would mean one compromised integration token could act as a
 * person. Here an API key can only do what its scopes allow, and it can never
 * reach a workspace other than the one it was issued for.
 */
import { asyncHandler, AppError } from './error.js';
import { authenticateApiKey, hashApiKey, requireScope } from '../services/apikey.service.js';
import { createApiKeyClient, withSupabaseClient } from '../db/supabase.js';

/** Pulls the raw key out of `Authorization: Bearer ...` or `X-Api-Key`. */
function extractKey(req) {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  return req.get('x-api-key')?.trim() || null;
}

/**
 * Requires a valid API key. Attaches `req.api` (the principal) and
 * `req.workspaceId`, so route handlers can scope every query by workspace.
 */
export const authenticateApiKeyMiddleware = asyncHandler(async (req, res, next) => {
  const raw = extractKey(req);
  const principal = await authenticateApiKey(raw);

  if (!principal) {
    // One generic message for missing/malformed/unknown/revoked/expired, so a
    // caller cannot use the response to probe which keys exist.
    throw AppError.unauthorized('A valid API key is required. Send it as: Authorization: Bearer sh_live_...');
  }

  req.api = principal;
  // Route handlers use this exactly like req.workspace.id elsewhere in the app.
  req.workspaceId = principal.workspaceId;
  // API-key principals are workspace-bound and every route additionally checks
  // its declared scopes. This context is isolated to the dedicated v1 router;
  // dashboard routes continue to use the caller's Auth JWT and RLS.
  withSupabaseClient(createApiKeyClient(hashApiKey(raw)), next);
});

/** Requires a specific scope on the presented key. */
export const requireApiScope = (scope) => (req, res, next) => {
  requireScope(req.api, scope);
  next();
};
