/**
 * FAQ knowledge base - the data the AI assistant answers from.
 *
 *   GET  /            list (filter by category, search, include archived)
 *   POST /            create
 *   PATCH /:id        update / archive
 *   DELETE /:id       delete
 *   POST /import      bulk import (array or pasted CSV) -> report per-row errors
 *   GET /top          most-used + never-matched entries (the "what should I add?" list)
 *   POST /:id/reset-stats
 *
 * Search is a POST-free GET here on purpose: the AI service calls the service
 * function directly, not this route.
 */
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, loadWorkspace, requireRole } from '../../middleware/auth.js';
import { validate, queryOf } from '../../middleware/validate.js';
import { asyncHandler, AppError } from '../../middleware/error.js';
import { query, queryOne, execute } from '../../db/pool.js';
import { searchFaqs, listUnansweredQuestions } from '../../services/faq.service.js';
import { emitToWorkspace } from '../../services/socket.service.js';
import { EVENTS } from '../../services/events.js';

const router = Router();

const idParam = z.object({ faqId: z.coerce.number().int().positive() });

const mapFaq = (faq) => ({
  id: faq.id,
  question: faq.question,
  answer: faq.answer,
  keywords: typeof faq.keywords === 'string' ? JSON.parse(faq.keywords || '[]') : (faq.keywords ?? []),
  tags: typeof faq.tags === 'string' ? JSON.parse(faq.tags || '[]') : (faq.tags ?? []),
  category: faq.category,
  source: faq.source,
  isActive: Boolean(faq.is_active),
  matchCount: faq.match_count,
  noMatchCount: faq.no_match_count,
  lastMatchedAt: faq.last_matched_at,
  createdAt: faq.created_at,
  updatedAt: faq.updated_at,
});

