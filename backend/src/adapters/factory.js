/**
 * Adapter factory - the only place in the app that knows how to turn a channel
 * TYPE into a live adapter instance.
 *
 * Call sites (all three are the same shape, which is the whole point):
 *   webhook route   -> createAdapterForChannel(channelRow, workspace)
 *   send-message    -> createAdapterForChannel(channelRow, workspace)
 *   channels route  -> createAdapterForType('messenger', workspace)
 */
import { assertAdapterExists, getAdapterClass, listAdapterCatalogue, listAdapterTypes } from './registry.js';
import { loadChannelPlugins } from '../plugins/channel.loader.js';
import { AppError } from '../middleware/error.js';

let discoveryDone = false;

/**
 * Loads adapter files from disk once, lazily.
 * Called at server boot (see server.js) so startup fails loudly on a broken file.
 *
 * This now delegates to the channel plugin loader, which discovers BOTH the
 * built-in adapters in src/adapters/ and any third-party folder in plugins/.
 */
export async function ensureAdaptersLoaded() {
  if (discoveryDone) return;
  await loadChannelPlugins();
  discoveryDone = true;
}

/**
 * Creates an adapter for a channel TYPE, without a channel row.
 * Used when listing/validating supported channels.
 * @param {'website'|'messenger'|'instagram'|'...'} type
 */
export function createAdapterForType(type, { workspace = null, channel = null } = {}) {
  const AdapterClass = assertAdapterExists(type);
  return new AdapterClass({ channel, workspace });
}

/**
 * Creates an adapter instance bound to a specific connected channel row.
 * @param {object} channel   a row from the `channels` table
 * @param {object} workspace a row from the `workspaces` table
 */
export function createAdapterForChannel(channel, workspace = null) {
  if (!channel?.type) {
    throw AppError.badRequest('Cannot build an adapter: the channel row has no type');
  }
  if (channel.status === 'disconnected') {
    throw AppError.badRequest(
      `Channel "${channel.name}" is disconnected. Reconnect it in Settings before sending messages.`,
    );
  }

  const AdapterClass = assertAdapterExists(channel.type);
  return new AdapterClass({ channel, workspace });
}

export { listAdapterTypes, listAdapterCatalogue, getAdapterClass };

export default {
  ensureAdaptersLoaded,
  createAdapterForType,
  createAdapterForChannel,
  listAdapterTypes,
  listAdapterCatalogue,
  getAdapterClass,
};
