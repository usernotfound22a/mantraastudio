/**
 * Social account persistence for Meta/Facebook/Instagram publishing flows.
 *
 * This is the API-side foundation for Phase 2: a dedicated table lets us store
 * encrypted platform tokens separately from the inbox channel rows, without
 * shuffling the present support-focused channel schema.
 */
import { selectRows, selectOne, insertRow, updateRows } from '../db/supabase.js';
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
  const rows = await selectRows('social_accounts', '*', { workspace_id: workspaceId }, {
    order: [{ column: 'status', ascending: false }, { column: 'created_at', ascending: false }],
  });
  return rows.map(toPublicSocialAccount);
}

export async function findSocialAccountByExternalId(workspaceId, platform, externalId) {
  return selectOne('social_accounts', '*', { workspace_id: workspaceId, platform, external_id: externalId });
}

export async function getSocialAccountById(id) {
  return selectOne('social_accounts', '*', { id });
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
    await updateRows('social_accounts', {
      name,
      avatar_url: avatarUrl,
      encrypted_access_token: encryptedToken ?? existing.encrypted_access_token,
      token_expires_at: tokenExpiresAt,
      scopes: normalizedScopes,
      status,
      metadata,
      connected_by: connectedBy,
    }, { id: existing.id });
    return getSocialAccountById(existing.id);
  }

  return insertRow('social_accounts', {
    workspace_id: workspaceId,
    platform,
    external_id: externalId,
    name,
    avatar_url: avatarUrl,
    encrypted_access_token: encryptedToken,
    token_expires_at: tokenExpiresAt,
    scopes: normalizedScopes,
    status,
    connected_by: connectedBy,
    metadata,
  });
}

export async function markSocialAccountNeedsReconnect(accountId, reason = 'token expired') {
  const current = await getSocialAccountById(accountId);
  if (!current) return null;

  await updateRows('social_accounts', {
    status: 'needs_reconnect',
    metadata: {
      ...(current.metadata ?? {}),
      reconnectReason: reason,
      lastReconnectCheck: new Date().toISOString(),
    },
  }, { id: accountId });

  return getSocialAccountById(accountId);
}
