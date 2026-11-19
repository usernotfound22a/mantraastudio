/**
 * Conversation + message persistence.
 *
 * This is the inbox core. It is the ONLY place that:
 *   - creates/updates conversations
 *   - writes messages
 *   - emits the real-time events
 *
 * Adapters stay transport-only (parse in, send out). Business rules like
 * "unread count", "first response time" and "reopen a closed thread when the
 * customer writes again" live here once, not in three adapters.
 */
import {
  getSupabaseClient,
  selectRows,
  selectOne,
  insertRow,
  updateRows,
  callRpc,
} from '../db/supabase.js';
import { AppError } from '../middleware/error.js';
import { childLogger } from '../config/logger.js';
import { createAdapterForChannel } from '../adapters/factory.js';
import { emitToWorkspace } from './socket.service.js';
import { EVENTS } from './events.js';
import { incrementUsage } from './subscription.service.js';

const log = childLogger('conversations');

// ===========================================================================
// Conversations
// ===========================================================================

export async function getConversationById(conversationId, workspaceId) {
  return selectOne('conversations', '*', { id: conversationId, workspace_id: workspaceId });
}

/**
 * Finds the thread for a contact, or creates it.
 * One conversation per (channel, contact) - that is what makes the inbox
 * "unified" without merging Facebook and Instagram identities.
 */
export async function getOrCreateConversation({ channel, externalId, contact = {} }) {
  const existing = await selectOne('conversations', '*', { channel_id: channel.id, external_id: externalId });

  if (existing) {
    // Enrich the contact over time: the first webhook often has no name, the
    // Graph API lookup that follows does.
    if (contact.name || contact.avatarUrl || contact.email) {
      const changes = {};
      if (!existing.contact_name && contact.name) changes.contact_name = contact.name;
      if (!existing.contact_avatar_url && contact.avatarUrl) changes.contact_avatar_url = contact.avatarUrl;
      if (!existing.contact_email && contact.email) changes.contact_email = contact.email;
      if (!existing.contact_locale && contact.locale) changes.contact_locale = contact.locale;
      if (Object.keys(changes).length) await updateRows('conversations', changes, { id: existing.id });
      existing.contact_name = existing.contact_name ?? contact.name;
      existing.contact_avatar_url = existing.contact_avatar_url ?? contact.avatarUrl;
      existing.contact_email = existing.contact_email ?? contact.email;
    }
    return existing;
  }

  let created;
  try {
    created = await insertRow('conversations', {
      workspace_id: channel.workspace_id,
      channel_id: channel.id,
      external_id: externalId,
      contact_external_id: contact.externalId ?? externalId,
      contact_name: contact.name ?? null,
      contact_avatar_url: contact.avatarUrl ?? null,
      contact_email: contact.email ?? null,
      contact_locale: contact.locale ?? null,
      last_message_at: new Date().toISOString(),
    });
  } catch (error) {
    if (error.code !== '23505') throw error;
    return selectOne('conversations', '*', { channel_id: channel.id, external_id: externalId });
  }

  log.info(
    { conversationId: created.id, channelId: channel.id, type: channel.type },
    'Conversation created',
  );
  return created;
}

/**
 * Message inbox list (the left pane).
 * Filters are applied ONLY against the caller's workspace - tenant isolation.
 */
