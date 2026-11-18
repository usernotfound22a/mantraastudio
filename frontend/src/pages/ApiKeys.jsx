import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useApp } from '../context/AppContext.jsx';
import { fullDate } from '../lib/format.js';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  Select,
  Skeleton,
} from '../components/ui.jsx';
import { BoltIcon, KeyIcon, PlusIcon, TrashIcon } from '../components/Icons.jsx';

/**
 * Developer > API keys.
 *
 * The one rule this page has to get right: the secret is shown EXACTLY once, at
 * creation. The server only stores a SHA-256 hash, so after the modal closes
 * there is nothing left to reveal - which is why the copyable secret gets its
 * own modal instead of a row that could pretend to be re-readable.
 */
export default function ApiKeys() {
  const { activeWorkspaceId, can, toast } = useApp();
  const queryClient = useQueryClient();
  const isAdmin = can('owner', 'admin');

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: '', scopes: [], expiresInDays: '' });
  const [newSecret, setNewSecret] = useState(null);

  const { data, isLoading } = useQuery({
    queryKey: ['api-keys', activeWorkspaceId],
    queryFn: () => api.get('/api-keys'),
    enabled: Boolean(activeWorkspaceId),
  });

  // The server is the source of truth for the scope list, so a new scope added
  // on the backend shows up here without a frontend change.
  const allScopes = data?.scopes ?? [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['api-keys', activeWorkspaceId] });

  const createKey = useMutation({
    mutationFn: () =>
      api.post('/api-keys', {
        name: form.name.trim(),
        scopes: form.scopes,
        ...(form.expiresInDays ? { expiresInDays: Number(form.expiresInDays) } : {}),
      }),
    onSuccess: (result) => {
      setCreateOpen(false);
      setForm({ name: '', scopes: [], expiresInDays: '' });
      setNewSecret(result.secret);
      invalidate();
      toast('API key created', 'success');
    },
    onError: (error) => toast(error.message ?? 'Could not create the key', 'error'),
  });

  const revokeKey = useMutation({
    mutationFn: (id) => api.delete(`/api-keys/${id}`),
    onSuccess: () => {
      invalidate();
      toast('API key revoked', 'success');
    },
    onError: (error) => toast(error.message ?? 'Could not revoke the key', 'error'),
  });

  const toggleScope = (scope) =>
    setForm((current) => ({
      ...current,
      scopes: current.scopes.includes(scope)
        ? current.scopes.filter((s) => s !== scope)
        : [...current.scopes, scope],
    }));

  if (isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="h-64" />
      </div>
    );
  }

  const keys = data?.keys ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">API keys</h1>
          <p className="text-sm text-slate-500">
            Let an external system read and reply to this workspace over{' '}
            <code className="rounded bg-slate-100 px-1">/api/v1</code>.
          </p>
        </div>
        {isAdmin && (
          <Button icon={<PlusIcon className="h-4 w-4" />} onClick={() => setCreateOpen(true)}>
            New API key
          </Button>
        )}
      </div>

      {!isAdmin && (
        <Alert tone="info">Only workspace owners and admins can manage API keys.</Alert>
      )}

      {keys.length === 0 ? (
        <Card>
          <EmptyState
            icon={<KeyIcon className="h-6 w-6" />}
            title="No API keys yet"
            description="Create a key to connect an integration. Each key is limited to the scopes you choose."
            action={
              isAdmin ? (
                <Button icon={<PlusIcon className="h-4 w-4" />} onClick={() => setCreateOpen(true)}>
                  New API key
                </Button>
              ) : null
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {keys.map((key) => (
            <Card key={key.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-slate-900">{key.name}</p>
                    {key.revokedAt && <Badge tone="rose">revoked</Badge>}
                    {!key.revokedAt && key.expiresAt && (
                      <Badge tone="amber">expires {fullDate(key.expiresAt)}</Badge>
                    )}
                    {!key.revokedAt && !key.expiresAt && <Badge tone="slate">no expiry</Badge>}
                  </div>

                  <p className="font-mono text-xs text-slate-500">{key.keyPrefix}...</p>

                  <div className="flex flex-wrap gap-1.5">
                    {key.scopes.map((scope) => (
                      <Badge key={scope} tone="brand">
                        {scope}
                      </Badge>
                    ))}
                  </div>

                  <p className="text-xs text-slate-400">
                    Created {fullDate(key.createdAt)}
                    {key.lastUsedAt ? ` · last used ${fullDate(key.lastUsedAt)}` : ' · never used'}
                  </p>
                </div>

                {isAdmin && !key.revokedAt && (
                  <Button
                    variant="ghost"
                    icon={<TrashIcon className="h-4 w-4" />}
                    loading={revokeKey.isPending}
                    onClick={() => revokeKey.mutate(key.id)}
                  >
                    Revoke
                  </Button>
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
        title="New API key"
        description="Pick the smallest set of scopes the integration actually needs."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={createKey.isPending}
              disabled={!form.name.trim() || form.scopes.length === 0}
              onClick={() => createKey.mutate()}
            >
              Create key
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Name"
            placeholder="Zendesk integration"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />

          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-700">Scopes</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {allScopes.map((scope) => (
                <label
                  key={scope}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50"
                >
                  <input
                    type="checkbox"
                    className="rounded border-slate-300 text-brand-600"
                    checked={form.scopes.includes(scope)}
                    onChange={() => toggleScope(scope)}
                  />
                  <span className="font-mono text-xs">{scope}</span>
                </label>
              ))}
            </div>
            <p className="text-xs text-slate-500">
              A key can only reach its own workspace, whatever the scopes say.
            </p>
          </div>

          <Select
            label="Expiry"
            value={form.expiresInDays}
            onChange={(e) => setForm({ ...form, expiresInDays: e.target.value })}
          >
            <option value="">Never expires</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="180">180 days</option>
            <option value="365">365 days</option>
          </Select>
        </div>
      </Modal>

      {/* --- the one and only reveal of the secret ------------------------ */}
      <Modal
        open={Boolean(newSecret)}
        onClose={() => setNewSecret(null)}
        title="Copy your key now"
        description="This is the only time the key is shown. It is stored as a hash, so it cannot be recovered later."
        footer={
          <Button onClick={() => setNewSecret(null)}>Done</Button>
        }
      >
        <div className="space-y-3">
          <Alert tone="warning" title="Store it somewhere safe now">
            Once you close this dialog the secret is gone for good. If you lose it, revoke the key
            and create a new one.
          </Alert>
          <code className="block select-all break-all rounded-lg bg-slate-900 p-3 font-mono text-xs text-emerald-300">
            {newSecret}
          </code>
          <p className="text-xs text-slate-500">
            Send it as an{' '}
            <code className="rounded bg-slate-100 px-1">Authorization: Bearer &lt;key&gt;</code>{' '}
            header.
          </p>
        </div>
      </Modal>
    </div>
  );
}
