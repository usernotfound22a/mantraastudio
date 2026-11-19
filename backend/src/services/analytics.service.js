import { selectAllRows } from '../db/supabase.js';
import { listMembersOfWorkspace } from './membership.service.js';

export const RANGES = { '7d': 7, '30d': 30, '90d': 90 };

export function resolveRange(range) {
  const days = RANGES[range] ?? RANGES['30d'];
  return { range: RANGES[range] ? range : '30d', days, since: new Date(Date.now() - days * 86400000) };
}

const numeric = (value) => Number(value ?? 0);
const mean = (values) => values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
const round = (value, places) => {
  if (value === null) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};
const isTrue = (value) => value === true || value === 1;
const dayOf = (value) => new Date(value).toISOString().slice(0, 10);
const groupCount = (rows, key, fallback) => {
  const counts = new Map();
  for (const row of rows) {
    const name = row[key] || fallback;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
};

async function conversationsSince(workspaceId, since) {
  return selectAllRows('conversations', '*', { workspace_id: workspaceId }, {
    gte: since ? { created_at: since.toISOString() } : {},
    order: [{ column: 'id', ascending: true }],
  });
}

export async function overview(workspaceId, since) {
  const [conversations, previousRows, feedback] = await Promise.all([
    conversationsSince(workspaceId, since),
    selectAllRows('conversations', 'id', { workspace_id: workspaceId }, {
      gte: { created_at: new Date(since.getTime() - 30 * 86400000).toISOString() },
      lt: { created_at: since.toISOString() },
    }),
    selectAllRows('message_feedback', 'rating', { workspace_id: workspaceId }, {
      gte: { created_at: since.toISOString() },
    }),
  ]);
  const total = conversations.length;
  const previous = previousRows.length;
  const open = conversations.filter((row) => row.status === 'open').length;
  const pending = conversations.filter((row) => row.status === 'pending').length;
  const closed = conversations.filter((row) => row.status === 'closed').length;
  const handedOver = conversations.filter((row) => isTrue(row.ai_handover)).length;
  const aiResolved = conversations.filter((row) => isTrue(row.ai_resolved)).length;
  const firstResponse = conversations.map((row) => numeric(row.first_response_seconds)).filter((v) => v > 0);
  const resolution = conversations.map((row) => {
    if (!row.resolved_at) return null;
    return (new Date(row.resolved_at).getTime() - new Date(row.created_at).getTime()) / 1000;
  }).filter((value) => value !== null && value !== 0);
  const averageRating = mean(feedback.map((row) => row.rating === 'up' ? 1 : row.rating === 'down' ? 2 : null).filter((v) => v !== null));
  return {
    conversations: total,
    open,
    pending,
    closed,
    handedOver,
    aiResolved,
    aiResolutionRate: total ? round((aiResolved / total) * 100, 1) : 0,
    handoverRate: total ? round((handedOver / total) * 100, 1) : 0,
    avgFirstResponseSeconds: firstResponse.length ? Math.round(mean(firstResponse)) : null,
    avgResolutionSeconds: resolution.length ? Math.round(mean(resolution)) : null,
    aiMessages: conversations.reduce((sum, row) => sum + numeric(row.ai_message_count), 0),
    satisfaction: {
      rated: feedback.length,
      avgRating: round(averageRating, 2),
    },
    conversationTrend: previous
      ? round(((total - previous) / previous) * 100, 1)
      : null,
  };
}

export async function timeseries(workspaceId, since) {
  const rows = await conversationsSince(workspaceId, since);
  const groups = new Map();
  for (const row of rows) {
    const day = dayOf(row.created_at);
    const group = groups.get(day) ?? {
      day, conversations: 0, ai_resolved: 0, handovers: 0, firstResponses: [],
    };
    group.conversations += 1;
    if (isTrue(row.ai_resolved)) group.ai_resolved += 1;
    if (isTrue(row.ai_handover)) group.handovers += 1;
    if (numeric(row.first_response_seconds) > 0) group.firstResponses.push(numeric(row.first_response_seconds));
    groups.set(day, group);
  }
  return [...groups.values()].sort((a, b) => a.day.localeCompare(b.day)).map((row) => ({
    day: row.day,
    conversations: row.conversations,
    ai_resolved: row.ai_resolved,
    handovers: row.handovers,
    avg_first_response: mean(row.firstResponses),
  }));
}

export async function byChannel(workspaceId, since) {
  const rows = await selectAllRows('conversations', '*,channels(type)', { workspace_id: workspaceId }, {
    gte: { created_at: since.toISOString() },
    order: [{ column: 'id', ascending: true }],
  });
  const groups = new Map();
  for (const row of rows) {
    const name = row.channels?.type ?? 'unknown';
    const group = groups.get(name) ?? {
      channel: name, conversations: 0, messages: 0, ai_resolved: 0, handovers: 0,
      firstResponses: [], resolutions: [],
    };
    group.conversations += 1;
    if (isTrue(row.ai_resolved)) group.ai_resolved += 1;
    if (isTrue(row.ai_handover)) group.handovers += 1;
    if (numeric(row.first_response_seconds) > 0) group.firstResponses.push(numeric(row.first_response_seconds));
    if (row.resolved_at) {
      group.resolutions.push((new Date(row.resolved_at).getTime() - new Date(row.created_at).getTime()) / 1000);
    }
    groups.set(name, group);
  }
  const ids = rows.map((row) => row.id);
  if (ids.length) {
    const messages = await selectAllRows('messages', 'conversation_id', { workspace_id: workspaceId }, {
      in: { conversation_id: ids },
    });
    for (const message of messages) {
      const conversation = rows.find((row) => row.id === message.conversation_id);
      const group = groups.get(conversation?.channels?.type ?? 'unknown');
      if (group) group.messages += 1;
    }
  }
  return [...groups.values()]
    .map((row) => ({
      channel: row.channel,
      conversations: row.conversations,
      messages: row.messages,
      ai_resolved: row.ai_resolved,
      handovers: row.handovers,
      avg_first_response: mean(row.firstResponses),
      avg_resolution: mean(row.resolutions),
    }))
    .sort((a, b) => b.conversations - a.conversations);
}

export async function byAgent(workspaceId, since) {
  const [members, conversations] = await Promise.all([
    listMembersOfWorkspace(workspaceId),
    conversationsSince(workspaceId, since),
  ]);
  return members.map((member) => {
    const assigned = conversations.filter((row) => row.assignee_id === member.user_id);
    const first = assigned.map((row) => numeric(row.first_response_seconds)).filter((v) => v > 0);
    const resolutions = assigned.map((row) => row.resolved_at
      ? (new Date(row.resolved_at).getTime() - new Date(row.created_at).getTime()) / 1000
      : null).filter((v) => v !== null);
    return {
      agent_id: member.user_id,
      name: member.full_name,
      email: member.email,
      assigned: assigned.length,
      closed: assigned.filter((row) => row.status === 'closed').length,
      handovers: assigned.filter((row) => isTrue(row.ai_handover)).length,
      avg_first_response: mean(first),
      avg_resolution: mean(resolutions),
    };
  }).sort((a, b) => b.assigned - a.assigned);
}

export async function aiPerformance(workspaceId, since) {
  const [conversations, messages, unanswered] = await Promise.all([
    conversationsSince(workspaceId, since),
    selectAllRows('messages', 'intent,direction,created_at', { workspace_id: workspaceId, direction: 'inbound' }, {
      gte: { created_at: since.toISOString() },
    }),
    selectAllRows('unanswered_questions', 'occurrences', { workspace_id: workspaceId }),
  ]);
  const handovers = conversations.filter((row) => isTrue(row.ai_handover));
  const resolved = conversations.filter((row) => isTrue(row.ai_resolved));
  const confidences = conversations.map((row) => numeric(row.ai_confidence)).filter((v) => v > 0);
  const reasons = groupCount(handovers, 'ai_handover_reason', 'unspecified');
  const intents = groupCount(messages, 'intent', 'other').slice(0, 10);
  return {
    aiMessages: conversations.reduce((sum, row) => sum + numeric(row.ai_message_count), 0),
    resolved: resolved.length,
    handovers: handovers.length,
    aiResolutionRate: conversations.length ? round((resolved.length / conversations.length) * 100, 1) : 0,
    avgConfidence: round(mean(confidences), 3),
    handoverReasons: reasons.map(({ name, count }) => ({ reason: name, count })),
    topIntents: intents.map(({ name, count }) => ({ intent: name, count })),
    knowledgeGaps: {
      distinctQuestions: unanswered.length,
      totalAsked: unanswered.reduce((sum, row) => sum + numeric(row.occurrences), 0),
    },
  };
}

export async function faqPerformance(workspaceId) {
  const rows = await selectAllRows('faqs', 'id,question,category,match_count,no_match_count,is_active', {
    workspace_id: workspaceId,
  });
  return rows.sort((a, b) =>
    numeric(b.match_count) - numeric(a.match_count) || numeric(b.no_match_count) - numeric(a.no_match_count),
  ).map((row) => ({
    ...row,
    hit_rate: row.match_count + row.no_match_count
      ? round((100 * row.match_count) / (row.match_count + row.no_match_count), 1)
      : null,
  }));
}
