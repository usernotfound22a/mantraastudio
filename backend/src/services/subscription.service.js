/**
 * Subscription plan limits and usage counters.
 *
 * A single `subscriptions` row per workspace holds the plan, the limits and
 * the running usage. Plan *definitions* (names, prices) live in code -
 * see PLAN_CATALOG - because the Stripe price IDs come from the environment.
 */
import { selectRows, selectOne, callRpc } from '../db/supabase.js';
import { AppError } from '../middleware/error.js';
import { env } from '../config/env.js';

/**
 * The three plans from the project spec.
 * `messagesLimit` / `aiRepliesLimit` are per billing month.
 */
export const PLAN_CATALOG = {
  free: {
    id: 'free',
    name: 'Free',
    priceMonthly: 0,
    priceYearly: 0,
    seats: 2,
    messagesLimit: 100,
    aiRepliesLimit: 50,
    channels: ['website'],
    features: [
      'Website chat widget',
      '2 team members',
      '100 messages / month',
      '50 AI replies / month',
      'Basic analytics',
    ],
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    priceMonthly: 19,
    priceYearly: 190,
    seats: 5,
    messagesLimit: 2000,
    aiRepliesLimit: 1000,
    channels: ['website', 'messenger', 'instagram'],
    features: [
      'Everything in Free',
      'Facebook Messenger + Instagram',
      '5 team members',
      '2,000 messages / month',
      '1,000 AI replies / month',
      'PDF + CSV exports',
    ],
    stripePriceEnvKey: 'STRIPE_PRICE_STARTER',
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 49,
    priceYearly: 490,
    seats: 20,
    messagesLimit: 20000,
    aiRepliesLimit: 10000,
    channels: ['website', 'messenger', 'instagram'],
    features: [
      'Everything in Starter',
      '20 team members',
      '20,000 messages / month',
      '10,000 AI replies / month',
      'Lead tagging + conversation summaries',
      'Priority support',
    ],
    stripePriceEnvKey: 'STRIPE_PRICE_PRO',
  },
};

export const getSubscription = (workspaceId) =>
  selectOne('subscriptions', '*', { workspace_id: workspaceId });

export const listSubscriptions = (workspaceId) =>
  selectRows('subscriptions', '*', { workspace_id: workspaceId });

/**
 * Resolves the Stripe price id for a plan + billing period.
 *
 * Yearly is a genuinely different Stripe price, not a discount applied at
 * checkout, so the period has to select a different id. Returning the monthly
 * id for a yearly request would let the UI promise "$190/year" while the
 * customer is actually billed $19 every month.
 */
export function stripePriceFor(planId, billingPeriod = 'monthly') {
  const plan = PLAN_CATALOG[planId];
  if (!plan?.stripePriceEnvKey) return null;
  if (billingPeriod === 'yearly') {
    return env[`${plan.stripePriceEnvKey}_YEARLY`] ?? null;
  }
  return env[plan.stripePriceEnvKey] ?? null;
}

/** Whether a plan can be bought at all, and on which terms. Drives the UI. */
export function purchasability(planId) {
  if (planId === 'free') return { any: true, monthly: true, yearly: true };
  return {
    any: Boolean(stripePriceFor(planId) || stripePriceFor(planId, 'yearly')),
    monthly: Boolean(stripePriceFor(planId)),
    yearly: Boolean(stripePriceFor(planId, 'yearly')),
  };
}

/**
 * Adds to the running usage counters. Fire-and-forget: a counter failure must
 * never break message delivery.
 */
export async function incrementUsage(workspaceId, { messages = 0, aiReplies = 0 } = {}) {
  if (!messages && !aiReplies) return null;
  return callRpc('increment_subscription_usage', {
    p_workspace_id: workspaceId,
    p_messages: messages,
    p_ai_replies: aiReplies,
  });
}

/** Whether a workspace may send another AI reply this period. */
export async function assertAiQuotaAvailable(workspaceId) {
  const subscription = await getSubscription(workspaceId);
  if (!subscription) return { allowed: true, remaining: null };

  const remaining = subscription.ai_replies_limit - subscription.ai_replies_used;
  if (remaining <= 0) {
    throw AppError.paymentRequired(
      'You have used all AI replies on your current plan. Upgrade to keep the assistant running.',
    );
  }
  return { allowed: true, remaining };
}

/** Whether the workspace may connect a given channel type under its plan. */
export async function assertChannelAllowedByPlan(workspaceId, channelType) {
  const subscription = await getSubscription(workspaceId);
  const plan = PLAN_CATALOG[subscription?.plan ?? 'free'];
  if (!plan) return true;

  if (!plan.channels.includes(channelType)) {
    throw AppError.paymentRequired(
      `The ${plan.name} plan does not include the ${channelType} channel. Upgrade to connect it.`,
    );
  }
  return true;
}

/** Map a subscriptions row -> API shape with a computed usage summary. */
export function mapSubscription(row) {
  if (!row) return null;
  const plan = PLAN_CATALOG[row.plan] ?? PLAN_CATALOG.free;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    plan: row.plan,
    planName: plan.name,
    status: row.status,
    billingPeriod: row.billing_period,
    seats: row.seats,
    usage: {
      messages: {
        used: row.messages_used,
        limit: row.messages_limit,
        percent: Math.min(100, Math.round((row.messages_used / Math.max(1, row.messages_limit)) * 100)),
      },
      aiReplies: {
        used: row.ai_replies_used,
        limit: row.ai_replies_limit,
        percent: Math.min(100, Math.round((row.ai_replies_used / Math.max(1, row.ai_replies_limit)) * 100)),
      },
    },
    stripe: {
      customerId: row.stripe_customer_id,
      subscriptionId: row.stripe_subscription_id,
      priceId: row.stripe_price_id,
      currentPeriodEnd: row.current_period_end,
      cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    },
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
  };
}
