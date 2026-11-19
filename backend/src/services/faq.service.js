/**
 * FAQ retrieval for the AI assistant (used by Part 7).
 *
 * WHY NOT EMBEDDINGS?
 * -------------------
 * Vector embeddings would be the "modern" answer, but they need an embedding
 * provider, a stored vector column and a rebuild step every time an FAQ
 * changes. For a knowledge base of tens-to-hundreds of entries, a TF-IDF
 * keyword scorer is:
 *   - free and offline (works with AI_PROVIDER=offline)
 *   - instant (no network call before every reply)
 *   - explainable, which matters: you can show an agent "why it picked this
 *     answer", and a supervisor can read the algorithm in your report
 *
 * If you later want embeddings, `searchFaqs()` is the only function to
 * replace - the AI service only sees { faq, score }.
 */
import { selectRows, callRpc } from '../db/supabase.js';

/** Words that carry no retrieval signal. */
const STOP_WORDS = new Set([
  'a', 'about', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'for', 'from', 'get', 'had', 'has', 'have', 'how',
  'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 'please',
  'so', 'some', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'to', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with',
  'would', 'you', 'your', 'hi', 'hello', 'hey', 'thanks', 'thank', 'u', 'r', 'ok', 'okay',
]);

/** Lowercase, strip punctuation, drop stop words, dedupe. */
export function tokenize(text) {
  if (!text) return [];
  return [
    ...new Set(
      String(text)
        .toLowerCase()
        .replace(/[^a-z0-9\s'-]/g, ' ')
        .split(/\s+/)
        .filter((token) => token.length > 1 && !STOP_WORDS.has(token)),
    ),
  ];
}

/** Parses JSON values while tolerating already-parsed driver results. */
function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Active FAQ entries for a workspace, with their match statistics. */
export const listActiveFaqs = (workspaceId) =>
  selectRows(
    'faqs',
    'id,question,answer,keywords,tags,category,source,match_count,no_match_count',
    { workspace_id: workspaceId, is_active: 1 },
  );

/**
 * Scores one FAQ against a query.
 * @returns {number} 0..1 confidence
 */
function scoreFaq(faq, queryTokens, queryText, idf) {
  const questionTokens = tokenize(faq.question);
  const keywordTokens = asArray(faq.keywords).flatMap((keyword) => tokenize(keyword));
  const answerTokens = tokenize(faq.answer);

  if (queryTokens.length === 0) return 0;

  let score = 0;
  let matched = 0;

  for (const token of queryTokens) {
    // A token that appears verbatim in the FAQ's keywords is the strongest
    // signal, because keywords are written deliberately.
    if (keywordTokens.includes(token)) score += 3 * (idf.get(token) ?? 1);
    else if (questionTokens.includes(token)) score += 2 * (idf.get(token) ?? 1);
    else if (answerTokens.includes(token)) score += 0.5 * (idf.get(token) ?? 1);
    else continue;
    matched += 1;
  }

  // Coverage: a single matching word in a 1-word question is weak evidence, so
  // normalise by how much of the QUESTION we covered.
  const coverage = matched / Math.max(1, questionTokens.length);
  score *= 0.5 + 0.5 * Math.min(1, coverage);

  // Phrase bonus: the whole question appearing in the customer's message is
  // near-certain ("what are your delivery times" -> exact FAQ).
  const normalisedQuery = queryText.toLowerCase().trim();
  if (normalisedQuery.length > 8 && faq.question.toLowerCase().includes(normalisedQuery)) {
    score += 6;
  }
  for (const keyword of asArray(faq.keywords)) {
    if (String(keyword).length > 4 && normalisedQuery.includes(String(keyword).toLowerCase())) {
      score += 2.5;
      break;
    }
  }

  // Sigmoid squash into 0..1 so the value is comparable across workspaces and
  // can be compared against AI_CONFIDENCE_THRESHOLD.
  return 1 / (1 + Math.exp(-(score - 1.5)));
}

/**
 * Ranks a workspace's FAQs against a customer question.
 *
 * @param {string} workspaceId
 * @param {string} question
 * @param {number} limit
 * @returns {Promise<Array<{faq: object, score: number, tokens: string[]}>>}
 */
export async function searchFaqs(workspaceId, question, limit = 3) {
  const faqs = await listActiveFaqs(workspaceId);
  if (faqs.length === 0) return [];

  const queryTokens = tokenize(question);
  if (queryTokens.length === 0) return [];

  // --- Inverse document frequency -------------------------------------
  // Words that appear in EVERY FAQ (e.g. "order") tell us nothing, so they
  // count for less. This is what makes the scorer robust.
  const documentFrequency = new Map();
  for (const faq of faqs) {
    const tokens = new Set([
      ...tokenize(faq.question),
      ...asArray(faq.keywords).flatMap((keyword) => tokenize(keyword)),
    ]);
    for (const token of tokens) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const idf = new Map();
  for (const [token, count] of documentFrequency) {
    idf.set(token, Math.log(1 + faqs.length / count));
  }

  // --- Score + sort ---------------------------------------------------
  return faqs
    .map((faq) => ({
      faq,
      score: scoreFaq(faq, queryTokens, question, idf),
      tokens: queryTokens.filter(
        (token) =>
          tokenize(faq.question).includes(token) ||
          asArray(faq.keywords).some((keyword) => tokenize(keyword).includes(token)),
      ),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Records that an FAQ was used (drives the "top questions" report). */
export const recordFaqMatch = (faqId) =>
  callRpc('record_faq_match', { p_faq_id: faqId });

/**
 * Records a NEAR miss: the retriever found a plausible entry but the confidence
 * gate rejected it. `no_match_count` therefore answers "how often was this
 * entry close but not enough?", which is a tuning signal.
 */
export const recordFaqMiss = (faqId) =>
  callRpc('record_faq_miss', { p_faq_id: faqId });

/**
 * Records a question we could not answer at all. Deduped on the question text,
 * so a repeated question increments `occurrences` instead of creating rows.
 * This is what the "add to knowledge base" list in Settings -> FAQ reads.
 */
export const recordUnansweredQuestion = (workspaceId, question, { conversationId = null, channelId = null } = {}) =>
  callRpc('record_unanswered_question', {
    p_workspace_id: workspaceId,
    p_question: String(question).slice(0, 500),
    p_conversation_id: conversationId,
    p_channel_id: channelId,
  });

/** The questions the knowledge base is missing, most frequent first. */
export const listUnansweredQuestions = (workspaceId, limit = 50) =>
  selectRows(
    'unanswered_questions',
    'id,question,occurrences,first_asked_at,last_asked_at',
    { workspace_id: workspaceId },
    {
      order: [{ column: 'occurrences', ascending: false }, { column: 'last_asked_at', ascending: false }],
      limit: Math.min(Number(limit) || 50, 200),
    },
  );
