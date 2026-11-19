/**
 * Public API key service (plugin system 3, part 1).
 *
 * A customer creates a scoped key in the dashboard, then calls /api/v1 with it:
 *
 *   Authorization: Bearer sh_live_<random>
 *
 * SECURITY MODEL
 *   - Only a SHA-256 hash is stored. A database dump cannot be replayed
 *     against the API, because the plaintext half never touches the database.
 *   - The plaintext is returned exactly once, at creation time.
 *   - A short prefix is stored in plaintext so the UI can identify a key
 *     ("sh_live_a1b2...") without revealing the secret.
 *   - Lookup is by hashing the presented key, so the hot path is one indexed
 *     equality query and no plaintext key is ever compared.
 *   - Scopes are enforced per route; a key with conversations:read cannot post
 *     a message even if it guesses the URL.
 */
import crypto from 'node:crypto';
import { insertRow, selectRows, selectOne, updateRows, callRpc } from '../db/supabase.js';
import { AppError } from '../middleware/error.js';

/**
 * Every scope the public API understands. A key can only hold a subset of these,
 * so a typo in a dashboard request is rejected instead of silently granting.
 */
export const API_SCOPES = Object.freeze({
  'conversations:read': 'List and read conversations',
  'conversations:write': 'Update status, assign and resolve conversations',
  'messages:read': 'Read messages in a conversation',
  'messages:write': 'Send messages and notes',
  'contacts:read': 'List contacts and their details',
  'analytics:read': 'Read analytics summaries',
  'faqs:read': 'Read the knowledge base',
  'faqs:write': 'Create and update knowledge base entries',
});

const SCOPE_LIST = Object.keys(API_SCOPES);

/** Validates a requested scope list, returning a deduped, known-only array. */
export function assertValidScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw AppError.badRequest(`At least one scope is required. Available: ${SCOPE_LIST.join(', ')}`);
  }
  const unknown = scopes.filter((scope) => !SCOPE_LIST.includes(scope));
  if (unknown.length) {
    throw AppError.badRequest(`Unknown scope(s): ${unknown.join(', ')}. Available: ${SCOPE_LIST.join(', ')}`);
  }
  return [...new Set(scopes)];
}

/** SHA-256 hex digest - the lookup key for a presented API key. */
export const hashApiKey = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

/** The public, non-secret part of a key, e.g. "sh_live_a1b2c3". */
const keyPrefix = (raw) => raw.slice(0, 15);

/**
 * Creates a key. Returns the plaintext alongside the stored row, because this
 * is the only moment the customer can ever see it.
 *
 * @returns {{key: object, secret: string}}
 */
export async function createApiKey({ workspaceId, name, scopes, createdBy = null, expiresAt = null }) {
  const granted = assertValidScopes(scopes);

  // 24 random bytes = 192 bits. The prefix is fixed so keys are recognisable
  // in logs and error messages without being guessable.
  const secret = `sh_live_${crypto.randomBytes(24).toString('base64url')}`;

  const row = await insertRow('api_keys', {
    workspace_id: workspaceId,
    name,
    key_prefix: keyPrefix(secret),
    key_hash: hashKey(secret),
    scopes: granted,
    created_by: createdBy,
    expires_at: expiresAt,
  });

  return { key: mapApiKey(row), secret };
}

/** Lists a workspace's keys. Never returns the secret. */
export async function listApiKeys(workspaceId) {
  const rows = await selectRows('api_keys', '*', { workspace_id: workspaceId }, {
    order: [{ column: 'created_at', ascending: false }],
  });
  return rows.map(mapApiKey);
}

export async function getApiKeyById(workspaceId, id) {
  const row = await selectOne('api_keys', '*', { id, workspace_id: workspaceId });
  if (!row) throw AppError.notFound('API key not found');
  return mapApiKey(row);
}

/** Revokes a key. It is kept (not deleted) so usage history stays auditable. */
export async function revokeApiKey(workspaceId, id) {
  const result = await updateRows('api_keys', { revoked_at: new Date().toISOString() }, {
    id,
    workspace_id: workspaceId,
    revoked_at: null,
  });
  if (!result.length) {
    throw AppError.notFound('API key not found or already revoked');
  }
  return getApiKeyById(workspaceId, id);
}

/**
 * Resolves a presented plaintext key to a usable principal.
 *
 * Returns null (not an exception) for anything unusable - missing, malformed,
 * unknown, revoked or expired - so the middleware can answer with one 401 and
 * never leak which of those it was.
 */
export async function authenticateApiKey(raw) {
  if (typeof raw !== 'string' || raw.length < 20 || !raw.startsWith('sh_live_')) {
    return null;
  }

  const row = await callRpc('resolve_api_key', { p_key_hash: hashApiKey(raw) });
  if (!row) return null;

  return {
    kind: 'api_key',
    keyId: row.id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspaces?.name,
    scopes: parseScopes(row.scopes),
  };
}

/** Throws unless the key holds the given scope. */
export function requireScope(principal, scope) {
  if (!principal?.scopes?.includes(scope)) {
    throw AppError.forbidden(
      `This API key is missing the "${scope}" scope. Grant it in Settings > API keys.`,
    );
  }
}

/** Row -> API shape, with secrets removed. */
function mapApiKey(row) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.key_prefix,
    scopes: parseScopes(row.scopes),
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

/** PostgreSQL JSONB values are parsed, but be defensive about both forms. */
function parseScopes(value) {
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}
