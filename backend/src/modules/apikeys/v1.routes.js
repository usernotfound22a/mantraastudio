/**
 * Public API v1 - what a customer's integration calls.
 *
 *   Authorization: Bearer sh_live_...
 *
 * Every route requires an API key and an explicit scope. There is no ambient
 * authority here: a key is bound to one workspace at creation and every query
 * is filtered by req.workspaceId, which the key auth middleware derived from
 * the key itself. There is no workspace header to tamper with, so an
 * integration cannot reach another tenant by changing a header.
 *
 *   GET  /api/v1/me                     key identity + granted scopes
 *   GET  /api/v1/conversations          conversations:read
 *   GET  /api/v1/conversations/:id      conversations:read
 *   GET  /api/v1/conversations/:id/messages   messages:read
 *   POST /api/v1/conversations/:id/messages   messages:write
 *   PATCH /api/v1/conversations/:id     conversations:write
 *   GET  /api/v1/analytics/summary      analytics:read
 *   GET  /api/v1/faqs                   faqs:read
 *   GET  /api/v1/channels               conversations:read
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { queryOf, validate } from '../../middleware/validate.js';
import { authenticateApiKeyMiddleware, requireApiScope } from '../../middleware/apiAuth.js';
import { selectOne, selectRows, updateRows } from '../../db/supabase.js';
import { mapMessage } from '../../services/conversation.service.js';
import { createAdapterForChannel } from '../../adapters/factory.js';

const router = Router();

// Every route below is public API auth, not dashboard auth.
router.use(authenticateApiKeyMiddleware);

/** Who am I? Lets a customer verify a key before wiring it into production. */
router.get(
  '/me',
  asyncHandler(async (req, res) => {
    res.json({
      workspace: { id: req.api.workspaceId, name: req.api.workspaceName },
      keyId: req.api.keyId,
      scopes: req.api.scopes,
    });
  }),
);

// ------------------------------------------------------------ conversations

router.get(
  '/conversations',
  requireApiScope('conversations:read'),
  validate({
    query: z.object({
      status: z.enum(['open', 'pending', 'resolved', 'all']).default('open'),
      limit: z.coerce.number().int().positive().max(100).default(25),
      cursor: z.coerce.number().int().positive().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { status, limit, cursor } = req.validatedQuery ?? req.query;

    const filters = { workspace_id: req.workspaceId };
    if (status !== 'all') filters.status = status;
    const rows = await selectRows('conversations', '*', filters, {
      ...(cursor ? { lt: { id: cursor } } : {}),
      order: [{ column: 'id', ascending: false }],
      limit: Number(limit) + 1,
    });
    const hydrated = await Promise.all(rows.map(async (row) => {
      const channel = await selectOne('channels', 'type,name', { id: row.channel_id });
      return { ...row, channel_type: channel?.type, channel_name: channel?.name };
    }));

    const hasMore = hydrated.length > limit;
    const page = hasMore ? hydrated.slice(0, limit) : hydrated;

    res.json({
      conversations: page.map(mapConversation),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    });
  }),
);

router.get(
  '/conversations/:id',
  requireApiScope('conversations:read'),
  validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req, res) => {
    const row = await selectOne('conversations', '*', { id: req.params.id, workspace_id: req.workspaceId });
    const channel = row && await selectOne('channels', 'type,name', { id: row.channel_id });
    const conversation = row && { ...row, channel_type: channel?.type, channel_name: channel?.name };
    if (!conversation) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
      return;
    }
    res.json({ conversation: mapConversation(conversation) });
  }),
);

router.patch(
  '/conversations/:id',
  requireApiScope('conversations:write'),
  validate({
    params: z.object({ id: z.coerce.number().int().positive() }),
    body: z.object({
      status: z.enum(['open', 'pending', 'resolved']).optional(),
      assigneeId: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { status, assigneeId } = req.body;

    // Confirm the conversation belongs to this key's workspace before writing.
    const conversation = await selectOne('conversations', 'id', {
      id: req.params.id, workspace_id: req.workspaceId,
    });
    if (!conversation) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
      return;
    }

    if (status) {
      await updateRows('conversations', {
        status,
        resolved_at: status === 'resolved' ? new Date().toISOString() : null,
      }, { id: req.params.id, workspace_id: req.workspaceId });
    }
    if (assigneeId !== undefined) {
      if (assigneeId === null) {
        await updateRows('conversations', { assignee_id: null }, {
          id: req.params.id, workspace_id: req.workspaceId,
        });
      } else {
        // The assignee must be a member of THIS workspace, not any user id.
        const member = await selectOne('workspace_members', 'user_id', {
          workspace_id: req.workspaceId, user_id: assigneeId,
        });
        if (!member) {
          res.status(400).json({
            error: { code: 'BAD_REQUEST', message: 'assigneeId is not a member of this workspace' },
          });
          return;
        }
        await updateRows('conversations', { assignee_id: assigneeId }, {
          id: req.params.id, workspace_id: req.workspaceId,
        });
      }
    }

    const fresh = await selectOne('conversations', '*', {
      id: req.params.id, workspace_id: req.workspaceId,
    });
    const freshChannel = fresh && await selectOne('channels', 'type,name', { id: fresh.channel_id });
    res.json({ conversation: mapConversation({
      ...fresh, channel_type: freshChannel?.type, channel_name: freshChannel?.name,
    }) });
  }),
);

// ----------------------------------------------------------------- messages

router.get(
  '/conversations/:id/messages',
  requireApiScope('messages:read'),
  validate({
    params: z.object({ id: z.coerce.number().int().positive() }),
    query: z.object({ limit: z.coerce.number().int().positive().max(100).default(50) }),
  }),
  asyncHandler(async (req, res) => {
    const conversation = await selectOne('conversations', 'id', {
      id: req.params.id, workspace_id: req.workspaceId,
    });
    if (!conversation) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
      return;
    }
    const rows = await selectRows('messages', '*', { conversation_id: req.params.id }, {
      order: [{ column: 'id', ascending: false }],
      limit: Number(queryOf(req).limit),
    });
    const hydrated = await Promise.all(rows.map(async (message) => {
      const sender = message.sender_id
        ? await selectOne('users', 'full_name,avatar_url', { id: message.sender_id })
        : null;
      return {
        ...message,
        sender_display_name: sender?.full_name,
        sender_display_avatar: sender?.avatar_url,
      };
    }));
    // Returned oldest-first, which is how a chat transcript reads.
    res.json({ messages: hydrated.reverse().map(mapMessage) });
  }),
);

