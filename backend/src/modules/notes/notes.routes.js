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
import { query, queryOne, execute } from '../../db/pool.js';
import { emitToConversation } from '../../services/socket.service.js';
import { EVENTS } from '../../services/events.js';

const router = Router({ mergeParams: true });

const noteParams = z.object({
  conversationId: z.coerce.number().int().positive(),
  noteId: z.coerce.number().int().positive(),
});

/** Loads a note and proves it belongs to the caller's workspace. */
async function ownedNote(req) {
  const note = await queryOne(
    'SELECT * FROM notes WHERE id = ? AND conversation_id = ? AND workspace_id = ?',
    [req.params.noteId, req.params.conversationId, req.workspace.id],
  );
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

const SELECT_NOTE = `
  SELECT n.*, u.full_name AS author_name, u.avatar_url AS author_avatar
    FROM notes n
    LEFT JOIN users u ON u.id = n.user_id
   WHERE n.id = ?`;

// ---------------------------------------------------------------------------

router.get(
  '/',
  authenticate,
  loadWorkspace,
  validate({
    params: z.object({ conversationId: z.coerce.number().int().positive() }),
  }),
  asyncHandler(async (req, res) => {
    const notes = await query(
      `SELECT n.*, u.full_name AS author_name, u.avatar_url AS author_avatar
         FROM notes n
         LEFT JOIN users u ON u.id = n.user_id
        WHERE n.conversation_id = ? AND n.workspace_id = ?
        ORDER BY n.pinned DESC, n.created_at DESC
        LIMIT 200`,
      [req.params.conversationId, req.workspace.id],
    );
    res.json({ notes: notes.map(mapNote) });
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
    const conversation = await queryOne(
      'SELECT id FROM conversations WHERE id = ? AND workspace_id = ?',
      [req.params.conversationId, req.workspace.id],
    );
    if (!conversation) throw AppError.notFound('Conversation not found');

    const { body, pinned } = req.body;

    // Mentions are stored for the notification badge; resolving them to user
    // ids is a Part 8 concern (Socket.IO + email), so we only capture the names.
    const mentions = [...new Set((body.match(/@[\w.-]+/g) ?? []).map((m) => m.slice(1)))];

    const result = await execute(
      `INSERT INTO notes (workspace_id, conversation_id, user_id, body, mentions, pinned)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        req.workspace.id,
        req.params.conversationId,
        req.user.id,
        body,
        JSON.stringify(mentions),
        pinned ? 1 : 0,
      ],
    );

    const created = mapNote(await queryOne(SELECT_NOTE, [result.insertId]));

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

    const fields = [];
    const params = [];
    if (req.body.body !== undefined) {
      fields.push('body = ?');
      params.push(req.body.body);
    }
    if (req.body.pinned !== undefined) {
      fields.push('pinned = ?');
      params.push(req.body.pinned ? 1 : 0);
    }
    await execute(`UPDATE notes SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`, [
      ...params,
      note.id,
    ]);
    const updated = mapNote(await queryOne(SELECT_NOTE, [note.id]));
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
    await execute('DELETE FROM notes WHERE id = ?', [note.id]);
    // Announced before the 204, which carries no body.
    emitToConversation(req.workspace.id, note.conversation_id, EVENTS.NOTE_DELETED, {
      noteId: note.id,
      conversationId: note.conversation_id,
    });
    res.sendStatus(204);
  }),
);

export default router;
