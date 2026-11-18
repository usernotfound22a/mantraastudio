/**
 * Channel persistence.
 *
 * A `channels` row is one *connection* (a Facebook Page, an IG account, the
 * website widget). The row's `type` selects the adapter; `config` holds
 * everything channel-specific, which is why the schema never needs changing
 * when a new channel is added.
 */
import { query, queryOne, execute } from '../db/pool.js';
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
  queryOne('SELECT * FROM channels WHERE id = ? LIMIT 1', [channelId]);

/** All channels of a workspace, newest first. */
export const listChannelsForWorkspace = (workspaceId) =>
  query(
    `SELECT c.*, u.full_name AS connected_by_name
       FROM channels c
       LEFT JOIN users u ON u.id = c.connected_by
      WHERE c.workspace_id = ?
      ORDER BY c.is_default DESC, c.created_at DESC`,
    [workspaceId],
  );

/**
 * Finds a connected channel by its type + remote account id.
 * This is how a webhook is routed to the right adapter: Meta tells us the
 * page id, we look up which workspace owns it.
 */
export const findChannelByExternalId = (type, externalId) =>
  queryOne('SELECT * FROM channels WHERE type = ? AND external_id = ? LIMIT 1', [type, externalId]);

/** Website widget lookup by its public key. */
export const findWebsiteChannelByWidgetKey = (widgetKey) =>
  queryOne(
    "SELECT * FROM channels WHERE type = 'website' AND JSON_UNQUOTE(JSON_EXTRACT(config, '$.widgetKey')) = ? LIMIT 1",
    [widgetKey],
  );

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
    const result = await execute(
      `INSERT INTO channels (workspace_id, type, name, external_id, is_default, config, connected_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, type, name, externalId, isDefault ? 1 : 0, JSON.stringify(config), connectedBy],
    );
    log.info({ workspaceId, type, channelId: result.insertId }, 'Channel created');
    return getChannelById(result.insertId);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
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
  await execute('UPDATE channels SET config = ? WHERE id = ?', [JSON.stringify(merged), channelId]);
  return getChannelById(channelId);
}

/** Replaces the config wholesale (used by the OAuth callback). */
export const replaceChannelConfig = (channelId, config) =>
  execute('UPDATE channels SET config = ? WHERE id = ?', [JSON.stringify(config), channelId]);

export const setChannelStatus = (channelId, status, lastError = null) =>
  execute('UPDATE channels SET status = ?, last_error = ? WHERE id = ?', [
    status,
    lastError,
    channelId,
  ]);

/** Deletes a channel and (via FK cascade) its conversations and messages. */
export const deleteChannel = (channelId) =>
  execute('DELETE FROM channels WHERE id = ?', [channelId]);

/** Generates the public widget key for a website channel. */
export const generateWidgetKey = (workspaceId) =>
  `wk_${workspaceId}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
