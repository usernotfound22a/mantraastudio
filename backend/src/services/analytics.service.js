/**
 * Analytics (Part 8).
 *
 * Every query here is workspace-scoped in the WHERE clause, never applied after
 * the fact, so one workspace can never see another's numbers. The only inputs
 * are a validated range and the workspace id.
 *
 * The dashboard shows two things that matter for this project:
 *   - where the AI actually saved time (AI resolution rate, handovers, the
 *     questions it could not answer)
 *   - where the humans are slow (first response and resolution time per agent)
 */
import { query, queryOne } from '../db/pool.js';

/** Named ranges keep the API surface small and the SQL injection-free. */
export const RANGES = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

export function resolveRange(range) {
  const days = RANGES[range] ?? RANGES['30d'];
  return { range: RANGES[range] ? range : '30d', days, since: new Date(Date.now() - days * 86400000) };
}

/** Headline numbers for the dashboard cards. */
export async function overview(workspaceId, since) {
  const totals = await queryOne(
    `SELECT
        COUNT(*)                                                   AS conversations,
        SUM(status = 'open')                                       AS open,
        SUM(status = 'pending')                                    AS pending,
        SUM(status = 'closed')                                     AS closed,
        SUM(ai_handover = 1)                                       AS handed_over,
        SUM(ai_resolved = 1)                                       AS ai_resolved,
        AVG(NULLIF(first_response_seconds, 0))                    AS avg_first_response,
        AVG(NULLIF(TIMESTAMPDIFF(SECOND, created_at, resolved_at), 0)) AS avg_resolution_seconds,
        SUM(ai_message_count)                                      AS ai_messages
      FROM conversations
     WHERE workspace_id = ? AND created_at >= ?`,
    [workspaceId, since],
  );

  const previous = await queryOne(
    `SELECT COUNT(*) AS conversations
       FROM conversations
      WHERE workspace_id = ? AND created_at >= ? AND created_at < ?`,
    [workspaceId, new Date(since.getTime() - 30 * 86400000), since],
  );

  const satisfaction = await queryOne(
    `SELECT COUNT(*) AS rated, AVG(rating) AS avg_rating
       FROM message_feedback
      WHERE workspace_id = ? AND created_at >= ?`,
    [workspaceId, since],
  );

  const total = Number(totals.conversations ?? 0);
  return {
    conversations: total,
    open: Number(totals.open ?? 0),
    pending: Number(totals.pending ?? 0),
    closed: Number(totals.closed ?? 0),
    handedOver: Number(totals.handed_over ?? 0),
    aiResolved: Number(totals.ai_resolved ?? 0),
    // The headline number for the FYP: what share of threads the AI closed on
    // its own, with no human involved.
    aiResolutionRate: total ? round((Number(totals.ai_resolved) / total) * 100, 1) : 0,
    handoverRate: total ? round((Number(totals.handed_over) / total) * 100, 1) : 0,
    avgFirstResponseSeconds: totals.avg_first_response === null ? null : Math.round(Number(totals.avg_first_response)),
    avgResolutionSeconds:
      totals.avg_resolution_seconds === null ? null : Math.round(Number(totals.avg_resolution_seconds)),
    aiMessages: Number(totals.ai_messages ?? 0),
    satisfaction: {
      rated: Number(satisfaction.rated ?? 0),
      avgRating: satisfaction.avg_rating === null ? null : round(Number(satisfaction.avg_rating), 2),
    },
    // Compared with the 30 days before the window, so the dashboard can show
    // a direction rather than a bare number.
    conversationTrend:
      previous.conversations > 0
        ? round(((total - Number(previous.conversations)) / Number(previous.conversations)) * 100, 1)
        : null,
  };
}

/** Daily buckets for the dashboard chart. */
export async function timeseries(workspaceId, since) {
  return query(
    `SELECT
        DATE(c.created_at)                     AS day,
        COUNT(*)                               AS conversations,
        SUM(ai_resolved = 1)                   AS ai_resolved,
        SUM(ai_handover = 1)                   AS handovers,
        AVG(NULLIF(c.first_response_seconds, 0)) AS avg_first_response
      FROM conversations c
     WHERE c.workspace_id = ? AND c.created_at >= ?
     GROUP BY DATE(c.created_at)
     ORDER BY day`,
    [workspaceId, since],
  );
}

/**
 * Volume and quality split by channel - shows which channel performs worst.
 * Reads `vw_conversation_metrics`, which already carries the per-thread message
 * counts as subqueries, so no second pass over `messages` is needed.
 */
