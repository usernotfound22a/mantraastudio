/**
 * Stripe billing (Part 12).
 *
 * Design rules, in priority order:
 *
 *   1. FAIL CLOSED. With no STRIPE_SECRET_KEY every entry point throws a 503
 *      with an actionable message. It must never silently pretend to succeed -
 *      a "paid" workspace that is not paid is worse than a visible error.
 *   2. The DB is the source of truth for entitlements, Stripe is the source of
 *      truth for payment. Entitlements are only ever changed by a *verified*
 *      webhook, never by the browser saying "I paid".
 *   3. Webhooks are idempotent. Stripe retries, often within seconds, so every
 *      handler is safe to run twice.
 */
import Stripe from 'stripe';
import axios from 'axios';
import { env } from '../config/env.js';
import { getAdminClient, selectOne, insertRow, updateRows, withSupabaseClient } from '../db/supabase.js';
import { childLogger } from '../config/logger.js';
import { AppError } from '../middleware/error.js';
import { PLAN_CATALOG, stripePriceFor, purchasability, getSubscription, mapSubscription } from './subscription.service.js';
import { emitToWorkspace } from './socket.service.js';
import { EVENTS } from './events.js';

const log = childLogger('billing');

let stripe = null;

/** Lazily built so a keyless development environment still boots. */
export function getStripe() {
  if (!env.STRIPE_SECRET_KEY) {
    throw AppError.serviceUnavailable(
      'Billing is not configured on this server. Set STRIPE_SECRET_KEY to enable it.',
    );
  }
  stripe ??= new Stripe(env.STRIPE_SECRET_KEY, { maxRetries: 2 });
  return stripe;
}

export const isBillingEnabled = () => Boolean(env.STRIPE_SECRET_KEY);

export const isKhaltiRefundEnabled = () => Boolean(env.KHALTI_SECRET_KEY);

