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
import { query, queryOne } from '../../db/pool.js';
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

    const params = [req.workspaceId];
    let where = 'c.workspace_id = ?';
    if (status !== 'all') {
      where += ' AND c.status = ?';
      params.push(status);
    }
    // Keyset pagination: stable and cheap, unlike OFFSET on a growing table.
    if (cursor) {
      where += ' AND c.id < ?';
      params.push(cursor);
    }

    const rows = await query(
      `SELECT c.*, ch.type AS channel_type, ch.name AS channel_name
         FROM conversations c
         JOIN channels ch ON ch.id = c.channel_id
        WHERE ${where}
        ORDER BY c.id DESC
        LIMIT ${Number(limit) + 1}`,
      params,
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

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
    const conversation = await queryOne(
      `SELECT c.*, ch.type AS channel_type, ch.name AS channel_name
         FROM conversations c
         JOIN channels ch ON ch.id = c.channel_id
        WHERE c.id = ? AND c.workspace_id = ?`,
      [req.params.id, req.workspaceId],
    );
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
    const conversation = await queryOne(
      'SELECT id FROM conversations WHERE id = ? AND workspace_id = ?',
      [req.params.id, req.workspaceId],
    );
    if (!conversation) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
      return;
    }

    if (status) {
      await query('UPDATE conversations SET status = ?, resolved_at = ? WHERE id = ?', [
        status,
        status === 'resolved' ? new Date() : null,
        req.params.id,
      ]);
    }
    if (assigneeId !== undefined) {
      if (assigneeId === null) {
        await query('UPDATE conversations SET assignee_id = NULL WHERE id = ?', [req.params.id]);
      } else {
        // The assignee must be a member of THIS workspace, not any user id.
        const member = await queryOne(
          'SELECT 1 AS ok FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
          [req.workspaceId, assigneeId],
        );
        if (!member) {
          res.status(400).json({
            error: { code: 'BAD_REQUEST', message: 'assigneeId is not a member of this workspace' },
          });
          return;
        }
        await query('UPDATE conversations SET assignee_id = ? WHERE id = ?', [assigneeId, req.params.id]);
      }
    }

    const fresh = await queryOne(
      `SELECT c.*, ch.type AS channel_type, ch.name AS channel_name
         FROM conversations c
         JOIN channels ch ON ch.id = c.channel_id
        WHERE c.id = ?`,
      [req.params.id],
    );
    res.json({ conversation: mapConversation(fresh) });
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
    const rows = await query(
      `SELECT m.*, u.full_name AS sender_display_name, u.avatar_url AS sender_display_avatar
         FROM messages m
         LEFT JOIN users u ON u.id = m.sender_id
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.conversation_id = ? AND c.workspace_id = ?
        ORDER BY m.id DESC
        LIMIT ${Number(queryOf(req).limit)}`,
      [req.params.id, req.workspaceId],
    );
    // Returned oldest-first, which is how a chat transcript reads.
    res.json({ messages: rows.reverse().map(mapMessage) });
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

    const conversation = await queryOne(
      // The channel row is needed in full, not just id/type/status: adapters read
      // their credentials out of `config`, so a partial row makes real delivery
      // (Messenger/Instagram) fail with a missing access token.
      `SELECT c.*, ch.id AS ch_id, ch.type AS ch_type, ch.status AS ch_status, ch.name AS ch_name,
              ch.external_id AS ch_external_id, ch.config AS ch_config, ch.workspace_id AS ch_workspace_id
         FROM conversations c
         JOIN channels ch ON ch.id = c.channel_id
        WHERE c.id = ? AND c.workspace_id = ?`,
      [req.params.id, req.workspaceId],
    );
    if (!conversation) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
      return;
    }

    // Same shape channels.service.js hands to the factory.
    const rawConfig = typeof conversation.ch_config === 'string'
      ? JSON.parse(conversation.ch_config)
      : (conversation.ch_config ?? {});
    const channel = {
      id: conversation.ch_id,
      type: conversation.ch_type,
      status: conversation.ch_status,
      name: conversation.ch_name,
      external_id: conversation.ch_external_id,
      config: rawConfig,
      workspace_id: conversation.ch_workspace_id ?? req.workspaceId,
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
    const [totals] = await query(
      `SELECT
         COUNT(*) AS total,
         SUM(status = 'open')    AS open,
         SUM(status = 'resolved') AS resolved,
         AVG(first_response_seconds) AS avg_first_response
       FROM conversations WHERE workspace_id = ?`,
      [req.workspaceId],
    );
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
    const rows = await query(
      'SELECT id, question, answer, category, keywords, is_active FROM faqs WHERE workspace_id = ? ORDER BY id LIMIT 200',
      [req.workspaceId],
    );
    res.json({ faqs: rows });
  }),
);

// ---------------------------------------------------------------- channels

router.get(
  '/channels',
  requireApiScope('conversations:read'),
  asyncHandler(async (req, res) => {
    const rows = await query(
      'SELECT id, type, name, status, created_at FROM channels WHERE workspace_id = ? ORDER BY id',
      [req.workspaceId],
    );
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