export async function byChannel(workspaceId, since) {
  return query(
    `SELECT
        channel_type                                          AS channel,
        COUNT(*)                                              AS conversations,
        COALESCE(SUM(inbound_messages + outbound_messages), 0) AS messages,
        SUM(ai_resolved = 1)                                  AS ai_resolved,
        SUM(ai_handover = 1)                                  AS handovers,
        AVG(NULLIF(first_response_seconds, 0))                AS avg_first_response,
        AVG(NULLIF(TIMESTAMPDIFF(SECOND, created_at, resolved_at), 0)) AS avg_resolution
      FROM vw_conversation_metrics
     WHERE workspace_id = ? AND created_at >= ?
     GROUP BY channel_type
     ORDER BY conversations DESC`,
    [workspaceId, since],
  );
}

/** Per-agent leaderboard: volume, speed and how often the AI had to step in. */
export async function byAgent(workspaceId, since) {
  return query(
    `SELECT
        u.id                        AS agent_id,
        u.full_name                 AS name,
        u.email,
        COUNT(c.id)                 AS assigned,
        SUM(c.status = 'closed')    AS closed,
        SUM(c.ai_handover = 1)      AS handovers,
        AVG(NULLIF(c.first_response_seconds, 0)) AS avg_first_response,
        AVG(NULLIF(TIMESTAMPDIFF(SECOND, c.created_at, c.resolved_at), 0)) AS avg_resolution
      FROM workspace_members wm
      JOIN users u ON u.id = wm.user_id
      LEFT JOIN conversations c
        ON c.assignee_id = u.id AND c.workspace_id = wm.workspace_id AND c.created_at >= ?
     WHERE wm.workspace_id = ?
     GROUP BY u.id, u.full_name, u.email
     ORDER BY assigned DESC`,
    [since, workspaceId],
  );
}

/**
 * Everything the report needs about the assistant, in one payload:
 * how often it answered, when it stood down and why, and the gaps it exposed.
 */
export async function aiPerformance(workspaceId, since) {
  const totals = await queryOne(
    `SELECT
        COUNT(*)                                    AS conversations,
        SUM(ai_message_count)                       AS ai_messages,
        SUM(ai_handover = 1)                        AS handovers,
        SUM(ai_resolved = 1)                        AS resolved,
        AVG(NULLIF(ai_confidence, 0))               AS avg_confidence
      FROM conversations
     WHERE workspace_id = ? AND created_at >= ?`,
    [workspaceId, since],
  );

  const reasons = await query(
    `SELECT COALESCE(ai_handover_reason, 'unspecified') AS reason, COUNT(*) AS count
       FROM conversations
      WHERE workspace_id = ? AND created_at >= ? AND ai_handover = 1
      GROUP BY ai_handover_reason
      ORDER BY count DESC`,
    [workspaceId, since],
  );

  const intents = await query(
    `SELECT COALESCE(intent, 'other') AS intent, COUNT(*) AS count
       FROM messages
      WHERE workspace_id = ? AND created_at >= ? AND direction = 'inbound'
      GROUP BY intent
      ORDER BY count DESC
      LIMIT 10`,
    [workspaceId, since],
  );

  const unanswered = await queryOne(
    `SELECT COUNT(*) AS questions, COALESCE(SUM(occurrences), 0) AS asked
       FROM unanswered_questions WHERE workspace_id = ?`,
    [workspaceId],
  );

  const total = Number(totals.conversations ?? 0);
  return {
    aiMessages: Number(totals.ai_messages ?? 0),
    resolved: Number(totals.resolved ?? 0),
    handovers: Number(totals.handed_over ?? 0),
    aiResolutionRate: total ? round((Number(totals.resolved) / total) * 100, 1) : 0,
    avgConfidence: totals.avg_confidence === null ? null : round(Number(totals.avg_confidence), 3),
    // Why the assistant stepped aside. `low_confidence` and `llm_declined` are
    // knowledge-base gaps; `customer_requested_human` is working as intended.
    handoverReasons: reasons.map((row) => ({ reason: row.reason, count: Number(row.count) })),
    topIntents: intents.map((row) => ({ intent: row.intent, count: Number(row.count) })),
    knowledgeGaps: {
      distinctQuestions: Number(unanswered.questions ?? 0),
      totalAsked: Number(unanswered.asked ?? 0),
    },
  };
}

/** FAQ effectiveness: which entries carry the load, and which are dead weight. */
export async function faqPerformance(workspaceId) {
  return query(
    `SELECT id, question, category, match_count, no_match_count, is_active,
            ROUND(100.0 * match_count / NULLIF(match_count + no_match_count, 0), 1) AS hit_rate
       FROM faqs
      WHERE workspace_id = ?
      ORDER BY match_count DESC, no_match_count DESC`,
    [workspaceId],
  );
}

const round = (value, places) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};
