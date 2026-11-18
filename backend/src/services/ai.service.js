/**
 * AI assistant (Part 7).
 *
 * The pipeline, in order, cheapest gate first:
 *
 *   1. GATE          is AI allowed on this workspace / thread at all?
 *   2. INTENT        classify the message (refund, delivery, hours, ...)
 *   3. ESCALATION    deterministic triggers: "talk to a human", angry language.
 *                    Checked BEFORE retrieval because these must win even when
 *                    the retriever happens to be confident.
 *   4. RETRIEVAL     TF-IDF over the workspace's FAQs (faq.service.js)
 *   5. CONFIDENCE    top score vs AI_CONFIDENCE_THRESHOLD. Below it, the AI
 *                    would be guessing, so it hands over instead of lying.
 *   6. GENERATE      the LLM rewrites the FAQ answer in the business's tone.
 *                    With AI_PROVIDER=offline the FAQ text is sent as-is.
 *   7. ACT           auto-send, or hand back a draft for an agent to approve
 *
 * Two hard rules:
 *   - It NEVER throws into the message path. A failing AI must not stop a
 *     customer message from being stored and shown to an agent.
 *   - It runs AFTER persistence, so model latency never delays the inbox.
 */
import { env } from '../config/env.js';
import { childLogger } from '../config/logger.js';
import { execute, query, queryOne } from '../db/pool.js';
import { searchFaqs, recordFaqMatch, recordFaqMiss, recordUnansweredQuestion } from './faq.service.js';
import { sendMessageToConversation } from './conversation.service.js';
import { assertAiQuotaAvailable, incrementUsage } from './subscription.service.js';
import { emitToWorkspace } from './socket.service.js';
import { EVENTS } from './events.js';
// AI provider + behaviour plugins (src/plugins/*). The provider replaces the
// old hardcoded openai/groq branch; the behaviours replace the inline intent
// and escalation logic, which now run as ordered pipeline stages.
import { resolveAiProvider, runAiBehaviour } from '../plugins/ai.loader.js';
import { detectIntent } from '../plugins/ai.behaviours/classify-intent.behaviour.js';
import { escalationReason } from '../plugins/ai.behaviours/escalation.behaviour.js';

export { detectIntent, escalationReason };

const log = childLogger('ai');

/** A bare "hi" with no question attached should not trigger retrieval. */
const GREETING = /^(hi|hey|hello|hiya|good (morning|afternoon|evening)|yo|howdy)\b[\s!.,?]*$/i;

/**
 * Whether the AI may answer for a workspace. `offline` counts as enabled: it
 * still answers from the FAQ text, just without a model in the loop.
 */
export const isAiEnabled = (workspace) =>
  Boolean(workspace?.ai_enabled) && env.AI_PROVIDER !== 'disabled';


/**
 * Generate a reply through the configured AI PROVIDER PLUGIN.
 *
 * The provider is resolved from env.AI_PROVIDER via the plugin registry
 * (src/plugins/ai.loader.js). Adding a backend is now a plugin file, not an
 * edit here. A provider that is missing, has no key, or throws falls back to
 * the curated FAQ text, so a reply is ALWAYS produced.
 */
const SYSTEM_PROMPT = (businessName) => `You are the support assistant for ${businessName || 'this business'}.
Rules:
- Answer ONLY from the KNOWLEDGE BASE below. If it does not contain the answer, reply with exactly: NEEDS_HUMAN
- Never invent prices, dates, policies or guarantees.
- Be warm, brief and concrete: 1-3 sentences, no markdown, no bullet lists, no greeting boilerplate.
- Match the customer's language.`;

