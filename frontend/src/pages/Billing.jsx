/**
 * Billing: current plan, live usage against plan limits, and upgrades.
 *
 * Checkout happens on Stripe's hosted page, so this screen's only real job is
 * to start the session and then reflect whatever the webhook did. The
 * `?checkout=success` param is Stripe's redirect, not proof of payment - the
 * plan flip happens in the webhook - so the summary is refetched on arrival.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useApp } from '../context/AppContext.jsx';
import { CHANNEL_LABELS, fullDate, number } from '../lib/format.js';
import { Alert, Badge, Button, Card, Modal, Skeleton, cx } from '../components/ui.jsx';
import { BillingIcon, CheckIcon, ExternalIcon } from '../components/Icons.jsx';

export default function Billing() {
  const { can, toast, onRealtime, EVENTS: EV, activeWorkspaceId } = useApp();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [period, setPeriod] = useState('monthly');
  const [purchasing, setPurchasing] = useState(null);

  // Workspace-scoped: the API reads the X-Workspace header, so a key without
  // the workspace id would serve the previous tenant's subscription on switch.
  const summary = useQuery({
    queryKey: ['billing-summary', activeWorkspaceId],
    queryFn: () => api.get('/billing/subscription'),
  });
  // `plans` is a global catalogue (not tenant data) so it needs no scoping.
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => api.get('/billing/plans') });

  const checkoutState = searchParams.get('checkout');

  // Stripe redirects back here. The webhook is the authority on whether the
  // upgrade landed, so refetch instead of showing a fake success state.
  useEffect(() => {
    if (!checkoutState) return;
    queryClient.invalidateQueries({ queryKey: ['billing-summary'] });
    queryClient.invalidateQueries({ queryKey: ['plans'] });
    if (checkoutState === 'success') {
      toast('Payment received. Your plan updates as soon as Stripe confirms it.', 'success');
    } else {
      toast('Checkout cancelled - nothing was charged.', 'info');
    }
    setSearchParams({}, { replace: true });
  }, [checkoutState, queryClient, setSearchParams, toast]);

  useEffect(() => {
    const off = onRealtime(EV.SUBSCRIPTION_UPDATED, () => {
      queryClient.invalidateQueries({ queryKey: ['billing-summary'] });
    });
    return off;
  }, [onRealtime, EV, queryClient]);

  const checkout = useMutation({
    mutationFn: (planId) => api.post('/billing/checkout', { planId, billingPeriod: period }),
    onSuccess: (data) => {
      // Stripe hosts the payment page; there is nothing to render here.
      window.location.href = data.url;
    },
    onError: (error) => {
      toast(error.message ?? 'Could not start checkout', 'error');
      setPurchasing(null);
    },
  });

  const portal = useMutation({
    mutationFn: () => api.post('/billing/portal', {}),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
    onError: (error) => toast(error.message ?? 'Could not open the billing portal', 'error'),
  });

  const canPay = can('owner');
  const current = summary.data?.plan;
  const subscription = summary.data?.subscription;
  const enabled = summary.data?.billingEnabled !== false;

  return (
    <div className="h-full overflow-y-auto scroll-slim">
      <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
        <header>
          <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
            <BillingIcon className="h-5 w-5 text-brand-600" /> Billing
          </h1>
          <p className="text-sm text-slate-500">Plan, usage and invoices for this workspace.</p>
        </header>

        {!canPay && (
          <Alert tone="info" title="Only the workspace owner can change the plan">
            You can see usage, but upgrades and payment details belong to the owner.
          </Alert>
        )}

        {!enabled && (
          <Alert tone="warning" title="Payments are not configured on this server">
            The plan limits below are real and already enforced, but Stripe is not wired up, so upgrades
            cannot be completed. Set <code>STRIPE_SECRET_KEY</code>, the plan price ids, and{' '}
            <code>STRIPE_WEBHOOK_SECRET</code> in the backend <code>.env</code>.
          </Alert>
        )}

        {/* ------------------------------------------------------ Current */}
        <Card
          title="Current plan"
          description={subscription ? `Renews ${fullDate(subscription.currentPeriodEnd)}` : 'No billing record yet.'}
          actions={
            subscription && (
              <Badge tone={statusTone(subscription.status)}>{subscription.status}</Badge>
            )
          }
        >
          {summary.isLoading && <Skeleton className="h-24" />}

          {current && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-baseline gap-2">
                <p className="text-2xl font-semibold text-slate-900">{current.name}</p>
                <p className="text-sm text-slate-500">
                  {current.priceMonthly === 0 ? 'Free forever' : `$${current.priceMonthly} / month`}
                </p>
              </div>

              {subscription && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Usage label="Messages" used={subscription.usage.messages.used} limit={subscription.usage.messages.limit} />
                  <Usage label="AI replies" used={subscription.usage.aiReplies.used} limit={subscription.usage.aiReplies.limit} />
                </div>
              )}

              {subscription?.stripe?.cancelAtPeriodEnd && (
                <Alert tone="warning" title="Cancelling">
                  Access continues until {fullDate(subscription.currentPeriodEnd)}. Reactivate from the
                  billing portal.
                </Alert>
              )}

              {canPay && subscription?.stripe?.customerId && (
                <Button
                  variant="secondary"
                  loading={portal.isPending}
                  icon={<ExternalIcon className="h-4 w-4" />}
                  onClick={() => portal.mutate()}
                >
                  Manage card and invoices
                </Button>
              )}
            </div>
          )}
        </Card>

        {/* --------------------------------------------------------- Plans */}
        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900">Plans</h2>
            <div className="flex gap-1">
              {['monthly', 'yearly'].map((option) => (
                <button
                  key={option}
                  onClick={() => setPeriod(option)}
                  className={cx(
                    'rounded-lg px-2.5 py-1 text-xs font-medium transition-colors',
                    period === option ? 'bg-brand-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-100',
                  )}
                >
                  {option === 'monthly' ? 'Monthly' : 'Yearly'}
                </button>
              ))}
            </div>
          </div>

          {plans.isLoading && <Skeleton className="h-64" />}

          <div className="grid gap-4 md:grid-cols-3">
            {plans.data?.plans?.map((plan) => {
              const isCurrent = plan.id === plans.data.currentPlanId;
              const price = period === 'monthly' ? plan.priceMonthly : plan.priceYearly;
              const canBuyThis = plan.purchasable?.[period] ?? plan.purchasable?.any;
              const highlight = plan.id === 'pro';

              return (
                <div
                  key={plan.id}
                  className={cx(
                    'card flex flex-col p-4',
                    isCurrent && 'ring-2 ring-brand-500',
                    highlight && !isCurrent && 'ring-1 ring-slate-300',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-slate-900">{plan.name}</p>
                    {isCurrent && <Badge tone="brand">current</Badge>}
                    {highlight && !isCurrent && <Badge tone="violet">popular</Badge>}
                  </div>

                  <p className="mt-2">
                    <span className="text-2xl font-semibold text-slate-900">${price}</span>
                    <span className="text-sm text-slate-500"> / {period === 'monthly' ? 'mo' : 'yr'}</span>
                  </p>

                  <ul className="mt-3 flex-1 space-y-1.5">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-1.5 text-xs text-slate-600">
                        <CheckIcon className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
                        {feature}
                      </li>
                    ))}
                  </ul>

                  <p className="mt-3 text-[11px] text-slate-400">
                    Includes: {plan.channels.map((type) => CHANNEL_LABELS[type] ?? type).join(', ')}
                  </p>

                  <div className="mt-3">
                    {isCurrent ? (
                      <Button variant="secondary" disabled className="w-full">
                        Your plan
                      </Button>
                    ) : plan.id === 'free' ? (
                      <Button
                        variant="secondary"
                        className="w-full"
                        disabled={!canPay}
                        onClick={() => toast('Downgrades are handled from the billing portal.', 'info')}
                      >
                        Downgrade
                      </Button>
                    ) : (
                      <Button
                        className="w-full"
                        disabled={!canPay || !canBuyThis}
                        loading={purchasing === plan.id}
                        onClick={() => {
                          setPurchasing(plan.id);
                          checkout.mutate(plan.id);
                        }}
                      >
                        {canBuyThis ? `Upgrade to ${plan.name}` : 'Unavailable'}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function Usage({ label, used, limit }) {
  const percent = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const tone = percent >= 90 ? 'bg-rose-500' : percent >= 70 ? 'bg-amber-500' : 'bg-brand-500';

  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-slate-700">{label}</span>
        <span className="tabular-nums text-slate-500">
          {number(used)} / {number(limit)}
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-200">
        <div className={cx('h-full rounded-full', tone)} style={{ width: `${Math.max(2, percent)}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-slate-400">
        {percent >= 100
          ? 'Limit reached. The assistant will stop replying until the plan resets.'
          : `${number(limit - used)} left this period`}
      </p>
    </div>
  );
}

const statusTone = (status) =>
  ({ active: 'green', trialing: 'green', past_due: 'amber', canceled: 'slate', unpaid: 'rose' })[status] ??
  'slate';
