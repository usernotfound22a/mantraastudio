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
import { getSupabaseClient, selectRows, selectOne, updateRows, upsertRow } from '../../db/supabase.js';

const router = Router({ mergeParams: true });

/** The parent router already proved the conversation exists; re-scope the join. */
async function parentConversation(req) {
  const conversationId = Number(req.params.conversationId);
  const conversation = await getConversationById(conversationId, req.workspace.id);
  if (!conversation) throw AppError.notFound('Conversation not found');
  return conversation;
}

async function messageWithSender(id) {
  const { data, error } = await getSupabaseClient()
    .from('messages')
    .select('*,users(full_name)')
    .eq('id', id)
    .single();
  if (error) throw error;
  return { ...data, sender_display_name: data.users?.full_name ?? null };
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

    const rows = await selectRows('messages', '*,users(full_name)', {
      conversation_id: conversationId,
    }, {
      ...(before ? { lt: { id: before } } : {}),
      order: [{ column: 'id', ascending: false }],
      limit,
    });
    const messages = rows.map((row) => ({
      ...row,
      sender_display_name: row.users?.full_name ?? null,
    }));

    // Rows come back newest-first; flip to chronological for the chat pane.
    // The cursor for "load older" is the OLDEST id we just returned.
    const oldest = messages[messages.length - 1];
    const hasMore = messages.length === limit;
    res.json({
      messages: messages.slice().reverse().map(mapMessage),
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

    const final = await messageWithSender(message.id);
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
    const message = await selectOne('messages', '*', {
      id: req.params.messageId,
      conversation_id: req.params.conversationId,
      workspace_id: req.workspace.id,
    });
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
      await updateRows('messages', {
        status: result?.status ?? 'sent',
        ...(result?.externalId ? { external_id: result.externalId } : {}),
        error_message: null,
        delivered_at: new Date().toISOString(),
      }, { id: message.id });
    } catch (error) {
      await updateRows('messages', {
        status: 'failed',
        error_message: error.message.slice(0, 500),
      }, { id: message.id });
    }

    res.json({ message: mapMessage(await selectOne('messages', '*', { id: message.id })) });
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
    const message = await selectOne('messages', 'id,conversation_id,workspace_id,sender_type,body', {
      id: req.params.messageId,
      workspace_id: req.workspace.id,
    });
    if (!message) throw AppError.notFound('Message not found');
    if (message.sender_type !== 'ai') {
      throw AppError.badRequest('Feedback is only collected on AI replies');
    }

    await upsertRow('message_feedback', {
      message_id: message.id,
      conversation_id: message.conversation_id,
      workspace_id: message.workspace_id,
      user_id: req.user.id,
      rating: req.body.rating,
      comment: req.body.comment ?? null,
    }, 'message_id');
    res.status(201).json({ ok: true });
  }),
);

export default router;