router.post(
  '/conversations/:id/messages',
  requireApiScope('messages:write'),
  validate({
    params: z.object({ id: z.coerce.number().int().positive() }),
    body: z.object({
      body: z.string().trim().min(1).max(5000),
      // Integrations post as a named system sender, never impersonating an agent.
      senderName: z.string().trim().max(120).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { body, senderName } = req.body;

    const conversation = await selectOne('conversations', '*', {
      id: req.params.id, workspace_id: req.workspaceId,
    });
    if (!conversation) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
      return;
    }

    // Same shape channels.service.js hands to the factory.
    const channelRow = await selectOne('channels', '*', {
      id: conversation.channel_id, workspace_id: req.workspaceId,
    });
    if (!channelRow) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Channel not found' } });
      return;
    }
    const rawConfig = typeof channelRow.config === 'string' ? JSON.parse(channelRow.config) : (channelRow.config ?? {});
    const channel = {
      id: channelRow.id,
      type: channelRow.type,
      status: channelRow.status,
      name: channelRow.name,
      external_id: channelRow.external_id,
      config: rawConfig,
      workspace_id: channelRow.workspace_id ?? req.workspaceId,
    };

    // Reuse the single delivery path, so an API-triggered message is delivered
    // and recorded exactly like an agent reply (and cannot double-send).
    const { sendMessageToConversation } = await import('../../services/conversation.service.js');
    try {
      const message = await sendMessageToConversation({
        conversation,
        channel,
        body,
        // 'system', not 'agent': this must not be attributed to, or counted
        // against, a real support agent's stats.
        senderType: 'system',
        sender: { id: null, full_name: senderName || 'Public API' },
      });
      res.status(201).json({ message: mapMessage(message) });
    } catch (error) {
      res.status(502).json({
        error: { code: 'DELIVERY_FAILED', message: `Message stored but delivery failed: ${error.message}` },
      });
    }
  }),
);

// ---------------------------------------------------------------- analytics

router.get(
  '/analytics/summary',
  requireApiScope('analytics:read'),
  asyncHandler(async (req, res) => {
    const rows = await selectRows('conversations', 'status,first_response_seconds', {
      workspace_id: req.workspaceId,
    });
    const totals = rows.reduce((acc, row) => {
      acc.total += 1;
      if (row.status === 'open') acc.open += 1;
      if (row.status === 'resolved') acc.resolved += 1;
      if (row.first_response_seconds != null) {
        acc.responseSum += Number(row.first_response_seconds);
        acc.responseCount += 1;
      }
      return acc;
    }, { total: 0, open: 0, resolved: 0, responseSum: 0, responseCount: 0 });
    totals.avg_first_response = totals.responseCount ? totals.responseSum / totals.responseCount : null;
    res.json({
      analytics: {
        conversations: {
          total: Number(totals.total ?? 0),
          open: Number(totals.open ?? 0),
          resolved: Number(totals.resolved ?? 0),
        },
        avgFirstResponseSeconds: totals.avg_first_response
          ? Number(Number(totals.avg_first_response).toFixed(1))
          : null,
      },
    });
  }),
);

// -------------------------------------------------------------------- faqs

router.get(
  '/faqs',
  requireApiScope('faqs:read'),
  asyncHandler(async (req, res) => {
    const rows = await selectRows('faqs', 'id,question,answer,category,keywords,is_active', {
      workspace_id: req.workspaceId,
    }, { order: [{ column: 'id', ascending: true }], limit: 200 });
    res.json({ faqs: rows });
  }),
);

// ---------------------------------------------------------------- channels

router.get(
  '/channels',
  requireApiScope('conversations:read'),
  asyncHandler(async (req, res) => {
    const rows = await selectRows('channels', 'id,type,name,status,created_at', {
      workspace_id: req.workspaceId,
    }, { order: [{ column: 'id', ascending: true }] });
    res.json({ channels: rows });
  }),
);

function mapConversation(row) {
  return {
    id: row.id,
    status: row.status,
    subject: row.subject,
    channel: { id: row.channel_id, type: row.channel_type, name: row.channel_name },
    contact: { externalId: row.contact_external_id, name: row.contact_name },
    assigneeId: row.assignee_id,
    aiHandedOver: Boolean(row.ai_handover),
    aiResolved: Boolean(row.ai_resolved),
    aiSummary: row.ai_summary,
    firstResponseSeconds: row.first_response_seconds,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export default router;