async function generateReply({ question, faqAnswer, workspaceName }) {
  const provider = resolveAiProvider(env.AI_PROVIDER);
  // Offline (or a provider that returns nothing) sends the curated FAQ text
  // unchanged, which is also the fallback if the model errors or times out.
  if (provider.id === 'offline' || env.AI_PROVIDER === 'offline') {
    return { text: faqAnswer, generated: false };
  }

  try {
    const result = await provider.generate({
      system: SYSTEM_PROMPT(workspaceName),
      // The CUSTOMER QUESTION and the FAQ's own question can differ; the model
      // must answer the customer's actual words, using the FAQ entry as source.
      user: `KNOWLEDGE BASE ENTRY:\nQ: ${question.faqQuestion ?? question.text ?? ''}\nA: ${faqAnswer}\n\nCUSTOMER QUESTION: ${question.text ?? question}`,
    });

    // A provider reports its own failures in-band (result.error) instead of
      // throwing, so the in-band error has to fall back too - otherwise a
      // missing API key would hand over instead of using the FAQ answer.
      if (result?.error) {
        log.warn({ err: result.error }, 'AI provider failed - falling back to the raw FAQ answer');
        return { text: faqAnswer, generated: false };
      }

      const text = result?.text?.trim() ?? null;
    // The model is told to answer NEEDS_HUMAN when the KB is insufficient.
    if (!text || /^(NEEDS_HUMAN|NEEDS HUMAN)$/i.test(text) || result?.needsHuman) {
      return { text: null, generated: true, needsHuman: true };
    }
    return { text, generated: true };
  } catch (error) {
    log.warn({ err: error.message }, 'AI provider failed - falling back to the raw FAQ answer');
    return { text: faqAnswer, generated: false };
  }
}

// ---------------------------------------------------------------------------
// Conversation memory: a rolling summary the LLM can read next time
// ---------------------------------------------------------------------------

async function refreshSummary(conversation, latestIntent) {
  // Only summarise once the thread is long enough to be worth the tokens.
  const stats = await queryOne(
    'SELECT COUNT(*) AS total FROM messages WHERE conversation_id = ? AND direction = ?',
    [conversation.id, 'inbound'],
  );
  if (stats.total < 4) return null;

  const recent = await query(
    `SELECT direction, sender_type, body FROM messages
      WHERE conversation_id = ?
      ORDER BY id DESC LIMIT 12`,
    [conversation.id],
  );

  const history = recent
    .reverse()
    .map((m) => `${m.direction}/${m.sender_type}: ${String(m.body).slice(0, 200)}`)
    .join('\n');

  // Summarise through the configured provider plugin. Offline/missing key/any
  // failure falls through to the deterministic topic summary below.
  const provider = resolveAiProvider(env.AI_PROVIDER);
  let summary = null;
  if (provider.id !== 'offline') {
    try {
      const result = await provider.generate({
        system:
          'Summarise this support thread in ONE sentence for a colleague who has not read it. No preamble.',
        user: history,
      });
      summary = result?.text?.trim() ?? null;
    } catch (error) {
      log.debug({ err: error.message }, 'Summary failed - keeping the previous one');
    }
  }

  // Offline fallback: the topics the customer actually mentioned.
  if (!summary) {
    const topics = [...new Set(recent.flatMap((m) => detectIntentTag(m.body)).filter(Boolean))];
    summary = topics.length ? `Customer asked about: ${topics.join(', ')}.` : null;
  }
  if (!summary) return null;

  await execute(
    `UPDATE conversations SET ai_summary = ?, ai_lead_tags = ? WHERE id = ?`,
    [summary, JSON.stringify(latestIntent ? [latestIntent] : []), conversation.id],
  );
  return summary;
}

/**
 * The intent rules live in an AI behaviour plugin now, so the offline
 * summary asks the plugin instead of holding a second copy of the patterns.
 */
const detectIntentTag = (text) => {
  const intent = detectIntent(text ?? '');
  return intent && intent !== 'other' ? [intent] : [];
};

// ---------------------------------------------------------------------------
// Handover
// ---------------------------------------------------------------------------

