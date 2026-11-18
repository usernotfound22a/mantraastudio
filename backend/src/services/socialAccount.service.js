/**
 * Social account persistence for Meta/Facebook/Instagram publishing flows.
 *
 * This is the API-side foundation for Phase 2: a dedicated table lets us store
 * encrypted platform tokens separately from the inbox channel rows, without
 * shuffling the present support-focused channel schema.
 */
import { query, queryOne, execute } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { decryptSecret, encryptSecret } from './crypto.service.js';

export function toPublicSocialAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    platform: row.platform,
    externalId: row.external_id,
    name: row.name,
    avatarUrl: row.avatar_url,
    tokenExpiresAt: row.token_expires_at,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    status: row.status,
    connectedBy: row.connected_by,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listSocialAccountsForWorkspace(workspaceId) {
  const rows = await query(
    `SELECT * FROM social_accounts WHERE workspace_id = ? ORDER BY status DESC, created_at DESC`,
    [workspaceId],
  );
  return rows.map(toPublicSocialAccount);
}

export async function findSocialAccountByExternalId(workspaceId, platform, externalId) {
  return queryOne(
    'SELECT * FROM social_accounts WHERE workspace_id = ? AND platform = ? AND external_id = ? LIMIT 1',
    [workspaceId, platform, externalId],
  );
}

export async function getSocialAccountById(id) {
  return queryOne('SELECT * FROM social_accounts WHERE id = ? LIMIT 1', [id]);
}

export function getDecryptedAccessToken(account) {
  if (!account || !account.encrypted_access_token) {
    return null;
  }
  try {
    return decryptSecret(account.encrypted_access_token);
  } catch (error) {
    throw AppError.serviceUnavailable('Stored social account token could not be decrypted');
  }
}

export async function upsertSocialAccount({
  workspaceId,
  platform,
  externalId,
  name,
  avatarUrl = null,
  accessToken = null,
  tokenExpiresAt = null,
  scopes = [],
  status = 'connected',
  connectedBy = null,
  metadata = {},
}) {
  if (!workspaceId || !platform || !externalId || !name) {
    throw AppError.badRequest('Social account fields are incomplete');
  }

  const encryptedToken = accessToken ? encryptSecret(accessToken) : null;
  const normalizedScopes = Array.isArray(scopes) ? scopes : [];
  const existing = await findSocialAccountByExternalId(workspaceId, platform, externalId);

  if (existing) {
    await execute(
      `UPDATE social_accounts
          SET name = ?, avatar_url = ?, encrypted_access_token = ?, token_expires_at = ?, scopes = ?, status = ?, metadata = ?, connected_by = ?
        WHERE id = ?`,
      [
        name,
        avatarUrl,
        encryptedToken ?? existing.encrypted_access_token,
        tokenExpiresAt,
        JSON.stringify(normalizedScopes),
        status,
        JSON.stringify(metadata),
        connectedBy,
        existing.id,
      ],
    );
    return getSocialAccountById(existing.id);
  }

  const result = await execute(
    `INSERT INTO social_accounts (
      workspace_id, platform, external_id, name, avatar_url,
      encrypted_access_token, token_expires_at, scopes, status, connected_by, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      workspaceId,
      platform,
      externalId,
      name,
      avatarUrl,
      encryptedToken,
      tokenExpiresAt,
      JSON.stringify(normalizedScopes),
      status,
      connectedBy,
      JSON.stringify(metadata),
    ],
  );

  return getSocialAccountById(result.insertId);
}

export async function markSocialAccountNeedsReconnect(accountId, reason = 'token expired') {
  const current = await getSocialAccountById(accountId);
  if (!current) return null;

  await execute(
    `UPDATE social_accounts
        SET status = 'needs_reconnect', metadata = ?
      WHERE id = ?`,
    [JSON.stringify({ ...(current.metadata ?? {}), reconnectReason: reason, lastReconnectCheck: new Date().toISOString() }), accountId],
  );

  return getSocialAccountById(accountId);
}
