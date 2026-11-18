/**
 * Built-in behaviour plugin: decide escalation.
 *
 * Runs after classify-intent and sets `escalate`/`escalationReason` when the
 * customer asks for a human or is clearly upset. Exported as a stage so a
 * workspace-specific sentiment plugin can slot in at the same point.
 */
const HUMAN_REQUEST =
  /\b(human|humans|real person|actual person|live agent|talk to (someone|an agent|a human)|speak to (someone|an agent)|manager|supervisor|phone number|call me)\b/i;
const ANGRY =
  /\b(angry|furious|unacceptable|terrible|awful|worst|ridiculous|scam|disgusting|appalling|never again|complaint|escalate|refund now)\b/i;

/** Deterministic handover reasons, so the UI can explain *why* the AI stepped aside. */
export function escalationReason(text) {
  if (HUMAN_REQUEST.test(text)) return 'customer_requested_human';
  if (ANGRY.test(text)) return 'negative_sentiment';
  return null;
}

export const escalationBehaviour = {
  id: 'detect-escalation',
  order: 20,
  async run(context) {
    const reason = escalationReason(context.text);
    return { escalationReason: reason, escalate: Boolean(reason) };
  },
};

export default escalationBehaviour;
