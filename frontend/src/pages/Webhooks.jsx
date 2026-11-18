import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useApp } from '../context/AppContext.jsx';
import { fullDate, relativeTime } from '../lib/format.js';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  Skeleton,
} from '../components/ui.jsx';
import { PlusIcon, TrashIcon, WebhookIcon } from '../components/Icons.jsx';

/**
 * Developer > Webhooks.
 *
 * The important thing this screen communicates is that delivery is
 * AT-MOST-ONCE-ISH, not guaranteed: a failed POST is retried with exponential
 * backoff and then disabled, so the delivery log is the place to look when a
 * customer says they missed something.
 */

const STATUS_TONE = {
  active: 'green',
  disabled: 'slate',
};

const DELIVERY_TONE = {
  delivered: 'green',
  pending: 'amber',
  failed: 'rose',
  exhausted: 'rose',
  processing: 'brand',
};

export default function Webhooks() {
  const { activeWorkspaceId, can, toast } = useApp();
  const queryClient = useQueryClient();
  const isAdmin = can('owner', 'admin');

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ url: '', events: [], description: '' });
  const [newSecret, setNewSecret] = useState(null);
  const [logFor, setLogFor] = useState(null);

  const endpointsQuery = useQuery({
    queryKey: ['webhook-endpoints', activeWorkspaceId],
    queryFn: () => api.get('/webhook-endpoints'),
    enabled: Boolean(activeWorkspaceId),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['webhook-endpoints', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['webhook-deliveries', activeWorkspaceId] });
  };

  const events = endpointsQuery.data?.events ?? [];

  const createEndpoint = useMutation({
    mutationFn: () =>
      api.post('/webhook-endpoints', {
        url: form.url.trim(),
        events: form.events,
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
      }),
    onSuccess: (result) => {
      setCreateOpen(false);
      setForm({ url: '', events: [], description: '' });
      setNewSecret(result.signingSecret);
      invalidate();
      toast('Webhook endpoint created', 'success');
    },
    onError: (error) => toast(error.message ?? 'Could not create the endpoint', 'error'),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }) => api.patch(`/webhook-endpoints/${id}`, { status }),
    onSuccess: invalidate,
    onError: (error) => toast(error.message ?? 'Could not update the endpoint', 'error'),
  });

  const rotateSecret = useMutation({
    mutationFn: (id) => api.post(`/webhook-endpoints/${id}/rotate-secret`),
    onSuccess: (result) => {
      setNewSecret(result.signingSecret);
      invalidate();
      toast('Signing secret rotated', 'success');
    },
    onError: (error) => toast(error.message ?? 'Could not rotate the secret', 'error'),
  });

  const deleteEndpoint = useMutation({
    mutationFn: (id) => api.delete(`/webhook-endpoints/${id}`),
    onSuccess: () => {
      invalidate();
      toast('Endpoint deleted', 'success');
    },
    onError: (error) => toast(error.message ?? 'Could not delete the endpoint', 'error'),
  });

  const toggleEvent = (event) =>
    setForm((current) => ({
      ...current,
      events: current.events.includes(event)
        ? current.events.filter((e) => e !== event)
        : [...current.events, event],
    }));

  if (endpointsQuery.isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="h-64" />
      </div>
    );
  }

  const endpoints = endpointsQuery.data?.endpoints ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Webhooks</h1>
          <p className="text-sm text-slate-500">
            Push events to your own server, signed with HMAC-SHA256.
          </p>
        </div>
        {isAdmin && (
          <Button icon={<PlusIcon className="h-4 w-4" />} onClick={() => setCreateOpen(true)}>
            Add endpoint
          </Button>
        )}
      </div>

      <Alert tone="info" title="How to verify a delivery">
        Every request carries <code>X-SocialHub-Signature</code>,{' '}
        <code>X-SocialHub-Timestamp</code> and <code>X-SocialHub-Event</code>. Compute{' '}
        <code>HMAC-SHA256(secret, timestamp + &quot;.&quot; + rawBody)</code>, compare in constant
        time, and reject timestamps older than 5 minutes to block replays. A 2xx response counts
        as delivered; anything else is retried with exponential backoff.
      </Alert>

      {!isAdmin && <Alert tone="info">Only workspace owners and admins can manage webhooks.</Alert>}

      {endpoints.length === 0 ? (
        <Card>
          <EmptyState
            icon={<WebhookIcon className="h-6 w-6" />}
            title="No webhook endpoints"
            description="Add an endpoint to receive events like message.created in your own system."
            action={
              isAdmin ? (
                <Button icon={<PlusIcon className="h-4 w-4" />} onClick={() => setCreateOpen(true)}>
                  Add endpoint
                </Button>
              ) : null
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {endpoints.map((endpoint) => (
            <Card key={endpoint.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-mono text-sm text-slate-900">{endpoint.url}</p>
                    <Badge tone={STATUS_TONE[endpoint.status] ?? 'slate'}>{endpoint.status}</Badge>
                    {endpoint.failureCount > 0 && (
                      <Badge tone="amber">{endpoint.failureCount} failed</Badge>
                    )}
                  </div>

                  {endpoint.description && (
                    <p className="text-sm text-slate-500">{endpoint.description}</p>
                  )}

                  <div className="flex flex-wrap gap-1.5">
                    {endpoint.events.map((event) => (
                      <Badge key={event} tone="brand">
                        {event}
                      </Badge>
                    ))}
                  </div>

                  {endpoint.disabledReason && (
                    <p className="text-xs text-amber-700">{endpoint.disabledReason}</p>
                  )}

                  <p className="text-xs text-slate-400">
                    Created {fullDate(endpoint.createdAt)}
                    {endpoint.lastDeliveryAt
                      ? ` · last delivery ${relativeTime(endpoint.lastDeliveryAt)}`
                      : ' · no deliveries yet'}
                  </p>
                </div>

                {isAdmin && (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="ghost" onClick={() => setLogFor(endpoint)}>
                      Deliveries
                    </Button>
                    <Button
                      variant="ghost"
                      loading={rotateSecret.isPending}
                      onClick={() => rotateSecret.mutate(endpoint.id)}
                    >
                      Rotate secret
                    </Button>
                    {endpoint.status === 'active' ? (
                      <Button
                        variant="ghost"
                        loading={setStatus.isPending}
                        onClick={() => setStatus.mutate({ id: endpoint.id, status: 'disabled' })}
                      >
                        Disable
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        loading={setStatus.isPending}
                        onClick={() => setStatus.mutate({ id: endpoint.id, status: 'active' })}
                      >
                        Enable
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      icon={<TrashIcon className="h-4 w-4" />}
                      loading={deleteEndpoint.isPending}
                      onClick={() => deleteEndpoint.mutate(endpoint.id)}
                    >
                      Delete
                    </Button>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* --- create ------------------------------------------------------ */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Add webhook endpoint"
        description="We will POST events to this URL. It must be publicly reachable over HTTPS."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={createEndpoint.isPending}
              disabled={!form.url.trim() || form.events.length === 0}
              onClick={() => createEndpoint.mutate()}
            >
              Create endpoint
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Endpoint URL"
            placeholder="https://example.com/hooks/socialhub"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
          />

          <Input
            label="Description (optional)"
            placeholder="Production events"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />

          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-700">Events</p>
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2 scroll-slim">
              {events.map((event) => (
                <label
                  key={event}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50"
                >
                  <input
                    type="checkbox"
                    className="rounded border-slate-300 text-brand-600"
                    checked={form.events.includes(event)}
                    onChange={() => toggleEvent(event)}
                  />
                  <span className="font-mono text-xs">{event}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </Modal>

      {/* --- signing secret, shown once ---------------------------------- */}
      <Modal
        open={Boolean(newSecret)}
        onClose={() => setNewSecret(null)}
        title="Signing secret"
        description="Store this now. Rotating it invalidates the previous secret immediately."
        footer={<Button onClick={() => setNewSecret(null)}>Done</Button>}
      >
        <code className="block select-all break-all rounded-lg bg-slate-900 p-3 font-mono text-xs text-emerald-300">
          {newSecret}
        </code>
      </Modal>

      {logFor && <DeliveryLog endpoint={logFor} onClose={() => setLogFor(null)} />}
    </div>
  );
}

/** Per-endpoint delivery history, fetched only while the modal is open. */
function DeliveryLog({ endpoint, onClose }) {
  const query = useQuery({
    queryKey: ['webhook-deliveries', endpoint.id],
    queryFn: () => api.get(`/webhook-endpoints/deliveries?endpointId=${endpoint.id}&limit=50`),
  });

  const deliveries = query.data?.deliveries ?? [];

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Recent deliveries"
      description={endpoint.url}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {query.isLoading ? (
        <Skeleton className="h-40" />
      ) : deliveries.length === 0 ? (
        <p className="text-sm text-slate-500">No deliveries yet.</p>
      ) : (
        <div className="space-y-2">
          {deliveries.map((delivery) => (
            <div key={delivery.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-xs">{delivery.event}</span>
                <div className="flex items-center gap-2">
                  <Badge tone={DELIVERY_TONE[delivery.status] ?? 'slate'}>
                    {delivery.status}
                  </Badge>
                  <span className="text-xs text-slate-400">
                    attempt {delivery.attempt}
                    {delivery.maxAttempts ? `/${delivery.maxAttempts}` : ''}
                  </span>
                </div>
              </div>

              <p className="mt-1 text-xs text-slate-500">
                {fullDate(delivery.createdAt)}
                {delivery.responseStatus ? ` · HTTP ${delivery.responseStatus}` : ''}
                {delivery.durationMs != null ? ` · ${delivery.durationMs}ms` : ''}
              </p>

              {delivery.error && (
                <p className="mt-1 break-words text-xs text-rose-600">{delivery.error}</p>
              )}

              {delivery.nextAttemptAt && delivery.status === 'pending' && (
                <p className="mt-1 text-xs text-amber-700">
                  Next attempt {relativeTime(delivery.nextAttemptAt)}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
