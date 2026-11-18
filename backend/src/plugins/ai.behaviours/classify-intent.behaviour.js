/**
 * Built-in behaviour plugin: classify intent.
 *
 * The keyword classifier that used to live inline in ai.service.js is now a
 * named, ordered pipeline stage. That means a third-party plugin can REPLACE it
 * (same id) with a model-based classifier, or run a different stage after it,
 * without forking the service.
 */

const INTENTS = [
  { intent: 'refund', patterns: /\b(refund|reimburse|money back|chargeback|cancel my order)\b/i },
  { intent: 'delivery', patterns: /\b(deliver|shipping|track|tracking|dispatch|courier|arriv|postage)\b/i },
  { intent: 'cancellation', patterns: /\b(cancel|scrap my order|don't want it anymore)\b/i },
  { intent: 'complaint', patterns: /\b(complain|unhappy|disappointed|not happy|poor service|worst)\b/i },
  { intent: 'pricing', patterns: /\b(price|cost|how much|discount|voucher|coupon|payment|charge|invoice|quote)\b/i },
  { intent: 'hours', patterns: /\b(open|opening|close|closing|hours|weekend|holiday|shut)\b/i },
  { intent: 'product', patterns: /\b(stock|available|size|colour|color|variant|spec|product|item)\b/i },
  { intent: 'support', patterns: /\b(broken|not work|issue|problem|error|defect|damaged)\b/i },
  { intent: 'account', patterns: /\b(login|password|account|sign in|email|billing address)\b/i },
];

/** Cheap keyword intent classifier. Deliberately simple and explainable. */
export function detectIntent(text) {
  if (!text) return 'other';
  for (const { intent, patterns } of INTENTS) {
    if (patterns.test(text)) return intent;
  }
  return 'other';
}

export const classifyIntentBehaviour = {
  id: 'classify-intent',
  order: 10,
  async run(context) {
    return { intent: detectIntent(context.text) };
  },
};

export default classifyIntentBehaviour;