export async function listConversations(workspaceId, filters = {}) {
  const {
    status,
    channelType,
    assigneeId,
    search,
    unreadOnly = false,
    limit = 30,
    cursor,
  } = filters;

  const limitParam = Math.min(Number(limit) || 30, 100);
  let request = getSupabaseClient()
    .from('conversations')
    .select('*,channels(type,name),users!conversations_assignee_id_fkey(full_name,avatar_url)')
    .eq('workspace_id', workspaceId);
  if (status) request = request.eq('status', status);
  if (channelType) request = request.eq('channels.type', channelType);
  if (assigneeId === 'unassigned') request = request.is('assignee_id', null);
  else if (assigneeId) request = request.eq('assignee_id', Number(assigneeId));
  if (unreadOnly) request = request.gt('unread_count', 0);
  if (search) {
    const safeSearch = search.replace(/[,%()]/g, '');
    request = request.or(
      `contact_name.ilike.%${safeSearch}%,subject.ilike.%${safeSearch}%,last_message_preview.ilike.%${safeSearch}%`,
    );
  }
  if (cursor) {
    const cursorRow = await selectOne('conversations', 'id,last_message_at', { id: cursor, workspace_id: workspaceId });
    if (cursorRow?.last_message_at) {
      const timestamp = cursorRow.last_message_at;
      request = request.or(`last_message_at.lt.${timestamp},and(last_message_at.eq.${timestamp},id.lt.${cursor})`);
    } else {
      request = request.is('last_message_at', null).lt('id', cursor);
    }
  }
  const { data: rawRows, error } = await request
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .limit(limitParam);
  if (error) throw error;
  const rows = rawRows.map((row) => ({
    ...row,
    channel_type: row.channels?.type ?? null,
    channel_name: row.channels?.name ?? null,
    assignee_name: row.users?.full_name ?? null,
    assignee_avatar_url: row.users?.avatar_url ?? null,
  }));

  const last = rows[rows.length - 1];
  return {
    conversations: rows.map(mapConversationSummary),
    nextCursor: rows.length === limitParam && last ? last.id : null,
  };
}

/** Full detail for the chat pane header. */
export async function getConversationWithMessages(conversationId, workspaceId, { before = null, limit = 50 } = {}) {
  const conversation = await getConversationById(conversationId, workspaceId);
  if (!conversation) throw AppError.notFound('Conversation not found');

  const [messageRows, noteRows] = await Promise.all([
    selectRows('messages', '*,users(full_name,avatar_url)', { conversation_id: conversationId }, {
      ...(before ? { lt: { id: before } } : {}),
      order: [{ column: 'sent_at', ascending: false }, { column: 'id', ascending: false }],
      limit: Math.min(Number(limit) || 50, 200),
    }),
    selectRows('notes', '*,users(full_name,avatar_url)', { conversation_id: conversationId }, {
      order: [{ column: 'created_at', ascending: false }],
      limit: 100,
    }),
  ]);
  const messages = messageRows.map((row) => ({
    ...row,
    sender_display_name: row.users?.full_name ?? null,
    sender_display_avatar: row.users?.avatar_url ?? null,
  }));
  const notes = noteRows.map((row) => ({
    ...row,
    author_name: row.users?.full_name ?? null,
    author_avatar: row.users?.avatar_url ?? null,
  }));

  return {
    conversation: mapConversationSummary(conversation),
    messages: messages.reverse().map(mapMessage),
    notes: notes.map((note) => ({
      id: note.id,
      body: note.body,
      author: { id: note.user_id, name: note.author_name, avatarUrl: note.author_avatar },
      pinned: Boolean(note.pinned),
      createdAt: note.created_at,
    })),
  };
}

// ===========================================================================
// Inbound
// ===========================================================================

/**
 * THE entry point for every inbound message, whatever the channel.
 *
 * @param {object} params
 * @param {object} params.channel   channels row
 * @param {object} params.payload   a NormalizedInbound produced by an adapter
 * @returns {{conversation, message, duplicate: boolean}}
 *
 * Steps: de-duplicate -> find/create thread -> persist -> update counters ->
 *        emit real-time events.
 */
