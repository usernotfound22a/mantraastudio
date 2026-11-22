import { MessengerAdapter } from '../adapters/MessengerAdapter.js';
import { listChannelsForWorkspace } from './channels.service.js';
import { ingestInboundMessage } from './conversation.service.js';
import { childLogger } from '../config/logger.js';

const log = childLogger('meta-inbox-sync');
const SYNC_INTERVAL_MS = 15_000;
const lastSyncAt = new Map();

const toGraphMessages = (conversation) =>
  [...(conversation?.messages?.data ?? [])].sort(
    (a, b) => new Date(a.created_time).getTime() - new Date(b.created_time).getTime(),
  );

const findCustomer = (conversation, pageId) =>
  (conversation?.participants?.data ?? []).find((participant) => String(participant.id) !== String(pageId));

const normalizeGraphMessage = ({ item, conversation, channel, pageId, customer }) => {
  const text = String(item.message ?? '').trim();
  if (!item.id || !text) return null;

  const externalId = String(customer?.id ?? conversation.id);

  return {
    externalMessageId: String(item.id),
    conversationExternalId: externalId,
    contact: {
      externalId,
      name: customer?.name ?? null,
      avatarUrl: null,
      email: null,
      locale: null,
    },
    content: {
      text,
      attachments: [],
      quickReplies: null,
      postbackPayload: null,
    },
    timestamp: new Date(item.created_time).toISOString(),
    metadata: {
      channel: 'messenger',
      pageId,
      source: 'graph-inbox-sync',
      metaConversationId: conversation.id,
    },
  };
};

export async function syncMessengerInboxForWorkspace(workspaceId) {
  const now = Date.now();
  const last = lastSyncAt.get(workspaceId) ?? 0;
  if (now - last < SYNC_INTERVAL_MS) return { synced: 0, skipped: true };
  lastSyncAt.set(workspaceId, now);

  const channels = await listChannelsForWorkspace(workspaceId);
  const messengerChannels = channels.filter(
    (channel) => channel.type === 'messenger' && channel.status === 'connected' && channel.config?.accessToken,
  );

  let synced = 0;

  for (const channel of messengerChannels) {
    const pageId = channel.config.pageId ?? channel.external_id;
    if (!pageId) continue;

    try {
      const adapter = new MessengerAdapter({ channel });
      const data = await adapter.graphGet(`/${pageId}/conversations`, {
        limit: 25,
        fields: 'id,updated_time,participants,messages.limit(25){id,created_time,from,message}',
      });

      for (const conversation of data?.data ?? []) {
        const customer = findCustomer(conversation, pageId);
        for (const item of toGraphMessages(conversation)) {
          if (String(item.from?.id) === String(pageId)) continue;
          const payload = normalizeGraphMessage({ item, conversation, channel, pageId, customer });
          if (!payload) continue;
          const result = await ingestInboundMessage({ channel, payload });
          if (!result.duplicate) synced += 1;
        }
      }
    } catch (error) {
      log.warn(
        { workspaceId, channelId: channel.id, message: error.response?.data?.error?.message ?? error.message },
        'Could not sync Messenger inbox from Meta',
      );
    }
  }

  return { synced, skipped: false };
}
