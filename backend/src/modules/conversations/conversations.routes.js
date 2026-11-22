/**
 * Conversations - the unified inbox.
 *
 * Nested sub-routers keep the URL readable while still grouping by resource:
 *   GET  /api/conversations                 list (filters + keyset cursor)
 *   GET  /api/conversations/stats           sidebar badge counts
 *   GET  /api/conversations/:id             thread + messages + notes
 *   PATCH /api/conversations/:id/status     open | pending | closed
 *   PATCH /api/conversations/:id/assign     claim for an agent
 *   PATCH /api/conversations/:id/unassign
 *   POST  /api/conversations/:id/read       clear unread
 *   PATCH /api/conversations/:id/handover    AI on <-> human
 *   + /api/conversations/:id/messages       (messages.routes.js)
 *   + /api/conversations/:id/notes          (notes.routes.js)
 */
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, loadWorkspace, requireRole } from '../../middleware/auth.js';
import { validate, queryOf } from '../../middleware/validate.js';
import { asyncHandler, AppError } from '../../middleware/error.js';
import {
  listConversations,
  getConversationById,
  getConversationWithMessages,
  updateConversationStatus,
  assignConversation,
  markConversationRead,
  setAiHandover,
  mapConversationSummary,
} from '../../services/conversation.service.js';
import { selectAllRows } from '../../db/supabase.js';
import { syncMessengerInboxForWorkspace } from '../../services/meta-inbox-sync.service.js';
import messageRoutes from '../messages/messages.routes.js';
import noteRoutes from '../notes/notes.routes.js';

const router = Router();

const idParam = z.object({ conversationId: z.coerce.number().int().positive() });

/**
 * Loads the conversation and proves ownership.
 *
 * Scoping the lookup by workspace_id in the SQL (rather than checking after the
 * fact) means a guessed id from another tenant is indistinguishable from one
 * that does not exist.
 */
async function loadConversation(req, res, next) {
  const conversation = await getConversationById(req.params.conversationId, req.workspace.id);
  if (!conversation) throw AppError.notFound('Conversation not found');
  req.conversation = conversation;
  next();
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

router.get(
  '/',
  authenticate,
  loadWorkspace,
  validate({
    query: z.object({
      status: z.enum(['open', 'pending', 'closed']).optional(),
      channelType: z.string().max(40).optional(),
      // "unassigned" is a real filter (listConversations turns it into
      // `assignee_id IS NULL`), so it has to survive validation: coercing it to
      // a number would turn the inbox's "Unassigned" tab into a 400.
      assigneeId: z
        .union([z.literal('unassigned'), z.coerce.number().int().positive()])
        .optional(),
      search: z.string().trim().max(120).optional(),
      unreadOnly: z.enum(['true', 'false']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
      cursor: z.coerce.number().int().positive().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { status, channelType, assigneeId, search, unreadOnly, limit, cursor } = queryOf(req);
    await syncMessengerInboxForWorkspace(req.workspace.id);
    const result = await listConversations(req.workspace.id, {
      status,
      channelType,
      assigneeId,
      search,
      unreadOnly: unreadOnly === 'true',
      limit,
      cursor,
    });
    res.json(result);
  }),
);

/**
 * Sidebar badges. One grouped query per metric instead of N, because the inbox
 * polls this on a timer.
 */
router.get(
  '/stats',
  authenticate,
  loadWorkspace,
  asyncHandler(async (req, res) => {
    const workspaceId = req.workspace.id;

    const conversations = await selectAllRows(
      'conversations',
      'status,unread_count,assignee_id,ai_enabled,ai_handover',
      { workspace_id: workspaceId },
    );

    const totals = { open: 0, pending: 0, closed: 0, unread: 0, mine: 0, aiActive: 0 };
    for (const row of conversations) {
      totals[row.status] += 1;
      if (row.unread_count > 0) totals.unread += 1;
      if (row.assignee_id === req.user.id && row.status !== 'closed') totals.mine += 1;
      if (row.ai_enabled && !row.ai_handover && row.status === 'open') totals.aiActive += 1;
    }

    res.json({ stats: totals });
  }),
);

// ---------------------------------------------------------------------------
// Thread detail
// ---------------------------------------------------------------------------

router.get(
  '/:conversationId',
  authenticate,
  loadWorkspace,
  validate({
    params: idParam,
    query: z.object({
      before: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { before, limit } = queryOf(req);
    const result = await getConversationWithMessages(
      req.params.conversationId,
      req.workspace.id,
      { before, limit },
    );
    res.json(result);
  }),
);

// ---------------------------------------------------------------------------
// State changes
// ---------------------------------------------------------------------------

router.patch(
  '/:conversationId/status',
  authenticate,
  loadWorkspace,
  loadConversation,
  requireRole('agent', 'admin', 'owner'),
  validate({
    params: idParam,
    body: z.object({ status: z.enum(['open', 'pending', 'closed']) }),
  }),
  asyncHandler(async (req, res) => {
    const updated = await updateConversationStatus(
      req.conversation,
      req.body.status,
      req.user.id,
    );
    res.json({ conversation: mapConversationSummary(updated) });
  }),
);

router.patch(
  '/:conversationId/assign',
  authenticate,
  loadWorkspace,
  loadConversation,
  requireRole('agent', 'admin', 'owner'),
  validate({
    params: idParam,
    body: z.object({ assigneeId: z.coerce.number().int().positive() }),
  }),
  asyncHandler(async (req, res) => {
    // assignConversation() checks the target is an active member of this
    // workspace, so you cannot hand a thread to someone outside the tenant.
    const updated = await assignConversation(req.conversation, req.body.assigneeId, req.user.id);
    res.json({ conversation: mapConversationSummary(updated) });
  }),
);

router.patch(
  '/:conversationId/unassign',
  authenticate,
  loadWorkspace,
  loadConversation,
  requireRole('agent', 'admin', 'owner'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const updated = await assignConversation(req.conversation, null, req.user.id);
    res.json({ conversation: mapConversationSummary(updated) });
  }),
);

router.post(
  '/:conversationId/read',
  authenticate,
  loadWorkspace,
  loadConversation,
  requireRole('agent', 'admin', 'owner'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const updated = await markConversationRead(req.conversation);
    res.json({ conversation: mapConversationSummary(updated) });
  }),
);

/**
 * "Take over" / "give the AI back". This is the manual half of the handover
 * logic; the automatic half (low confidence, angry customer) lands in Part 7.
 */
router.patch(
  '/:conversationId/handover',
  authenticate,
  loadWorkspace,
  loadConversation,
  requireRole('agent', 'admin', 'owner'),
  validate({
    params: idParam,
    body: z.object({
      handedOver: z.boolean(),
      reason: z.string().trim().max(255).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const updated = await setAiHandover(
      req.conversation,
      req.body.handedOver,
      req.body.reason ?? null,
    );
    res.json({ conversation: mapConversationSummary(updated) });
  }),
);

// Nested resources. Registered last so they cannot shadow /:conversationId.
router.use('/:conversationId/messages', messageRoutes);
router.use('/:conversationId/notes', noteRoutes);

export default router;
