/**
 * Channel persistence.
 *
 * A `channels` row is one *connection* (a Facebook Page, an IG account, the
 * website widget). The row's `type` selects the adapter; `config` holds
 * everything channel-specific, which is why the schema never needs changing
 * when a new channel is added.
 */
import { selectRows, selectOne, insertRow, updateRows, deleteRows, callRpc } from '../db/supabase.js';
import { AppError } from '../middleware/error.js';
import { childLogger } from '../config/logger.js';

const log = childLogger('channels');

/** Adapter instance config keys that must never be returned to a browser. */
const SECRET_KEYS = ['accessToken', 'appSecret', 'verifyToken', 'clientSecret', 'refreshToken'];

/** Strips secrets and returns a UI-safe channel object. */
export function toPublicChannel(row) {
  if (!row) return null;
  const config = row.config ?? {};
  const safeConfig = Object.fromEntries(
    Object.entries(config).filter(([key]) => !SECRET_KEYS.includes(key)),
  );

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type,
    name: row.name,
    externalId: row.external_id,
    status: row.status,
    isDefault: Boolean(row.is_default),
    config: safeConfig,
    /** Lets the settings screen show "•••••• 4hf9…" instead of nothing. */
    hasCredentials: SECRET_KEYS.filter((key) => Boolean(config[key])),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Internal helper: the full row including secrets (server side only). */
export const getChannelById = (channelId) =>
  selectOne('channels', '*', { id: channelId });

/** All channels of a workspace, newest first. */
export async function listChannelsForWorkspace(workspaceId) {
  const rows = await selectRows('channels', '*,users(full_name)', { workspace_id: workspaceId }, {
    order: [{ column: 'is_default', ascending: false }, { column: 'created_at', ascending: false }],
  });
  return rows.map(({ users, ...row }) => ({ ...row, connected_by_name: users?.full_name ?? null }));
}

/**
 * Finds a connected channel by its type + remote account id.
 * This is how a webhook is routed to the right adapter: Meta tells us the
 * page id, we look up which workspace owns it.
 */
export const findChannelByExternalId = (type, externalId) =>
  selectOne('channels', '*', { type, external_id: externalId });

/** Website widget lookup by its public key. */
export const findWebsiteChannelByWidgetKey = (widgetKey) =>
  callRpc('lookup_widget_channel', { p_widget_key: widgetKey });

/** Creates a channel row. Enforces "one remote account per workspace". */
export async function createChannel({
  workspaceId,
  type,
  name,
  externalId = null,
  config = {},
  isDefault = false,
  connectedBy = null,
}) {
  try {
    const row = await insertRow('channels', {
      workspace_id: workspaceId,
      type,
      name,
      external_id: externalId,
       is_default: isDefault ? 1 : 0,
      config,
      connected_by: connectedBy,
    });
    log.info({ workspaceId, type, channelId: row.id }, 'Channel created');
    return row;
  } catch (error) {
    if (error.code === '23505') {
      throw AppError.conflict(
        `That ${type} account is already connected to a SocialHub workspace`,
      );
    }
    throw error;
  }
}

/** Updates config/secrets without losing untouched keys. */
export async function updateChannelConfig(channelId, patch) {
  const current = await getChannelById(channelId);
  if (!current) throw AppError.notFound('Channel not found');

  const merged = { ...(current.config ?? {}), ...patch };
  await updateRows('channels', { config: merged }, { id: channelId });
  return getChannelById(channelId);
}

/** Replaces the config wholesale (used by the OAuth callback). */
export const replaceChannelConfig = (channelId, config) =>
  updateRows('channels', { config }, { id: channelId });

export const setChannelStatus = (channelId, status, lastError = null) =>
  updateRows('channels', { status, last_error: lastError }, { id: channelId });

/** Deletes a channel and (via FK cascade) its conversations and messages. */
export const deleteChannel = (channelId) =>
  deleteRows('channels', { id: channelId });

/** Generates the public widget key for a website channel. */
export const generateWidgetKey = (workspaceId) =>
  `wk_${workspaceId}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