export async function ingestInboundMessage({ channel, payload }) {
  const externalId = payload.externalMessageId;

  // 1. De-duplicate BEFORE creating anything. Webhooks are retried by Meta and
  //    our own widget may double-submit, so this must be the first concern.
  if (externalId) {
    const existing = await selectOne('messages', 'id,conversation_id', {
      channel_id: channel.id,
      external_id: externalId,
    });
    if (existing) {
      log.debug({ externalId, channelId: channel.id }, 'Duplicate inbound message ignored');
      const conversation = await getConversationById(existing.conversation_id, channel.workspace_id);
      return { conversation, message: { id: existing.id }, duplicate: true };
    }
  }

  const conversation = await getOrCreateConversation({
    channel,
    externalId: payload.conversationExternalId,
    contact: payload.contact,
  });

  const recorded = await callRpc('record_inbound_message', {
    p_workspace_id: channel.workspace_id,
    p_conversation_id: conversation.id,
    p_channel_id: channel.id,
    p_external_id: externalId ?? null,
    p_sender_name: payload.contact?.name ?? conversation.contact_name ?? null,
    p_body: payload.content?.text ?? '',
    p_attachments: payload.content?.attachments?.length ? payload.content.attachments : null,
    p_sent_at: payload.timestamp ?? new Date().toISOString(),
    p_metadata: payload.metadata ?? null,
    p_widget_key: channel.type === 'website' ? channel.config?.widgetKey ?? null : null,
  });
  if (recorded.duplicate) {
    return { conversation, message: { id: recorded.message.id }, duplicate: true };
  }
  const messageRow = recorded.message;

  log.info(
    {
      workspaceId: channel.workspace_id,
      channelId: channel.id,
      channelType: channel.type,
      conversationId: conversation.id,
      messageId: messageRow.id,
      externalMessageId: externalId,
      attachmentCount: payload.content?.attachments?.length ?? 0,
    },
    'Inbound message persisted',
  );

  // 4. Plan limits + real-time notification.
  incrementUsage(channel.workspace_id, { messages: 1 }).catch((error) =>
    log.warn({ err: error.message }, 'Usage counter update failed'),
  );

  emitToWorkspace(channel.workspace_id, EVENTS.CONVERSATION_UPSERTED, {
    conversation: mapConversationSummary({
      ...conversation,
      last_message_at: messageRow.sent_at,
      last_message_preview: messageRow.body,
      last_message_direction: 'inbound',
      unread_count: conversation.unread_count + 1,
      status: 'open',
    }),
  });
  emitToWorkspace(channel.workspace_id, EVENTS.MESSAGE_NEW, {
    conversationId: conversation.id,
    message: mapMessage(messageRow),
  });

  return { conversation, message: messageRow, duplicate: false };
}

// ===========================================================================
// Outbound
// ===========================================================================

/**
 * Persists an outbound message. Called by the send pipeline and by the
 * website adapter (its "delivery" is this row).
 */
export async function insertOutboundMessage({
  channel,
  conversation,
  body,
  attachments = [],
  senderType = 'agent',
  senderId = null,
  senderName = null,
  externalId = null,
  status = 'queued',
  metadata = null,
  intent = null,
  isAiHandover = false,
}) {
  return insertRow('messages', {
    workspace_id: conversation.workspace_id,
    conversation_id: conversation.id,
    channel_id: channel.id,
    external_id: externalId,
    direction: 'outbound',
    sender_type: senderType,
    sender_id: senderId,
    sender_name: senderName,
    body,
    attachments: attachments.length ? attachments : null,
    status,
    intent,
    is_ai_handover: isAiHandover,
    metadata,
  });
}

/**
 * Sends a message to the customer. THE ONLY outbound entry point.
 *
 * Order matters: we persist first, then deliver. That way an outage at Meta
 * still leaves a visible "failed" message in the thread instead of the agent
 * believing it was sent.
 *
 * @param {object} params
 * @param {object} params.conversation conversations row
 * @param {object} params.channel      channels row
 * @param {object} [params.sender]     req.user for agent messages
 */
