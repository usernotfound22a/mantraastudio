import { Router } from 'express';
import { z } from 'zod';
import { authenticate, loadWorkspace, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler, AppError } from '../../middleware/error.js';
import { findMembership } from '../../services/membership.service.js';
import { selectOne, updateRows } from '../../db/supabase.js';

const router = Router({ mergeParams: true });

function getWorkspaceId(req) {
  return Number(req.params.workspaceId) || req.workspace?.id;
}

// ---------------------------------------------------------------------------
// Upload an attachment (multer, memory storage, stores to /uploads)
// ---------------------------------------------------------------------------

import multer from 'multer';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'node:url';

export const UPLOAD_DIR = process.env.VERCEL
  ? path.join(tmpdir(), 'socialhub-uploads')
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const ALLOWED_MIME = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
  'application/pdf',
  'text/plain',
  'text/csv',
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 10);
      cb(null, `${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_FILE_SIZE, files: 5 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      return cb(new AppError(`Unsupported file type: ${file.mimetype}`, 400));
    }
    cb(null, true);
  },
});

router.post(
  '/attachment',
  authenticate,
  loadWorkspace,
  requireRole('agent', 'admin', 'owner'),
  upload.array('files', 5),
  asyncHandler(async (req, res) => {
    const workspaceId = getWorkspaceId(req);
    const membership = await findMembership(req.user.id, workspaceId);
    if (!membership || membership.status !== 'active') throw AppError.forbidden('Workspace membership required');

    if (!req.files?.length) {
      throw AppError.badRequest('No files were uploaded');
    }

    const attachments = req.files.map((file) => ({
      url: `/uploads/${file.filename}`,
      name: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
    }));

    res.status(201).json({ attachments });
  }),
);

// ---------------------------------------------------------------------------
// Update an AI-generated insight on a conversation (summary, tags, intent)
// ---------------------------------------------------------------------------

router.patch(
  '/:id/ai-insight',
  authenticate,
  loadWorkspace,
  requireRole('admin', 'owner'),
  validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req, res) => {
    const workspaceId = getWorkspaceId(req);
    const membership = await findMembership(req.user.id, workspaceId);
    if (!membership || membership.status !== 'active') throw AppError.forbidden('Workspace membership required');

    const conv = await selectOne('conversations', 'id', { id: req.params.id, workspace_id: workspaceId });
    if (!conv) throw AppError.notFound('Conversation not found');

    const { aiSummary, aiLeadTags, aiIntent, aiResolved } = req.body;
    const changes = {};
    if (aiSummary !== undefined) changes.ai_summary = aiSummary;
    if (aiLeadTags !== undefined) changes.ai_lead_tags = aiLeadTags;
    if (aiIntent !== undefined) changes.intent = aiIntent;
    if (aiResolved !== undefined) changes.ai_resolved = aiResolved ? 1 : 0;
    if (!Object.keys(changes).length) throw AppError.badRequest('No fields provided');
    await updateRows('conversations', changes, { id: conv.id });
    res.sendStatus(204);
  }),
);

export default router;
