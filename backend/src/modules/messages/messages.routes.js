/**
 * Messages inside a conversation. Mounted at
 * /api/conversations/:conversationId/messages (mergeParams gives us the id).
 *
 *   GET  /  paged history (newest-first cursor, returned oldest-first)
 *   POST /  agent reply -> persisted, then handed to the channel adapter
 *   POST /:messageId/retry   re-attempt a failed delivery
 *   POST /:messageId/feedback thumbs up/down, AI replies only
 */
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, loadWorkspace, requireRole } from '../../middleware/auth.js';
import { validate, queryOf } from '../../middleware/validate.js';
import { asyncHandler, AppError } from '../../middleware/error.js';
import { getChannelById } from '../../services/channels.service.js';
import { createAdapterForChannel } from '../../adapters/factory.js';
import { sendMessageToConversation, mapMessage, getConversationById } from '../../services/conversation.service.js';
import { query, queryOne, execute } from '../../db/pool.js';

const router = Router({ mergeParams: true });

/** The parent router already proved the conversation exists; re-scope the join. */
async function parentConversation(req) {
  const conversationId = Number(req.params.conversationId);
  const conversation = await getConversationById(conversationId, req.workspace.id);
  if (!conversation) throw AppError.notFound('Conversation not found');
  return conversation;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

router.get(
  '/',
  authenticate,
  loadWorkspace,
  validate({
    query: z.object({
      before: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { before, limit } = queryOf(req);
    const conversationId = Number(req.params.conversationId);

    const rows = await query(
      `SELECT m.*, u.full_name AS sender_display_name
         FROM messages m
         LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = ?
          AND (? IS NULL OR m.id < ?)
        ORDER BY m.id DESC
        LIMIT ?`,
      [conversationId, before ?? null, before ?? null, limit],
    );

    // Rows come back newest-first; flip to chronological for the chat pane.
    // The cursor for "load older" is the OLDEST id we just returned.
    const oldest = rows[rows.length - 1];
    const hasMore = rows.length === limit;
    res.json({
      messages: rows.slice().reverse().map(mapMessage),
      nextCursor: hasMore ? oldest.id : null,
      hasMore,
    });
  }),
);

// ---------------------------------------------------------------------------
// Send an agent reply
// ---------------------------------------------------------------------------

router.post(
  '/',
  authenticate,
  loadWorkspace,
  requireRole('agent', 'admin', 'owner'),
  validate({
    body: z.object({
      body: z.string().trim().max(4000).optional(),
      attachments: z
        .array(
          z.object({
            url: z.string().min(1).max(1000),
            name: z.string().max(255).optional(),
            mimeType: z.string().max(120).optional(),
            size: z.number().int().nonnegative().optional(),
          }),
        )
        .max(5)
        .default([]),
    }),
  }),
  asyncHandler(async (req, res) => {
    const conversation = await parentConversation(req);
    const { body: text, attachments } = req.body;

    if (!text?.trim() && attachments.length === 0) {
      throw AppError.badRequest('A message needs text or at least one attachment');
    }

    const channel = await getChannelById(conversation.channel_id);
    if (!channel) throw AppError.notFound('Channel not found');
    if (channel.status !== 'connected') {
      throw AppError.badRequest('This channel is not connected - reconnect it in Settings');
    }

    // The message is persisted AND delivered inside this one call:
    // sendMessageToConversation inserts it as 'queued', hands it to the
    // adapter, then records external_id / status / delivered_at and stamps the
    // first-response metrics.
    //
    // There used to be a second adapter.sendMessage() call here, which sent
    // every agent reply to the customer TWICE. Do not re-add it - if you need
    // to change what gets delivered, change the service, not the route.
    const message = await sendMessageToConversation({
      conversation,
      channel,
      body: text?.trim() ?? '',
      attachments,
      sender: { id: req.user.id, name: req.user.full_name },
      senderType: 'agent',
    });

    const final = await queryOne(
      `SELECT m.*, u.full_name AS sender_display_name
         FROM messages m
         LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.id = ?`,
      [message.id],
    );
    res.status(201).json({ message: mapMessage(final) });
  }),
);

// ---------------------------------------------------------------------------
// Retry a failed delivery
// ---------------------------------------------------------------------------

router.post(
  '/:messageId/retry',
  authenticate,
  loadWorkspace,
  requireRole('agent', 'admin', 'owner'),
  validate({
    params: z.object({ messageId: z.coerce.number().int().positive() }),
  }),
  asyncHandler(async (req, res) => {
    const message = await queryOne(
      'SELECT * FROM messages WHERE id = ? AND conversation_id = ? AND workspace_id = ?',
      [req.params.messageId, req.params.conversationId, req.workspace.id],
    );
    if (!message) throw AppError.notFound('Message not found');
    if (message.status === 'sent') {
      throw AppError.badRequest('That message was already delivered');
    }

    const conversation = await parentConversation(req);
    const channel = await getChannelById(conversation.channel_id);
    const adapter = createAdapterForChannel(channel, req.workspace);

    try {
      const result = await adapter.sendMessage({
        to: conversation.contact_external_id,
        body: message.body,
        attachments: message.attachments ?? [],
      });
      await execute(
        'UPDATE messages SET status = ?, external_id = COALESCE(?, external_id), error_message = NULL, delivered_at = NOW() WHERE id = ?',
        [result?.status ?? 'sent', result?.externalId ?? null, message.id],
      );
    } catch (error) {
      await execute('UPDATE messages SET status = "failed", error_message = ? WHERE id = ?', [
        error.message.slice(0, 500),
        message.id,
      ]);
    }

    res.json({ message: mapMessage(await queryOne('SELECT * FROM messages WHERE id = ?', [message.id])) });
  }),
);

// ---------------------------------------------------------------------------
// Feedback on an AI reply (used by the Part 7 evaluation report)
// ---------------------------------------------------------------------------

router.post(
  '/:messageId/feedback',
  authenticate,
  loadWorkspace,
  validate({
    params: z.object({ messageId: z.coerce.number().int().positive() }),
    body: z.object({
      rating: z.enum(['up', 'down']),
      comment: z.string().trim().max(500).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const message = await queryOne(
      'SELECT id, conversation_id, workspace_id, sender_type, body FROM messages WHERE id = ? AND workspace_id = ?',
      [req.params.messageId, req.workspace.id],
    );
    if (!message) throw AppError.notFound('Message not found');
    if (message.sender_type !== 'ai') {
      throw AppError.badRequest('Feedback is only collected on AI replies');
    }

    await execute(
      `INSERT INTO message_feedback (message_id, conversation_id, workspace_id, user_id, rating, comment)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE rating = VALUES(rating), comment = VALUES(comment)`,
      [
        message.id,
        message.conversation_id,
        message.workspace_id,
        req.user.id,
        req.body.rating,
        req.body.comment ?? null,
      ],
    );
    res.status(201).json({ ok: true });
  }),
);

export default router;
