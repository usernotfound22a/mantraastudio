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
import { execute, query, queryOne } from '../db/pool.js';
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
const hashKey = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

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

  // INSERT goes through execute() (which returns { insertId }); queryOne() is
  // for SELECTs and would return null here.
  const result = await execute(
    // MariaDB has no CAST(... AS JSON) (that is MySQL-only). Passing the
    // JSON text directly to a JSON column works on both and is what the rest
    // of this codebase already does for keywords/tags/metadata.
    `INSERT INTO api_keys (workspace_id, name, key_prefix, key_hash, scopes, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      workspaceId,
      name,
      keyPrefix(secret),
      hashKey(secret),
      JSON.stringify(granted),
      createdBy,
      expiresAt,
    ],
  );

  return { key: await getApiKeyById(workspaceId, result.insertId), secret };
}

/** Lists a workspace's keys. Never returns the secret. */
export async function listApiKeys(workspaceId) {
  const rows = await query(
    `SELECT * FROM api_keys WHERE workspace_id = ? ORDER BY created_at DESC`,
    [workspaceId],
  );
  return rows.map(mapApiKey);
}

export async function getApiKeyById(workspaceId, id) {
  const row = await queryOne('SELECT * FROM api_keys WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
  if (!row) throw AppError.notFound('API key not found');
  return mapApiKey(row);
}

/** Revokes a key. It is kept (not deleted) so usage history stays auditable. */
export async function revokeApiKey(workspaceId, id) {
  const result = await execute(
    'UPDATE api_keys SET revoked_at = NOW() WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL',
    [id, workspaceId],
  );
  if (!result.affectedRows) {
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

  const row = await queryOne(
    `SELECT k.*, w.name AS workspace_name
       FROM api_keys k
       JOIN workspaces w ON w.id = k.workspace_id
      WHERE k.key_hash = ?
        AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at > NOW())`,
    [hashKey(raw)],
  );
  if (!row) return null;

  // Best-effort usage stamp. A failure here must not fail the request.
  execute('UPDATE api_keys SET last_used_at = NOW() WHERE id = ?', [row.id]).catch(() => {});

  return {
    kind: 'api_key',
    keyId: row.id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
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

/** MySQL JSON columns come back parsed, but be defensive about both forms. */
function parseScopes(value) {
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}