async function handOver({ conversation, reason, confidence, faqId = null, intent = null }) {
  await execute(
    `UPDATE conversations
        SET ai_handover = 1,
            ai_handover_reason = ?,
            ai_handover_at = NOW(),
            ai_confidence = ?,
            ai_last_faq_id = ?,
            priority = IF(? = 'complaint' OR ? = 'refund', 'high', priority)
      WHERE id = ?`,
    [reason, confidence, faqId, intent, intent, conversation.id],
  );

  emitToWorkspace(conversation.workspace_id, EVENTS.CONVERSATION_HANDOVER, {
    conversationId: conversation.id,
    reason,
    confidence,
  });
  log.info({ conversationId: conversation.id, reason, confidence }, 'AI handed the thread to a human');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * @param {object} params
 * @param {object} params.conversation
 * @param {object} params.message         the persisted inbound message
 * @param {object} params.channel
 * @param {object} params.workspace
 * @returns {Promise<{action: 'replied'|'handover'|'drafted'|'skipped',
 *                    reason: string, reply?: string, faqId?: number,
 *                    confidence?: number}>}
 */
export async function maybeAutoReply({ conversation, message, channel, workspace }) {
  try {
    // --- 1. Gates -------------------------------------------------------
    if (message.direction !== 'inbound') return { action: 'skipped', reason: 'not_inbound' };
    const text = (message.body ?? '').trim();
    if (!text) return { action: 'skipped', reason: 'empty_message' };
    // A bare "hi" gets no retrieval attempt; the greeting below handles it.
    const isGreeting = GREETING.test(text);

    if (!workspace.ai_enabled) return { action: 'skipped', reason: 'workspace_ai_disabled' };
    if (!conversation.ai_enabled) return { action: 'skipped', reason: 'thread_ai_disabled' };
    if (conversation.ai_handover) return { action: 'skipped', reason: 'already_handed_over' };
    if (conversation.status === 'closed') return { action: 'skipped', reason: 'thread_closed' };
    if (env.AI_PROVIDER !== 'offline' && !env.OPENAI_API_KEY && !env.GROQ_API_KEY) {
      // Not fatal: the offline path still works, it just uses FAQ text verbatim.
      log.debug('No LLM key configured; answering from the FAQ text directly');
    }

// Intent + escalation come from the behaviour pipeline so a plugin can add or
    // replace a stage; the built-ins just return the same values the inline
    // calls used to compute.
    const behaviourCtx = await runAiBehaviour({
      text,
      conversation,
      message,
      channel,
      workspace,
      intent: 'other',
      escalate: false,
      escalationReason: null,
    });
    const intent = behaviourCtx.intent ?? 'other';

    await execute('UPDATE messages SET intent = ? WHERE id = ?', [intent, message.id]).catch(
      () => {},
    );
    await execute('UPDATE conversations SET ai_message_count = ai_message_count + 1 WHERE id = ?', [
      conversation.id,
    ]);

    // --- 3. Escalation triggers ----------------------------------------
    const forced = behaviourCtx.escalationReason ?? null;
    if (behaviourCtx.escalate || forced) {
      const reason = forced ?? 'escalated by an AI behaviour plugin';
      await handOver({ conversation, reason, confidence: 0, intent });
      return { action: 'handover', reason, confidence: 0 };
    }

    // Greeting: answer from the channel's own configured greeting, no LLM.
    if (isGreeting) {
      const greeting = channel.config?.greeting ?? 'Hi! How can I help you today?';
      return await deliver({
        conversation,
        channel,
        workspace,
        body: greeting,
        intent,
        reason: 'greeting',
      });
    }

    // --- 4. Retrieval ---------------------------------------------------
    const candidates = await searchFaqs(conversation.workspace_id, text, 3);
    const best = candidates[0];

    // --- 5. Confidence gate ---------------------------------------------
    if (!best || best.score < env.AI_CONFIDENCE_THRESHOLD) {
      const reason = 'low_confidence';
      // Two different signals: a near miss is a tuning hint on the FAQ that came
      // closest, while a total miss is a gap in the knowledge base.
      if (best) await recordFaqMiss(best.faq.id).catch(() => {});
      await recordUnansweredQuestion(conversation.workspace_id, text, {
        conversationId: conversation.id,
        channelId: channel.id,
      }).catch(() => {});
      await handOver({
        conversation,
        reason,
        confidence: best ? Number(best.score.toFixed(3)) : 0,
        faqId: best?.faq.id ?? null,
        intent,
      });
      return {
        action: 'handover',
        reason,
        confidence: best ? Number(best.score.toFixed(3)) : 0,
      };
    }

    // --- 6. Generate ----------------------------------------------------
    // The model must see BOTH sides: the FAQ entry (the source it may use) and
    // the customer's real question. Passing only best.faq.question made the AI
    // answer the FAQ's phrasing rather than what the customer actually asked,
    // which is wrong whenever the two differ ("do you ship to Spain?" matched
    // "What are your delivery times?").
    const generated = await generateReply({
      question: { text, faqQuestion: best.faq.question },
      faqAnswer: best.faq.answer,
      workspaceName: workspace?.name,
    });

    if (generated.needsHuman || !generated.text) {
      await handOver({
        conversation,
        reason: 'llm_declined',
        confidence: Number(best.score.toFixed(3)),
        faqId: best.faq.id,
        intent,
      });
      return { action: 'handover', reason: 'llm_declined', confidence: Number(best.score.toFixed(3)) };
    }

    // --- 7a. Draft only, when auto-send is off ---------------------------
    if (!workspace.ai_auto_send) {
      await recordFaqMatch(best.faq.id);
      return {
        action: 'drafted',
        reason: 'auto_send_disabled',
        reply: generated.text,
        faqId: best.faq.id,
        confidence: Number(best.score.toFixed(3)),
      };
    }

    // --- 7b. Auto-send --------------------------------------------------
    await recordFaqMatch(best.faq.id);
    const result = await deliver({
      conversation,
      channel,
      workspace,
      body: generated.text,
      intent,
      reason: 'answered',
      faqId: best.faq.id,
      confidence: Number(best.score.toFixed(3)),
    });

    // The AI answered, so no human time was spent: mark it resolved and refresh
    // the thread memory in the background.
    await execute(
      `UPDATE conversations SET ai_resolved = 1, ai_last_faq_id = ?, ai_confidence = ? WHERE id = ?`,
      [best.faq.id, Number(best.score.toFixed(3)), conversation.id],
    );
    refreshSummary(conversation, intent).catch((error) =>
      log.debug({ err: error.message }, 'Summary refresh failed'),
    );

    return { ...result, faqId: best.faq.id };
  } catch (error) {
    // Contract: never propagate. The message is already stored, so the worst
    // case is a customer who has not been answered yet.
    log.error({ err: error.message, conversationId: conversation?.id }, 'AI failed - message kept, no reply sent');
    return { action: 'skipped', reason: 'ai_error' };
  }
}

/** Persists and sends an AI reply through the normal channel pipeline. */
async function deliver({
  conversation,
  channel,
  body,
  intent,
  reason,
  faqId = null,
  confidence = null,
}) {
  // Respect the plan's AI allowance. A quota error is swallowed so a paying
  // customer's message is still stored.
  try {
    await assertAiQuotaAvailable(conversation.workspace_id);
  } catch (error) {
    log.warn({ conversationId: conversation.id, err: error.message }, 'AI quota exhausted');
    await handOver({ conversation, reason: 'quota_exhausted', confidence, faqId, intent });
    return { action: 'handover', reason: 'quota_exhausted', confidence };
  }

  const sent = await sendMessageToConversation({
    conversation,
    channel,
    body,
    attachments: [],
    sender: null,
    senderType: 'ai',
    intent,
    metadata: { faqId, confidence, trigger: reason },
  });

  await incrementUsage(conversation.workspace_id, { messages: 1, aiReplies: 1 });
  log.info(
    { conversationId: conversation.id, reason, confidence, messageId: sent.id },
    'AI replied',
  );

  return {
    action: 'replied',
    reason,
    reply: body,
    messageId: sent.id,
    faqId,
    confidence,
  };
}
