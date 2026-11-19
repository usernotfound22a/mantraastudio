/**
 * Analytics routes (Part 8).
 *
 * Read-only and workspace-scoped. `agent` and `admin` both may look at the
 * numbers, but the per-agent leaderboard exposes individual performance, so it
 * is `admin`/`owner` only.
 */
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, loadWorkspace, requireRole } from '../../middleware/auth.js';
import { validate, queryOf } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/error.js';
import { selectAllRows } from '../../db/supabase.js';
import {
  RANGES,
  resolveRange,
  overview,
  timeseries,
  byChannel,
  byAgent,
  aiPerformance,
  faqPerformance,
} from '../../services/analytics.service.js';

const router = Router();

const rangeQuery = z.object({
  range: z.enum(['7d', '30d', '90d']).default('30d'),
});

/** Everything the dashboard needs, in one request - one round trip, one query each. */
router.get(
  '/overview',
  authenticate,
  loadWorkspace,
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const { range, since } = resolveRange(queryOf(req).range);
    const [summary, daily, channels] = await Promise.all([
      overview(req.workspace.id, since),
      timeseries(req.workspace.id, since),
      byChannel(req.workspace.id, since),
    ]);

    res.json({
      range,
      since,
      summary,
      daily: daily.map((row) => ({
        day: row.day,
        conversations: Number(row.conversations),
        aiResolved: Number(row.ai_resolved ?? 0),
        handovers: Number(row.handovers ?? 0),
        avgFirstResponse:
          row.avg_first_response === null ? null : Math.round(Number(row.avg_first_response)),
      })),
      channels: channels.map((row) => ({
        channel: row.channel,
        conversations: Number(row.conversations),
        messages: Number(row.messages ?? 0),
        aiResolved: Number(row.ai_resolved ?? 0),
        handovers: Number(row.handovers ?? 0),
        avgFirstResponse:
          row.avg_first_response === null ? null : Math.round(Number(row.avg_first_response)),
        avgResolution:
          row.avg_resolution === null ? null : Math.round(Number(row.avg_resolution)),
      })),
    });
  }),
);

/** The assistant's own report card. */
router.get(
  '/ai',
  authenticate,
  loadWorkspace,
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const { range, since } = resolveRange(queryOf(req).range);
    res.json({ range, since, ...(await aiPerformance(req.workspace.id, since)) });
  }),
);

/** FAQ hit rates, so an owner can see which entries earn their keep. */
router.get(
  '/faqs',
  authenticate,
  loadWorkspace,
  asyncHandler(async (req, res) => {
    const rows = await faqPerformance(req.workspace.id);
    res.json({
      faqs: rows.map((row) => ({
        id: row.id,
        question: row.question,
        category: row.category,
        matchCount: Number(row.match_count),
        noMatchCount: Number(row.no_match_count),
        hitRate: row.hit_rate === null ? null : Number(row.hit_rate),
        isActive: Boolean(row.is_active),
      })),
    });
  }),
);

/** Per-agent performance. Restricted: it reports on named individuals. */
router.get(
  '/agents',
  authenticate,
  loadWorkspace,
  requireRole('admin', 'owner'),
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const { range, since } = resolveRange(queryOf(req).range);
    const rows = await byAgent(req.workspace.id, since);
    res.json({
      range,
      agents: rows.map((row) => ({
        agentId: row.agent_id,
        name: row.name,
        email: row.email,
        assigned: Number(row.assigned ?? 0),
        closed: Number(row.closed ?? 0),
        handovers: Number(row.handovers ?? 0),
        avgFirstResponse:
          row.avg_first_response === null ? null : Math.round(Number(row.avg_first_response)),
        avgResolution:
          row.avg_resolution === null ? null : Math.round(Number(row.avg_resolution)),
      })),
    });
  }),
);

/**
 * CSV export of the conversation log. Streamed as a download so the dashboard
 * can hand it straight to a report, and every value is quoted/escaped because
 * customer text may contain commas, quotes or newlines.
 */
router.get(
  '/export',
  authenticate,
  loadWorkspace,
  requireRole('admin', 'owner'),
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const { range, since } = resolveRange(queryOf(req).range);
    const conversations = await selectAllRows(
      'conversations',
      'id,created_at,status,resolved_at,ai_resolved,ai_handover,ai_handover_reason,ai_confidence,first_response_seconds,contact_name,contact_email,channels(type)',
      { workspace_id: req.workspace.id },
      { gte: { created_at: since.toISOString() }, order: [{ column: 'created_at', ascending: false }] },
    );
    const messages = conversations.length
      ? await selectAllRows('messages', 'conversation_id', { workspace_id: req.workspace.id }, {
        in: { conversation_id: conversations.map((row) => row.id) },
      })
      : [];
    const counts = new Map();
    for (const message of messages) {
      counts.set(message.conversation_id, (counts.get(message.conversation_id) ?? 0) + 1);
    }
    const rows = conversations.map((row) => ({
      ...row,
      channel: row.channels?.type ?? null,
      visitor_name: row.contact_name,
      visitor_email: row.contact_email,
      message_count: counts.get(row.id) ?? 0,
    }));

    const header = [
      'id',
      'created_at',
      'channel',
      'status',
      'visitor_name',
      'visitor_email',
      'messages',
      'ai_replied',
      'ai_handover',
      'handover_reason',
      'ai_confidence',
      'first_response_seconds',
      'resolved_at',
    ];

    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push(
        [
          row.id,
          row.created_at,
          row.channel,
          row.status,
          row.visitor_name,
          row.visitor_email,
          row.message_count,
          row.ai_resolved ? 'yes' : 'no',
          row.ai_handover ? 'yes' : 'no',
          row.ai_handover_reason ?? '',
          row.ai_confidence ?? '',
          row.first_response_seconds ?? '',
          row.resolved_at ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
    }

    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="conversations-${range}.csv"`);
    // BOM so Excel opens the UTF-8 names correctly.
    res.send(`\ufeff${lines.join('\r\n')}\r\n`);
  }),
);

const csvCell = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  // A leading =, +, - or @ makes Excel treat the cell as a formula.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export default router;
