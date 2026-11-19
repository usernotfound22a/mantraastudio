/**
 * Internal notes on a conversation. Mounted at
 * /api/conversations/:conversationId/notes
 *
 *   GET  /  list (pinned first)
 *   POST /  create  (extracts @mentions automatically)
 *   PATCH /:noteId  edit
 *   DELETE /:noteId  remove
 *
 * Notes never leave the workspace: there is deliberately no adapter call here.
 * That is the whole difference between a note and a message.
 */
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, loadWorkspace, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler, AppError } from '../../middleware/error.js';
import { getSupabaseClient, selectRows, selectOne, insertRow, updateRows, deleteRows } from '../../db/supabase.js';
import { emitToConversation } from '../../services/socket.service.js';
import { EVENTS } from '../../services/events.js';

const router = Router({ mergeParams: true });

const noteParams = z.object({
  conversationId: z.coerce.number().int().positive(),
  noteId: z.coerce.number().int().positive(),
});

/** Loads a note and proves it belongs to the caller's workspace. */
async function ownedNote(req) {
  const note = await selectOne('notes', '*', {
    id: req.params.noteId,
    conversation_id: req.params.conversationId,
    workspace_id: req.workspace.id,
  });
  if (!note) throw AppError.notFound('Note not found');
  return note;
}

/** Only the author, an admin or the owner may edit or delete a note. */
function assertCanModify(req, note) {
  const isAuthor = note.user_id === req.user.id;
  const isPrivileged = ['admin', 'owner'].includes(req.member.role);
  if (!isAuthor && !isPrivileged) {
    throw AppError.forbidden('Only the author or an admin can change this note');
  }
}

const mapNote = (note) => ({
  id: note.id,
  conversationId: note.conversation_id,
  body: note.body,
  pinned: Boolean(note.pinned),
  author: { id: note.user_id, name: note.author_name ?? null, avatarUrl: note.author_avatar ?? null },
  mentions: note.mentions ?? [],
  createdAt: note.created_at,
  updatedAt: note.updated_at,
});

async function selectNoteWithAuthor(id) {
  const { data, error } = await getSupabaseClient()
    .from('notes')
    .select('*,users(full_name,avatar_url)')
    .eq('id', id)
    .single();
  if (error) throw error;
  return {
    ...data,
    author_name: data.users?.full_name ?? null,
    author_avatar: data.users?.avatar_url ?? null,
  };
}

// ---------------------------------------------------------------------------

router.get(
  '/',
  authenticate,
  loadWorkspace,
  validate({
    params: z.object({ conversationId: z.coerce.number().int().positive() }),
  }),
  asyncHandler(async (req, res) => {
    const notes = await selectRows('notes', '*,users(full_name,avatar_url)', {
      conversation_id: req.params.conversationId,
      workspace_id: req.workspace.id,
    }, {
      order: [{ column: 'pinned', ascending: false }, { column: 'created_at', ascending: false }],
      limit: 200,
    });
    const normalized = notes.map((note) => ({
      ...note,
      author_name: note.users?.full_name ?? null,
      author_avatar: note.users?.avatar_url ?? null,
    }));
    res.json({ notes: normalized.map(mapNote) });
  }),
);

router.post(
  '/',
  authenticate,
  loadWorkspace,
  requireRole('agent', 'admin', 'owner'),
  validate({
    params: z.object({ conversationId: z.coerce.number().int().positive() }),
    body: z.object({
      body: z.string().trim().min(1, 'A note cannot be empty').max(5000),
      pinned: z.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    // Confirm the conversation is real in this workspace before writing.
    const conversation = await selectOne('conversations', 'id', {
      id: req.params.conversationId,
      workspace_id: req.workspace.id,
    });
    if (!conversation) throw AppError.notFound('Conversation not found');

    const { body, pinned } = req.body;

    // Mentions are stored for the notification badge; resolving them to user
    // ids is a Part 8 concern (Socket.IO + email), so we only capture the names.
    const mentions = [...new Set((body.match(/@[\w.-]+/g) ?? []).map((m) => m.slice(1)))];

    const inserted = await insertRow('notes', {
      workspace_id: req.workspace.id,
      conversation_id: req.params.conversationId,
      user_id: req.user.id,
      body,
      mentions,
      pinned,
    });
    const created = mapNote(await selectNoteWithAuthor(inserted.id));

    // Other agents watching the thread see the note appear without polling.
    emitToConversation(req.workspace.id, req.params.conversationId, EVENTS.NOTE_CREATED, {
      note: created,
    });

    res.status(201).json({ note: created });
  }),
);

router.patch(
  '/:noteId',
  authenticate,
  loadWorkspace,
  requireRole('agent', 'admin', 'owner'),
  validate({
    params: noteParams,
    body: z
      .object({
        body: z.string().trim().min(1).max(5000).optional(),
        pinned: z.boolean().optional(),
      })
      .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' }),
  }),
  asyncHandler(async (req, res) => {
    const note = await ownedNote(req);
    assertCanModify(req, note);

    const fields = {};
    if (req.body.body !== undefined) {
      fields.body = req.body.body;
    }
    if (req.body.pinned !== undefined) {
      fields.pinned = req.body.pinned;
    }
    const [updatedRow] = await updateRows('notes', fields, { id: note.id });
    const updated = mapNote(await selectNoteWithAuthor(updatedRow.id));
    emitToConversation(req.workspace.id, note.conversation_id, EVENTS.NOTE_UPDATED, { note: updated });
    res.json({ note: updated });
  }),
);

router.delete(
  '/:noteId',
  authenticate,
  loadWorkspace,
  requireRole('agent', 'admin', 'owner'),
  validate({ params: noteParams }),
  asyncHandler(async (req, res) => {
    const note = await ownedNote(req);
    assertCanModify(req, note);
    await deleteRows('notes', { id: note.id });
    // Announced before the 204, which carries no body.
    emitToConversation(req.workspace.id, note.conversation_id, EVENTS.NOTE_DELETED, {
      noteId: note.id,
      conversationId: note.conversation_id,
    });
    res.sendStatus(204);
  }),
);

export default router;
