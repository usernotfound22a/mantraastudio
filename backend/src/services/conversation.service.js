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
import { query, queryOne, execute, withTransaction, txQuery, txExecute } from '../db/pool.js';
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
  return queryOne(
    'SELECT * FROM conversations WHERE id = ? AND workspace_id = ? LIMIT 1',
    [conversationId, workspaceId],
  );
}

/**
 * Finds the thread for a contact, or creates it.
 * One conversation per (channel, contact) - that is what makes the inbox
 * "unified" without merging Facebook and Instagram identities.
 */
export async function getOrCreateConversation({ channel, externalId, contact = {} }) {
  const existing = await queryOne(
    'SELECT * FROM conversations WHERE channel_id = ? AND external_id = ? LIMIT 1',
    [channel.id, externalId],
  );

  if (existing) {
    // Enrich the contact over time: the first webhook often has no name, the
    // Graph API lookup that follows does.
    if (contact.name || contact.avatarUrl || contact.email) {
      await execute(
        `UPDATE conversations SET
            contact_name       = COALESCE(contact_name, ?),
            contact_avatar_url = COALESCE(contact_avatar_url, ?),
            contact_email      = COALESCE(contact_email, ?),
            contact_locale     = COALESCE(contact_locale, ?)
          WHERE id = ?`,
        [contact.name ?? null, contact.avatarUrl ?? null, contact.email ?? null, contact.locale ?? null, existing.id],
      );
      existing.contact_name = existing.contact_name ?? contact.name;
      existing.contact_avatar_url = existing.contact_avatar_url ?? contact.avatarUrl;
      existing.contact_email = existing.contact_email ?? contact.email;
    }
    return existing;
  }

  const result = await execute(
    `INSERT INTO conversations
       (workspace_id, channel_id, external_id, contact_external_id,
        contact_name, contact_avatar_url, contact_email, contact_locale, last_message_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      channel.workspace_id,
      channel.id,
      externalId,
      contact.externalId ?? externalId,
      contact.name ?? null,
      contact.avatarUrl ?? null,
      contact.email ?? null,
      contact.locale ?? null,
    ],
  );

  log.info(
    { conversationId: result.insertId, channelId: channel.id, type: channel.type },
    'Conversation created',
  );
  return getConversationById(result.insertId, channel.workspace_id);
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

  const where = ['c.workspace_id = ?'];
  const params = [workspaceId];

  if (status) {
    where.push('c.status = ?');
    params.push(status);
  }
  if (channelType) {
    where.push('ch.type = ?');
    params.push(channelType);
  }
  if (assigneeId === 'unassigned') {
    where.push('c.assignee_id IS NULL');
  } else if (assigneeId) {
    where.push('c.assignee_id = ?');
    params.push(Number(assigneeId));
  }
  if (unreadOnly) where.push('c.unread_count > 0');
  if (search) {
    where.push('(c.contact_name LIKE ? OR c.subject LIKE ? OR c.last_message_preview LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  // Keyset pagination: cheaper and more stable than OFFSET on a table that
  // re-sorts itself on every new message.
  if (cursor) {
    where.push('(c.last_message_at, c.id) < (SELECT last_message_at, id FROM conversations WHERE id = ?)');
    params.push(cursor);
  }

  const limitParam = Math.min(Number(limit) || 30, 100);

  const rows = await query(
    `SELECT c.id, c.status, c.priority, c.subject, c.contact_name, c.contact_avatar_url,
            c.unread_count, c.last_message_at, c.last_message_preview, c.last_message_direction,
            c.assignee_id, c.ai_handover, c.ai_handover_reason, c.ai_confidence,
            c.first_response_seconds, c.ai_lead_tags,
            ch.type AS channel_type, ch.name AS channel_name,
            u.full_name AS assignee_name, u.avatar_url AS assignee_avatar_url
       FROM conversations c
       JOIN channels ch ON ch.id = c.channel_id
       LEFT JOIN users u ON u.id = c.assignee_id
      WHERE ${where.join(' AND ')}
      ORDER BY (c.last_message_at IS NULL), c.last_message_at DESC, c.id DESC
      LIMIT ${limitParam}`,
    params,
  );

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

  const messages = await query(
    `SELECT m.*, u.full_name AS sender_display_name, u.avatar_url AS sender_display_avatar
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = ?
        ${before ? 'AND m.id < ?' : ''}
      ORDER BY m.sent_at DESC, m.id DESC
      LIMIT ${Math.min(Number(limit) || 50, 200)}`,
    before ? [conversationId, before] : [conversationId],
  );

  const notes = await query(
    `SELECT n.*, u.full_name AS author_name, u.avatar_url AS author_avatar
       FROM notes n
       LEFT JOIN users u ON u.id = n.user_id
      WHERE n.conversation_id = ?
      ORDER BY n.created_at DESC
      LIMIT 100`,
    [conversationId],
  );

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
    const existing = await queryOne(
      'SELECT id, conversation_id FROM messages WHERE channel_id = ? AND external_id = ? LIMIT 1',
      [channel.id, externalId],
    );
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

  // 2 + 3. Write the message and bump the thread in one transaction.
  let message;
  try {
    message = await withTransaction(async (client) => {
      const insertResult = await txExecute(
        client,
        `INSERT INTO messages
           (workspace_id, conversation_id, channel_id, external_id, direction, sender_type,
            sender_name, body, attachments, status, sent_at, metadata)
         VALUES (?, ?, ?, ?, 'inbound', 'contact', ?, ?, ?, 'delivered', ?, ?)`,
        [
          channel.workspace_id,
          conversation.id,
          channel.id,
          externalId ?? null,
          payload.contact?.name ?? conversation.contact_name ?? null,
          payload.content?.text ?? '',
          payload.content?.attachments?.length ? JSON.stringify(payload.content.attachments) : null,
          payload.timestamp ?? new Date(),
          payload.metadata ? JSON.stringify(payload.metadata) : null,
        ],
      );

      // A new customer message reopens a thread that was closed or awaiting us.
      const nextStatus = conversation.status === 'open' ? 'open' : 'open';
      await txExecute(
        client,
        `UPDATE conversations SET
            last_message_at        = ?,
            last_message_preview   = ?,
            last_message_direction = 'inbound',
            unread_count           = unread_count + 1,
            status                 = ?,
            ai_message_count       = ai_message_count + 1,
            subject                = COALESCE(subject, ?)
          WHERE id = ?`,
        [
          payload.timestamp ?? new Date(),
          (payload.content?.text ?? '').slice(0, 255),
          nextStatus,
          (payload.contact?.name ?? 'New conversation').slice(0, 255),
          conversation.id,
        ],
      );

      return txQuery(client, 'SELECT * FROM messages WHERE id = ?', [insertResult.insertId]);
    });
  } catch (error) {
    // Lost a race with a concurrent webhook delivery: the unique key saved us.
    if (error.code === 'ER_DUP_ENTRY') {
      log.debug({ externalId }, 'Duplicate inbound message (unique key) ignored');
      return { conversation, message: null, duplicate: true };
    }
    throw error;
  }

  const [messageRow] = message;

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
  const result = await execute(
    `INSERT INTO messages
       (workspace_id, conversation_id, channel_id, external_id, direction, sender_type,
        sender_id, sender_name, body, attachments, status, intent, is_ai_handover, sent_at, metadata)
     VALUES (?, ?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
    [
      conversation.workspace_id,
      conversation.id,
      channel.id,
      externalId,
      senderType,
      senderId,
      senderName,
      body,
      attachments.length ? JSON.stringify(attachments) : null,
      status,
      intent,
      isAiHandover ? 1 : 0,
      metadata ? JSON.stringify(metadata) : null,
    ],
  );
  return queryOne('SELECT * FROM messages WHERE id = ?', [result.insertId]);
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
    await execute('UPDATE messages SET status = ?, error_message = ? WHERE id = ?', [
      'failed',
      String(failureMessage).slice(0, 500),
      queued.id,
    ]);
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
  const delivered = await queryOne('SELECT * FROM messages WHERE id = ?', [queued.id]);

  await execute(
    `UPDATE conversations SET
        last_message_at        = NOW(),
        last_message_preview   = ?,
        last_message_direction = 'outbound',
        first_response_at      = COALESCE(first_response_at, NOW()),
        first_response_seconds = COALESCE(first_response_seconds,
            TIMESTAMPDIFF(SECOND, created_at, NOW()))
      WHERE id = ?`,
    [body?.trim().slice(0, 255) ?? '', conversation.id],
  );

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

  await execute(
    `UPDATE conversations SET
        status       = ?,
        unread_count = IF(? = 'closed', 0, unread_count),
        resolved_at  = CASE WHEN ? = 'closed' THEN COALESCE(resolved_at, NOW()) ELSE NULL END
      WHERE id = ?`,
    [status, status, status, conversation.id],
  );

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
    const member = await queryOne(
      `SELECT user_id FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
      [conversation.workspace_id, assigneeId],
    );
    if (!member) throw AppError.badRequest('That person is not a member of this workspace');
  }

  await execute('UPDATE conversations SET assignee_id = ? WHERE id = ?', [assigneeId, conversation.id]);
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
  await execute('UPDATE conversations SET unread_count = 0 WHERE id = ?', [conversation.id]);
  emitToWorkspace(conversation.workspace_id, EVENTS.CONVERSATION_READ, {
    conversationId: conversation.id,
  });
  return getConversationById(conversation.id, conversation.workspace_id);
}

/** Stops (or resumes) the AI on one thread. */
export async function setAiHandover(conversation, handedOver, reason = null) {
  await execute(
    'UPDATE conversations SET ai_handover = ?, ai_handover_reason = ?, ai_handover_at = ? WHERE id = ?',
    [handedOver ? 1 : 0, reason, handedOver ? new Date() : null, conversation.id],
  );
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