export async function sendMessageToConversation({
  conversation,
  channel,
  body,
  attachments = [],
  sender = null,
  senderType = 'agent',
  intent = null,
  metadata = null,
}) {
  if (!body?.trim() && attachments.length === 0) {
    throw AppError.badRequest('A message needs text or an attachment');
  }

  // 1. Persist as queued.
  const queued = await insertOutboundMessage({
    channel,
    conversation,
    body: body?.trim() ?? '',
    attachments,
    senderType,
    senderId: sender?.id ?? null,
    senderName: sender?.full_name ?? null,
    externalId: null,
    status: 'queued',
    intent,
    metadata,
  });
  log.info(
    {
      workspaceId: conversation.workspace_id,
      channelId: channel.id,
      channelType: channel.type,
      conversationId: conversation.id,
      messageId: queued.id,
    },
    'Outbound message queued',
  );

  // 2. Deliver through the adapter.
  let delivery;
  try {
    const adapter = createAdapterForChannel(channel);
    delivery = await adapter.sendMessage({
      to: conversation.contact_external_id,
      body: body?.trim() ?? '',
      attachments,
      // The adapter gets the persisted row so first-party channels (website)
      // do not have to insert it again.
      persistedMessage: queued,
      conversation,
    });
  } catch (error) {
    const providerError = error.response?.data?.error;
    const failureMessage = providerError?.message ?? error.message;
    await updateRows('messages', {
      status: 'failed',
      error_message: String(failureMessage).slice(0, 500),
    }, { id: queued.id });
    log.error(
      {
        workspaceId: conversation.workspace_id,
        conversationId: conversation.id,
        channelId: channel.id,
        channelType: channel.type,
        messageId: queued.id,
        httpStatus: error.response?.status,
        providerCode: providerError?.code,
        providerSubcode: providerError?.error_subcode,
        providerType: providerError?.type,
        providerTraceId: providerError?.fbtrace_id,
        err: failureMessage,
      },
      'Outbound delivery failed',
    );
    // The message row survives as "failed" so the agent can retry.
    throw AppError.serviceUnavailable(`Message could not be delivered: ${failureMessage}`);
  }

  // 3. Record the result + first-response metrics.
  const delivered = await selectOne('messages', '*', { id: queued.id });
  const latest = await getConversationById(conversation.id, conversation.workspace_id);
  const now = new Date();
  await updateRows('conversations', {
    last_message_at: now.toISOString(),
    last_message_preview: body?.trim().slice(0, 255) ?? '',
    last_message_direction: 'outbound',
    first_response_at: latest.first_response_at ?? now.toISOString(),
    first_response_seconds: latest.first_response_seconds
      ?? Math.floor((now.getTime() - new Date(latest.created_at).getTime()) / 1000),
  }, { id: conversation.id });

  incrementUsage(conversation.workspace_id, { messages: 1 }).catch(() => {});

  emitToWorkspace(conversation.workspace_id, EVENTS.MESSAGE_NEW, {
    conversationId: conversation.id,
    message: mapMessage({ ...delivered, external_id: delivery?.externalId ?? delivered.external_id, status: delivery?.status ?? delivered.status }),
  });

  log.info(
    {
      workspaceId: conversation.workspace_id,
      channelId: channel.id,
      channelType: channel.type,
      conversationId: conversation.id,
      messageId: queued.id,
      externalMessageId: delivery?.externalId ?? null,
      status: delivery?.status ?? delivered.status,
    },
    'Outbound message sent',
  );

  return mapMessage({ ...delivered, external_id: delivery?.externalId ?? delivered.external_id, status: delivery?.status ?? delivered.status });
}

// ===========================================================================
// Status / assignment
// ===========================================================================

const STATUSES = ['open', 'pending', 'closed'];

/** Changes open/pending/closed and keeps the resolved timestamp honest. */
export async function updateConversationStatus(conversation, status, userId = null) {
  if (!STATUSES.includes(status)) throw AppError.badRequest(`Status must be one of: ${STATUSES}`);

  const changes = { status };
  if (status === 'closed') {
    changes.unread_count = 0;
    changes.resolved_at = conversation.resolved_at ?? new Date().toISOString();
  } else {
    changes.resolved_at = null;
  }
  await updateRows('conversations', changes, { id: conversation.id });

  const updated = await getConversationById(conversation.id, conversation.workspace_id);
  emitToWorkspace(conversation.workspace_id, EVENTS.CONVERSATION_UPDATED, {
    conversationId: conversation.id,
    changes: { status, resolvedAt: updated.resolved_at, updatedBy: userId },
    conversation: mapConversationSummary(updated),
  });
  return updated;
}