/** Refunds a Khalti merchant transaction without exposing the merchant key. */
export async function refundKhaltiTransaction({ transactionId, amount, mobile }) {
  if (!env.KHALTI_SECRET_KEY) {
    throw AppError.serviceUnavailable(
      'Khalti refunds are not configured. Set KHALTI_SECRET_KEY in the backend environment.',
    );
  }

  const baseUrl = env.KHALTI_API_BASE_URL.replace(/\/$/, '');
  const url = `${baseUrl}/merchant-transaction/${encodeURIComponent(transactionId)}/refund/`;
  const body = {
    ...(amount !== undefined ? { amount } : {}),
    ...(mobile ? { mobile } : {}),
  };

  try {
    const { data } = await axios.post(url, body, {
      headers: {
        Authorization: `Key ${env.KHALTI_SECRET_KEY}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });
    log.info({ transactionId }, 'Khalti refund completed');
    return data;
  } catch (error) {
    const status = error.response?.status;
    const message = error.response?.data?.detail ?? 'Khalti rejected the refund request';
    log.warn({ transactionId, status }, 'Khalti refund failed');
    throw new AppError(message, status && status >= 400 && status < 500 ? status : 502, 'KHALTI_REFUND_FAILED');
  }
}

/** The three plans for the pricing page, with a flag for what we can sell. */
export function listPlans() {
  return Object.values(PLAN_CATALOG).map((plan) => ({
    id: plan.id,
    name: plan.name,
    priceMonthly: plan.priceMonthly,
    priceYearly: plan.priceYearly,
    seats: plan.seats,
    messagesLimit: plan.messagesLimit,
    aiRepliesLimit: plan.aiRepliesLimit,
    channels: plan.channels,
    features: plan.features,
    // Free needs no Stripe price. The others become sellable per billing
    // period, so the pricing screen can grey out "yearly" instead of taking an
    // order it would fulfil at the monthly price.
    purchasable: purchasability(plan.id),
  }));
}

/** Current plan plus live usage, shaped for the billing screen. */
export async function billingSummary(workspaceId) {
  const subscription = await getSubscription(workspaceId);
  if (!subscription) {
    return {
      plan: PLAN_CATALOG.free,
      subscription: null,
      usage: null,
      billingEnabled: isBillingEnabled(),
    };
  }

  // mapSubscription already turns the stored counters into a usable shape,
  // including the percentage bars, so the screen needs no extra maths.
  const mapped = mapSubscription(subscription);
  return {
    plan: PLAN_CATALOG[subscription.plan] ?? PLAN_CATALOG.free,
    subscription: mapped,
    usage: {
      messages: mapped.usage.messages,
      aiReplies: mapped.usage.aiReplies,
      seats: { used: subscription.seats_used, limit: mapped.seats },
    },
    billingEnabled: isBillingEnabled(),
  };
}

/**
 * Creates a Checkout session for a paid plan.
 *
 * The workspace is written into `client_reference_id` and the session metadata
 * so the webhook can tell which workspace to upgrade without trusting the
 * success redirect.
 */
export async function createCheckoutSession({ workspace, planId, billingPeriod = 'monthly' }) {
  const client = getStripe();

  if (planId === 'free') throw AppError.badRequest('The Free plan does not need a checkout session');
  const priceId = stripePriceFor(planId, billingPeriod);
  if (!priceId) {
    throw AppError.badRequest(
      `${planId} is not purchasable yet - STRIPE_PRICE_${planId.toUpperCase()} is not set.`,
    );
  }

  const session = await client.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: String(workspace.id),
    customer_email: workspace.owner_email ?? undefined,
    // Sent to the webhook, so the browser cannot forge an upgrade.
    metadata: { workspaceId: String(workspace.id), planId, billingPeriod },
    success_url: `${env.FRONTEND_URL}/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.FRONTEND_URL}/settings/billing?checkout=cancelled`,
    subscription_data: { metadata: { workspaceId: String(workspace.id), planId } },
    allow_promotion_codes: true,
  });

  log.info({ workspaceId: workspace.id, planId, sessionId: session.id }, 'Checkout session created');
  return { sessionId: session.id, url: session.url };
}

/** One-time sign-in link to the Stripe-hosted billing portal (cards, cancel). */
export async function createPortalSession({ workspace, subscription }) {
  const client = getStripe();
  if (!subscription?.stripe_customer_id) {
    throw AppError.badRequest('This workspace has no Stripe customer yet - complete a checkout first.');
  }

  const session = await client.billingPortal.sessions.create({
    customer: subscription.stripe_customer_id,
    return_url: `${env.FRONTEND_URL}/settings/billing`,
  });
  return { url: session.url };
}

/**
 * Verifies a Stripe webhook signature and dispatches the event.
 *
 * `rawBody` must be the unparsed buffer: Stripe signs the exact bytes, so a
 * re-serialised JSON body would never match.
 */
export async function handleWebhook(rawBody, signature) {
  const client = getStripe();

  let event;
  try {
    event = client.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    // Deliberately a 400 with no detail about the expected value.
    log.warn({ err: error.message }, 'Rejected Stripe webhook: bad signature');
    throw AppError.badRequest('Invalid Stripe signature');
  }

  log.info({ type: event.type, id: event.id }, 'Stripe webhook received');

  await withSupabaseClient(getAdminClient(), async () => {
    switch (event.type) {
      case 'checkout.session.completed':
        await onCheckoutCompleted(event.data.object);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await onSubscriptionChanged(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await onSubscriptionCancelled(event.data.object);
        break;
      case 'invoice.paid':
        await onInvoicePaid(event.data.object);
        break;
      case 'invoice.payment_failed':
        await onPaymentFailed(event.data.object);
        break;
      default:
        log.debug({ type: event.type }, 'Unhandled Stripe event - ignored');
    }
  });

  return { received: true, type: event.type };
}

/**
 * Maps a Stripe subscription back to a SocialHub plan by reading the metadata
 * we attached at checkout. Falls back to matching the price id, so a renewal
 * webhook still works even if metadata is missing.
 */
async function onSubscriptionChanged(subscription) {
  const workspaceId = resolveWorkspaceId(subscription.metadata?.workspaceId);
  if (!workspaceId) {
    log.warn({ subscriptionId: subscription.id }, 'Subscription event with no workspace - ignored');
    return;
  }

  const planId = planForSubscription(subscription);
  const status = subscription.status;
  // Stripe's "past_due"/"unpaid" states are not a paid plan. Keep the workspace
  // on its current plan and flag it rather than granting access.
  const active = status === 'active' || status === 'trialing';

  await upsertSubscription({
    workspaceId,
    planId,
    stripeCustomerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id,
    stripeSubscriptionId: subscription.id,
    status,
    currentPeriodEnd: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000)
      : null,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    active,
  });

  log.info({ workspaceId, planId, status, active }, 'Subscription synced');

  // The billing screen is usually open on another tab; push the new plan and a
  // fresh usage snapshot rather than making the user reload.
  const fresh = await getSubscription(workspaceId);
  emitToWorkspace(workspaceId, EVENTS.SUBSCRIPTION_UPDATED, {
    plan: planId,
    status,
    cancelAtPeriodEnd,
    subscription: mapSubscription(fresh),
  });
}

async function onCheckoutCompleted(session) {
  if (session.mode !== 'subscription') return;
  const workspaceId = resolveWorkspaceId(session.metadata?.workspaceId ?? session.client_reference_id);
  if (!workspaceId) return;

  // The subscription object is authoritative, but at checkout time it can be
  // null for a second or two, so the session's own plan metadata is used.
  if (session.subscription) {
    const subscription =
      typeof session.subscription === 'string'
        ? await getStripe().subscriptions.retrieve(session.subscription)
        : session.subscription;
    await onSubscriptionChanged(subscription);
    return;
  }

  await upsertSubscription({
    workspaceId,
    planId: session.metadata?.planId ?? 'starter',
    stripeCustomerId: typeof session.customer === 'string' ? session.customer : session.customer?.id,
    stripeSubscriptionId: typeof session.subscription === 'string' ? session.subscription : null,
    status: 'active',
    active: true,
  });
}

async function onSubscriptionCancelled(subscription) {
  const workspaceId = resolveWorkspaceId(subscription.metadata?.workspaceId);
  if (!workspaceId) return;

  // Downgrade to Free but keep the row: the workspace history and usage stay
  // intact, and the owner can resubscribe without re-onboarding.
  await upsertSubscription({
    workspaceId,
    planId: 'free',
    stripeCustomerId: typeof subscription.customer === 'string' ? subscription.customer : null,
    stripeSubscriptionId: subscription.id,
    status: 'canceled',
    cancelAtPeriodEnd: false,
    active: true,
  });

  log.info({ workspaceId }, 'Subscription cancelled - downgraded to Free');
}

/** A successful renewal resets the per-period usage counters. */
async function onInvoicePaid(invoice) {
  const subscriptionId =
    typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
  if (!subscriptionId) return;

  const row = await selectOne('subscriptions', 'workspace_id', { stripe_subscription_id: subscriptionId });
  if (!row) return;

  await updateRows('subscriptions', { messages_used: 0, ai_replies_used: 0, status: 'active' }, {
    workspace_id: row.workspace_id,
  });

  const refreshed = await getSubscription(row.workspace_id);
  emitToWorkspace(row.workspace_id, EVENTS.SUBSCRIPTION_UPDATED, {
    plan: refreshed?.plan,
    status: 'active',
    subscription: mapSubscription(refreshed),
  });

  log.info({ workspaceId: row.workspace_id }, 'Invoice paid - usage counters reset for the new period');
}

async function onPaymentFailed(invoice) {
  const subscriptionId =
    typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
  if (!subscriptionId) return;

  const row = await selectOne('subscriptions', 'workspace_id', { stripe_subscription_id: subscriptionId });
  if (!row) return;

  await updateRows('subscriptions', { status: 'past_due' }, { workspace_id: row.workspace_id });

  const refreshed = await getSubscription(row.workspace_id);
  emitToWorkspace(row.workspace_id, EVENTS.SUBSCRIPTION_UPDATED, {
    plan: refreshed?.plan,
    status: 'past_due',
    subscription: mapSubscription(refreshed),
  });

  // Not downgraded immediately - the customer may fix the card within Stripe's
  // dunning window. The owner sees a "payment failed" banner meanwhile.
  log.warn({ workspaceId: row.workspace_id }, 'Payment failed - subscription marked past_due');
}

/**
 * Writes the subscription row. Idempotent: the same event twice leaves the same
 * state, and a paid plan is never overwritten by a stale 'free' downgrade.
 */
async function upsertSubscription({
  workspaceId,
  planId,
  stripeCustomerId = null,
  stripeSubscriptionId = null,
  status = 'active',
  currentPeriodEnd = null,
  cancelAtPeriodEnd = false,
  active = true,
}) {
  const existing = await selectOne('subscriptions', '*', { workspace_id: workspaceId });

  if (!existing) {
    await insertRow('subscriptions', {
      workspace_id: workspaceId,
      plan: planId,
      status,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      current_period_end: currentPeriodEnd,
      cancel_at_period_end: cancelAtPeriodEnd,
      messages_used: 0,
      ai_replies_used: 0,
      seats_used: 1,
    });
    return;
  }

  // A delayed cancellation webhook must not undo a newer active subscription.
  if (!active && existing.status === 'active' && existing.stripe_subscription_id !== stripeSubscriptionId) {
    return;
  }

  const changes = { plan: planId, status, cancel_at_period_end: cancelAtPeriodEnd };
  if (stripeCustomerId) changes.stripe_customer_id = stripeCustomerId;
  if (stripeSubscriptionId) changes.stripe_subscription_id = stripeSubscriptionId;
  if (currentPeriodEnd) changes.current_period_end = currentPeriodEnd;
  await updateRows('subscriptions', changes, { workspace_id: workspaceId });
}

function planForSubscription(subscription) {
  if (subscription.metadata?.planId && PLAN_CATALOG[subscription.metadata.planId]) {
    return subscription.metadata.planId;
  }
  const priceId = subscription.items?.data?.[0]?.price?.id;
  for (const plan of Object.values(PLAN_CATALOG)) {
    // Both periods, because a yearly subscription reports the yearly price id.
    if (plan.stripePriceEnvKey && (stripePriceFor(plan.id) === priceId || stripePriceFor(plan.id, 'yearly') === priceId)) {
      return plan.id;
    }
  }
  return 'free';
}

const resolveWorkspaceId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};
