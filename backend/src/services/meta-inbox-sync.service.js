import { InstagramAdapter } from '../adapters/InstagramAdapter.js';
import { MessengerAdapter } from '../adapters/MessengerAdapter.js';
import { selectOne } from '../db/supabase.js';
import { listChannelsForWorkspace } from './channels.service.js';
import { ingestInboundMessage } from './conversation.service.js';
import { maybeAutoReply } from './ai.service.js';
import { childLogger } from '../config/logger.js';

const log = childLogger('meta-inbox-sync');
const SYNC_INTERVAL_MS = 10_000;
const lastSyncAt = new Map();

const shouldSync = (workspaceId, type) => {
  const key = `${workspaceId}:${type}`;
  const now = Date.now();
  if (now - (lastSyncAt.get(key) ?? 0) < SYNC_INTERVAL_MS) return false;
  lastSyncAt.set(key, now);
  return true;
};

const parseMetaTime = (value) => {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
};

const toGraphMessages = (conversation) =>
  [...(conversation?.messages?.data ?? [])].sort(
    (a, b) => parseMetaTime(a.created_time).getTime() - parseMetaTime(b.created_time).getTime(),
  );

const findCustomer = (conversation, ...accountIds) =>
  (conversation?.participants?.data ?? []).find(
    (participant) => !accountIds.some((id) => String(participant.id) === String(id)),
  );

const ingestSyncedMessage = async ({ channel, payload, workspace }) => {
  const result = await ingestInboundMessage({ channel, payload });
  if (result.duplicate || !workspace) return false;
  await maybeAutoReply({
    conversation: result.conversation,
    message: result.message,
    channel,
    workspace,
  });
  return true;
};

const normalizeMessengerMessage = ({ item, conversation, channel, pageId, customer }) => {
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
    timestamp: parseMetaTime(item.created_time).toISOString(),
    metadata: {
      channel: 'messenger',
      pageId,
      source: 'graph-inbox-sync',
      metaConversationId: conversation.id,
    },
  };
};

const normalizeInstagramMessage = ({ item, conversation, pageId, instagramUserId, customer }) => {
  const text = String(item.message ?? '').trim();
  if (!item.id || !text) return null;

  const externalId = String(customer?.id ?? conversation.id);

  return {
    externalMessageId: String(item.id),
    conversationExternalId: externalId,
    contact: {
      externalId,
      name: customer?.username ?? customer?.name ?? null,
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
    timestamp: parseMetaTime(item.created_time).toISOString(),
    metadata: {
      channel: 'instagram',
      pageId,
      instagramUserId,
      source: 'graph-inbox-sync',
      metaConversationId: conversation.id,
    },
  };
};

async function fetchInstagramConversations(adapter, pageId) {
  try {
    const data = await adapter.graphGet(`/${pageId}/conversations`, {
      platform: 'instagram',
      limit: 25,
      fields: 'id,updated_time,participants,messages.limit(20){id,created_time,from,message}',
    });
    return data?.data ?? [];
  } catch (error) {
    log.warn(
      { message: error.response?.data?.error?.message ?? error.message },
      'Instagram nested conversation fields unavailable, falling back to the messages edge',
    );
  }

  const data = await adapter.graphGet(`/${pageId}/conversations`, {
    platform: 'instagram',
    limit: 25,
    fields: 'id,updated_time,participants',
  });

  for (const conversation of data?.data ?? []) {
    try {
      conversation.messages = await adapter.graphGet(`/${conversation.id}/messages`, {
        fields: 'id,created_time,from,to,message',
        limit: 20,
      });
    } catch (error) {
      log.warn(
        { conversationId: conversation.id, message: error.response?.data?.error?.message ?? error.message },
        'Could not read Instagram conversation messages',
      );
      conversation.messages = { data: [] };
    }
  }

  return data?.data ?? [];
}

export async function syncMessengerInboxForWorkspace(workspaceId) {
  if (!shouldSync(workspaceId, 'messenger')) return { synced: 0, skipped: true };

  const workspace = await selectOne('workspaces', '*', { id: workspaceId });
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
          const payload = normalizeMessengerMessage({ item, conversation, channel, pageId, customer });
          if (!payload) continue;
          if (await ingestSyncedMessage({ channel, payload, workspace })) synced += 1;
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

export async function syncInstagramInboxForWorkspace(workspaceId) {
  if (!shouldSync(workspaceId, 'instagram')) return { synced: 0, skipped: true };

  const workspace = await selectOne('workspaces', '*', { id: workspaceId });
  const channels = await listChannelsForWorkspace(workspaceId);
  const instagramChannels = channels.filter(
    (channel) => channel.type === 'instagram' && channel.status === 'connected' && channel.config?.accessToken,
  );

  let synced = 0;

  for (const channel of instagramChannels) {
    const pageId = channel.config.pageId ?? channel.external_id;
    const instagramUserId = channel.config.instagramUserId ?? channel.external_id;
    if (!pageId) continue;

    try {
      const adapter = new InstagramAdapter({ channel });
      const conversations = await fetchInstagramConversations(adapter, pageId);

      for (const conversation of conversations) {
        const customer = findCustomer(conversation, pageId, instagramUserId);
        for (const item of toGraphMessages(conversation)) {
          const senderId = String(item.from?.id ?? customer?.id ?? '');
          if (senderId === String(pageId) || senderId === String(instagramUserId)) continue;
          const payload = normalizeInstagramMessage({
            item,
            conversation,
            pageId,
            instagramUserId,
            customer: { ...customer, id: senderId },
          });
          if (!payload) continue;
          if (await ingestSyncedMessage({ channel, payload, workspace })) synced += 1;
        }
      }
    } catch (error) {
      log.warn(
        { workspaceId, channelId: channel.id, message: error.response?.data?.error?.message ?? error.message },
        'Could not sync Instagram inbox from Meta',
      );
    }
  }

  return { synced, skipped: false };
}

export async function syncMetaInboxesForWorkspace(workspaceId) {
  const messenger = await syncMessengerInboxForWorkspace(workspaceId);
  const instagram = await syncInstagramInboxForWorkspace(workspaceId);
  return { synced: messenger.synced + instagram.synced, messenger, instagram };
}