/** Assigns (or unassigns) an agent. Only members of the same workspace count. */
export async function assignConversation(conversation, assigneeId, userId = null) {
  if (assigneeId) {
    const member = await selectOne('workspace_members', 'user_id', {
      workspace_id: conversation.workspace_id,
      user_id: assigneeId,
      status: 'active',
    });
    if (!member) throw AppError.badRequest('That person is not a member of this workspace');
  }

  await updateRows('conversations', { assignee_id: assigneeId }, { id: conversation.id });
  const updated = await getConversationById(conversation.id, conversation.workspace_id);

  emitToWorkspace(conversation.workspace_id, EVENTS.CONVERSATION_UPDATED, {
    conversationId: conversation.id,
    changes: { assigneeId, updatedBy: userId },
    conversation: mapConversationSummary(updated),
  });
  if (assigneeId) {
    const { emitToUser } = await import('./socket.service.js');
    emitToUser(assigneeId, EVENTS.CONVERSATION_ASSIGNED, {
      conversationId: conversation.id,
      contactName: conversation.contact_name,
    });
  }
  return updated;
}

/** Marks a thread as read for this agent (resets the unread badge). */
export async function markConversationRead(conversation) {
  if (conversation.unread_count === 0) return conversation;
  await updateRows('conversations', { unread_count: 0 }, { id: conversation.id });
  emitToWorkspace(conversation.workspace_id, EVENTS.CONVERSATION_READ, {
    conversationId: conversation.id,
  });
  return getConversationById(conversation.id, conversation.workspace_id);
}

/** Stops (or resumes) the AI on one thread. */
export async function setAiHandover(conversation, handedOver, reason = null) {
  await updateRows('conversations', {
    ai_handover: handedOver,
    ai_handover_reason: reason,
    ai_handover_at: handedOver ? new Date().toISOString() : null,
  }, { id: conversation.id });
  const updated = await getConversationById(conversation.id, conversation.workspace_id);
  emitToWorkspace(conversation.workspace_id, EVENTS.CONVERSATION_UPDATED, {
    conversationId: conversation.id,
    changes: { aiHandover: handedOver, aiHandoverReason: reason },
    conversation: mapConversationSummary(updated),
  });
  return updated;
}

// ===========================================================================
// Mappers  (snake_case rows -> camelCase API objects, one place only)
// ===========================================================================

export function mapConversationSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    channelType: row.channel_type ?? null,
    channelName: row.channel_name ?? null,
    externalId: row.external_id,
    contact: {
      externalId: row.contact_external_id,
      name: row.contact_name ?? 'Unknown customer',
      avatarUrl: row.contact_avatar_url ?? null,
      email: row.contact_email ?? null,
      locale: row.contact_locale ?? null,
    },
    subject: row.subject ?? null,
    status: row.status,
    priority: row.priority,
    assignee: row.assignee_id
      ? { id: row.assignee_id, name: row.assignee_name, avatarUrl: row.assignee_avatar_url }
      : null,
    unreadCount: row.unread_count ?? 0,
    lastMessageAt: row.last_message_at,
    lastMessagePreview: row.last_message_preview ?? null,
    lastMessageDirection: row.last_message_direction ?? null,
    ai: {
      enabled: Boolean(row.ai_enabled),
      handover: Boolean(row.ai_handover),
      handoverReason: row.ai_handover_reason ?? null,
      confidence: row.ai_confidence ?? null,
      resolved: Boolean(row.ai_resolved),
      leadTags: row.ai_lead_tags ?? [],
    },
    firstResponseSeconds: row.first_response_seconds ?? null,
    resolvedAt: row.resolved_at ?? null,
    tags: row.tags ?? [],
    createdAt: row.created_at,
  };
}

export function mapMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    externalId: row.external_id ?? null,
    direction: row.direction,
    senderType: row.sender_type,
    sender: row.sender_id
      ? { id: row.sender_id, name: row.sender_display_name ?? row.sender_name, avatarUrl: row.sender_display_avatar }
      : { id: null, name: row.sender_name, avatarUrl: row.sender_avatar_url },
    body: row.body,
    attachments: row.attachments ?? [],
    status: row.status,
    error: row.error_message ?? null,
    intent: row.intent ?? null,
    isAiHandover: Boolean(row.is_ai_handover),
    sentAt: row.sent_at,
    deliveredAt: row.delivered_at ?? null,
    readAt: row.read_at ?? null,
    metadata: row.metadata ?? null,
  };
}