/** Loads an FAQ scoped to the workspace. */
async function ownedFaq(req) {
  const faq = await queryOne('SELECT * FROM faqs WHERE id = ? AND workspace_id = ?', [
    req.params.faqId,
    req.workspace.id,
  ]);
  if (!faq) throw AppError.notFound('FAQ not found');
  return faq;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

router.get(
  '/',
  authenticate,
  loadWorkspace,
  validate({
    query: z.object({
      search: z.string().trim().max(200).optional(),
      category: z.string().trim().max(120).optional(),
      includeArchived: z.enum(['true', 'false']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { search, category, includeArchived } = queryOf(req);

    const where = ['workspace_id = ?'];
    const params = [req.workspace.id];
    if (includeArchived !== 'true') where.push('is_active = 1');
    if (category) {
      where.push('category = ?');
      params.push(category);
    }
    if (search) {
      where.push('(question LIKE ? OR answer LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    const faqs = await query(
      `SELECT * FROM faqs WHERE ${where.join(' AND ')} ORDER BY match_count DESC, created_at DESC LIMIT 500`,
      params,
    );

    // Distinct categories for the filter dropdown, in one extra query.
    const categories = await query(
      'SELECT DISTINCT category FROM faqs WHERE workspace_id = ? AND category IS NOT NULL ORDER BY category',
      [req.workspace.id],
    );

    res.json({
      faqs: faqs.map(mapFaq),
      categories: categories.map((row) => row.category),
    });
  }),
);

/**
 * Knowledge-base health. "match_count = 0" entries are dead weight and
 * "no_match_count > 0" gaps are the questions customers asked that we cannot
 * answer - both are findings for the report.
 */
router.get(
  '/top',
  authenticate,
  loadWorkspace,
  asyncHandler(async (req, res) => {
    const faqs = await query(
      `SELECT id, question, category, match_count, no_match_count, last_matched_at
         FROM faqs
        WHERE workspace_id = ? AND is_active = 1
        ORDER BY match_count DESC, last_matched_at DESC
        LIMIT 10`,
      [req.workspace.id],
    );
    const unused = await query(
      `SELECT id, question, category FROM faqs
        WHERE workspace_id = ? AND is_active = 1 AND match_count = 0
        ORDER BY created_at DESC LIMIT 10`,
      [req.workspace.id],
    );
    res.json({ mostUsed: faqs, neverMatched: unused });
  }),
);

/** Preview the retriever against a question - useful when tuning the AI. */
router.get(
  '/search',
  authenticate,
  loadWorkspace,
  validate({
    query: z.object({
      q: z.string().trim().min(1, 'Provide a question').max(500),
      limit: z.coerce.number().int().min(1).max(10).default(3),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { q: question, limit } = queryOf(req);
    const results = await searchFaqs(req.workspace.id, question, limit);
    res.json({
      results: results.map((result) => ({
        faqId: result.faq.id,
        question: result.faq.question,
        score: Number(result.score.toFixed(4)),
        matchedTokens: result.tokens,
      })),
    });
  }),
);

/**
 * The knowledge base's blind spots: real questions the AI could not answer,
 * deduped and ranked by how often they were asked. This is the "improve me"
 * list, and it closes the loop with the AI - every unanswered question is
 * actionable.
 */
router.get(
  '/unanswered',
  authenticate,
  loadWorkspace,
  validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) }),
  asyncHandler(async (req, res) => {
    const rows = await listUnansweredQuestions(req.workspace.id, queryOf(req).limit);
    res.json({
      questions: rows.map((row) => ({
        id: row.id,
        question: row.question,
        occurrences: row.occurrences,
        firstAskedAt: row.first_asked_at,
        lastAskedAt: row.last_asked_at,
      })),
      total: rows.length,
    });
  }),
);

/**
 * Turns an unanswered question into a real FAQ entry and closes the gap, so
 * the next customer asking the same thing gets a real answer.
 */
router.post(
  '/unanswered/:id/resolve',
  authenticate,
  loadWorkspace,
  requireRole('admin', 'owner'),
  validate({
    params: z.object({ id: z.coerce.number().int().positive() }),
    body: z.object({
      answer: z.string().trim().min(1, 'Add the answer the AI should give').max(4000),
      category: z.string().trim().max(100).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const missing = await queryOne(
      'SELECT * FROM unanswered_questions WHERE id = ? AND workspace_id = ?',
      [req.params.id, req.workspace.id],
    );
    if (!missing) throw AppError.notFound('That unanswered question no longer exists');

    const created = await execute(
      `INSERT INTO faqs (workspace_id, question, answer, category, source, created_by)
       VALUES (?, ?, ?, ?, 'learned', ?)`,
      [req.workspace.id, missing.question, req.body.answer, req.body.category ?? 'General', req.user.id],
    );
    await execute('DELETE FROM unanswered_questions WHERE id = ?', [missing.id]);

    const faq = await queryOne('SELECT * FROM faqs WHERE id = ?', [created.insertId]);
    emitToWorkspace(req.workspace.id, EVENTS.FAQ_CREATED, { faq: mapFaq(faq) });
    res.status(201).json({ faq: mapFaq(faq), resolvedFrom: missing.question });
  }),
);

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

router.post(
  '/',
  authenticate,
  loadWorkspace,
  requireRole('admin', 'owner'),
  validate({
    body: z.object({
      question: z.string().trim().min(3, 'Question is too short').max(500),
      answer: z.string().trim().min(1, 'Answer is required').max(5000),
      keywords: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
      tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
      category: z.string().trim().max(120).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { question, answer, keywords, tags, category } = req.body;
    const result = await execute(
      `INSERT INTO faqs (workspace_id, question, answer, keywords, tags, category, source, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)`,
      [req.workspace.id, question, answer, JSON.stringify(keywords), JSON.stringify(tags), category ?? null, req.user.id],
    );
    const created = mapFaq(await queryOne('SELECT * FROM faqs WHERE id = ?', [result.insertId]));
    // The knowledge base is shared, so every other tab's settings page refreshes.
    emitToWorkspace(req.workspace.id, EVENTS.FAQ_CREATED, { faq: created });
    res.status(201).json({ faq: created });
  }),
);

/**
 * Bulk import. Accepts a JSON array or raw CSV text, and reports failures per
 * row instead of rejecting the whole file - a 200-row upload with three typos
 * should not force the user to start again.
 */
router.post(
  '/import',
  authenticate,
  loadWorkspace,
  requireRole('admin', 'owner'),
  validate({
    body: z.union([
      z.object({ format: z.literal('csv').optional(), csv: z.string().min(1) }),
      z.object({
        format: z.literal('json').optional(),
        entries: z
          .array(
            z.object({
              question: z.string().trim().min(3).max(500),
              answer: z.string().trim().min(1).max(5000),
              keywords: z.array(z.string()).optional(),
              category: z.string().trim().max(120).optional(),
            }),
          )
          .min(1)
          .max(1000),
      }),
    ]),
  }),
  asyncHandler(async (req, res) => {
    const entries = Array.isArray(req.body.entries)
      ? req.body.entries
      : parseCsv(req.body.csv);

    if (entries.length === 0) {
      throw AppError.badRequest('Nothing to import - check the CSV header row');
    }

    let imported = 0;
    const errors = [];

    for (const [index, entry] of entries.entries()) {
      try {
        await execute(
          `INSERT INTO faqs (workspace_id, question, answer, keywords, tags, category, source, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 'imported', ?)`,
          [
            req.workspace.id,
            entry.question,
            entry.answer,
            JSON.stringify(entry.keywords ?? []),
            JSON.stringify([]),
            entry.category ?? null,
            req.user.id,
          ],
        );
        imported += 1;
      } catch (error) {
        errors.push({ row: index + 1, question: entry.question?.slice(0, 80), error: error.message });
      }
    }

    res.status(imported > 0 ? 201 : 422).json({ imported, failed: errors.length, errors });
  }),
);

/** Minimal RFC-4180-ish parser: handles quoted fields and escaped quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);

  if (rows.length < 2) return [];
  const [header, ...body] = rows;
  const columnIndex = (name) =>
    header.findIndex((cell) => cell.trim().toLowerCase().replace(/\s+/g, '_') === name);

  const qIndex = columnIndex('question');
  const aIndex = columnIndex('answer');
  if (qIndex === -1 || aIndex === -1) return [];

  const kIndex = columnIndex('keywords');
  const cIndex = columnIndex('category');

  return body.map((cells) => ({
    question: (cells[qIndex] ?? '').trim(),
    answer: (cells[aIndex] ?? '').trim(),
    keywords: kIndex !== -1 ? (cells[kIndex] ?? '').split('|').map((k) => k.trim()).filter(Boolean) : [],
    category: cIndex !== -1 ? (cells[cIndex] ?? '').trim() || null : null,
  }));
}

router.patch(
  '/:faqId',
  authenticate,
  loadWorkspace,
  requireRole('admin', 'owner'),
  validate({
    params: idParam,
    body: z
      .object({
        question: z.string().trim().min(3).max(500).optional(),
        answer: z.string().trim().min(1).max(5000).optional(),
        keywords: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
        tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
        category: z.string().trim().max(120).nullable().optional(),
        isActive: z.boolean().optional(),
      })
      .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' }),
  }),
  asyncHandler(async (req, res) => {
    const faq = await ownedFaq(req);

    const fields = [];
    const params = [];
    for (const [key, column] of [
      ['question', 'question'],
      ['answer', 'answer'],
      ['keywords', 'keywords'],
      ['tags', 'tags'],
    ]) {
      if (req.body[key] !== undefined) {
        fields.push(`${column} = ?`);
        params.push(JSON.stringify(req.body[key]));
      }
    }
    if (req.body.category !== undefined) {
      fields.push('category = ?');
      params.push(req.body.category);
    }
    if (req.body.isActive !== undefined) {
      fields.push('is_active = ?');
      params.push(req.body.isActive ? 1 : 0);
    }

    await execute(`UPDATE faqs SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`, [
      ...params,
      faq.id,
    ]);
    const updated = mapFaq(await queryOne('SELECT * FROM faqs WHERE id = ?', [faq.id]));
    emitToWorkspace(req.workspace.id, EVENTS.FAQ_UPDATED, { faq: updated });
    res.json({ faq: updated });
  }),
);

/** Archives instead of deleting when an FAQ is referenced by past messages. */
router.delete(
  '/:faqId',
  authenticate,
  loadWorkspace,
  requireRole('admin', 'owner'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const faq = await ownedFaq(req);
    const referenced = await queryOne(
      'SELECT COUNT(*) AS total FROM conversations WHERE ai_last_faq_id = ?',
      [faq.id],
    );

    if (referenced.total > 0) {
      await execute('UPDATE faqs SET is_active = 0, updated_at = NOW() WHERE id = ?', [faq.id]);
      const archived = mapFaq(await queryOne('SELECT * FROM faqs WHERE id = ?', [faq.id]));
      // Same event either way: the entry is gone from the AI's point of view,
      // whether it was archived or hard-deleted.
      emitToWorkspace(req.workspace.id, EVENTS.FAQ_DELETED, { faqId: faq.id, archived: true });
      return res.json({
        archived: true,
        faq: archived,
        reason: 'This FAQ is referenced by past conversations, so it was archived instead of deleted.',
      });
    }

    await execute('DELETE FROM faqs WHERE id = ?', [faq.id]);
    emitToWorkspace(req.workspace.id, EVENTS.FAQ_DELETED, { faqId: faq.id, archived: false });
    return res.sendStatus(204);
  }),
);

router.post(
  '/:faqId/reset-stats',
  authenticate,
  loadWorkspace,
  requireRole('admin', 'owner'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const faq = await ownedFaq(req);
    await execute(
      'UPDATE faqs SET match_count = 0, no_match_count = 0, last_matched_at = NULL WHERE id = ?',
      [faq.id],
    );
    const updated = mapFaq(await queryOne('SELECT * FROM faqs WHERE id = ?', [faq.id]));
    emitToWorkspace(req.workspace.id, EVENTS.FAQ_UPDATED, { faq: updated });
    res.json({ faq: updated });
  }),
);

export default router;
