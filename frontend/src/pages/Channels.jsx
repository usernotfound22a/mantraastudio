/**
 * Channels: connect where customers talk, and install the website widget.
 *
 * The Meta flow is a redirect dance the server owns, so this page only has to
 * start it and finish it:
 *   1. GET /channels/meta/oauth/start?redirect=...  -> 302 to Facebook
 *   2. the server calls us back and redirects here with ?connectToken=...
 *   3. the user picks a Page, we POST /channels/meta/connect
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useApp } from '../context/AppContext.jsx';
import { CHANNEL_LABELS, fullDate, number } from '../lib/format.js';
import { Alert, Badge, Button, Card, Input, Modal, Select, Switch, cx } from '../components/ui.jsx';
import { BoltIcon, ChannelsIcon, CheckIcon, CopyIcon, ExternalIcon, PlusIcon, TrashIcon } from '../components/Icons.jsx';

export default function Channels() {
  const { can, toast, onRealtime, EVENTS: EV, activeWorkspaceId } = useApp();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [adding, setAdding] = useState(false);
  const [startingMeta, setStartingMeta] = useState(false);
  const [metaForm, setMetaForm] = useState({ appId: '', appSecret: '' });
  const canManageMeta = can('owner', 'admin');
  const connectToken = searchParams.get('connectToken');
  const oauthError = searchParams.get('error');

  const { data, isLoading } = useQuery({
    // Scoped by workspace so switching tenants cannot show the old one's pages.
    queryKey: ['channels', activeWorkspaceId],
    queryFn: () => api.get('/channels'),
  });
  const { data: meta } = useQuery({
    queryKey: ['meta-availability'],
    queryFn: () => api.get('/channels/meta/availability'),
  });
  const { data: metaConfig } = useQuery({
    queryKey: ['meta-config'],
    queryFn: () => api.get('/channels/meta/config'),
    enabled: canManageMeta,
  });

  useEffect(() => {
    if (metaConfig?.appId) {
      setMetaForm((current) => current.appId ? current : { ...current, appId: metaConfig.appId });
    }
  }, [metaConfig?.appId]);

  const saveMetaConfig = useMutation({
    mutationFn: () => api.put('/channels/meta/config', metaForm),
    onSuccess: () => {
      setMetaForm((current) => ({ ...current, appSecret: '' }));
      queryClient.invalidateQueries({ queryKey: ['meta-config'] });
      queryClient.invalidateQueries({ queryKey: ['meta-availability'] });
      toast('Meta credentials saved encrypted on the server', 'success');
    },
    onError: (error) => toast(error.message ?? 'Could not save Meta credentials', 'error'),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['channels'] });
  };

  // Another tab connected or disconnected something.
  useEffect(() => {
    const offs = [
      onRealtime(EV.CHANNEL_CREATED, invalidate),
      onRealtime(EV.CHANNEL_UPDATED, invalidate),
      onRealtime(EV.CHANNEL_DELETED, invalidate),
    ];
    return () => offs.forEach((off) => off());
  }, [onRealtime]);

  const channels = data?.channels ?? [];
  const website = channels.find((channel) => channel.type === 'website');
  const social = channels.filter((channel) => channel.type !== 'website');

  return (
    <div className="h-full overflow-y-auto scroll-slim">
      <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
        {oauthError && (
          <Alert tone="danger" title="Meta could not connect">
            {oauthError}. Nothing was saved. You can retry from this page.
          </Alert>
        )}
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Channels</h1>
            <p className="text-sm text-slate-500">
              Every conversation lands in one inbox, whatever the customer used.
            </p>
          </div>
          {can('owner', 'admin') && (
            <Button icon={<PlusIcon className="h-4 w-4" />} onClick={() => setAdding(true)}>
              Connect a channel
            </Button>
          )}
        </header>

        {/* ------------------------------------------------------- Website */}
        <Card
          title="Website chat"
          description="The embeddable widget. No third-party account needed."
        >
          {isLoading && <p className="text-sm text-slate-500">Loading…</p>}

          {!isLoading && !website && can('owner', 'admin') && (
            <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-slate-300 p-4">
              <p className="text-sm text-slate-600">
                Create the website channel to get a widget key and the embed snippet.
              </p>
              <CreateWebsite onDone={() => { invalidate(); }} />
            </div>
          )}

          {website && (
            <div className="space-y-4">
              <ChannelRow channel={website} onChanged={invalidate} />
              <WidgetEmbed channel={website} />
            </div>
          )}
        </Card>

        {/* --------------------------------------------------------- Meta */}
        <Card
          title="Messenger, Instagram & WhatsApp"
          description="Configure your Meta app once, then authorize Pages and WhatsApp numbers."
          actions={
            meta && !meta.configured ? (
              <Badge tone="amber">Server not configured</Badge>
            ) : null
          }
        >
          {canManageMeta && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                saveMetaConfig.mutate();
              }}
              className="mb-4 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  label="Meta App ID"
                  value={metaForm.appId}
                  onChange={(event) => setMetaForm((current) => ({ ...current, appId: event.target.value }))}
                  autoComplete="off"
                  required
                />
                <Input
                  label="Meta App Secret"
                  type="password"
                  value={metaForm.appSecret}
                  onChange={(event) => setMetaForm((current) => ({ ...current, appSecret: event.target.value }))}
                  autoComplete="new-password"
                  placeholder={metaConfig?.hasAppSecret ? 'Saved; leave blank to keep it' : ''}
                  required={!metaConfig?.hasAppSecret}
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-slate-500">
                  Applies server-wide. The secret is encrypted at rest and never shown after saving.
                </p>
                <Button
                  type="submit"
                  size="sm"
                  loading={saveMetaConfig.isPending}
                  disabled={!metaForm.appId.trim() || (!metaForm.appSecret.trim() && !metaConfig?.hasAppSecret)}
                >
                  Save Meta settings
                </Button>
              </div>
            </form>
          )}

          {meta && !meta.configured && (
            <Alert tone="warning" title="Save Meta app credentials to enable social channels">
              Add the App ID and App Secret above. Your Meta app must include the Messenger,
              Instagram Messaging, and WhatsApp products.{' '}
              {meta.webhookUrls.messenger && meta.webhookUrls.instagram && meta.webhookUrls.whatsapp ? (
                <>
                  The webhook URLs you will need are{' '}
                  <code className="break-all">{meta.webhookUrls.messenger}</code> and{' '}
                  <code className="break-all">{meta.webhookUrls.instagram}</code> and{' '}
                  <code className="break-all">{meta.webhookUrls.whatsapp}</code>.
                </>
              ) : (
                <>
                  Set <code>WEBHOOK_BASE_URL</code> to your public HTTPS tunnel URL (for example,
                  ngrok or Cloudflare Tunnel) to see the webhook callback URLs.
                </>
              )}
            </Alert>
          )}

          {meta?.configured && (
            <p className="mb-3 text-xs text-slate-500">
              Meta calls this server, not the browser. A public HTTPS tunnel is required for OAuth
              callbacks and message webhooks.
            </p>
          )}

          {meta?.configured && !meta.publicUrl && (
            <Alert tone="warning" title="Public callback URL is not configured">
              Set <code>WEBHOOK_BASE_URL</code> in the backend <code>.env</code> to your public HTTPS
              tunnel URL, then restart the API.
            </Alert>
          )}

          {social.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-600">
              No social channels connected yet.
            </p>
          ) : (
            <div className="divide-y divide-slate-100">
              {social.map((channel) => (
                <ChannelRow key={channel.id} channel={channel} onChanged={invalidate} />
              ))}
            </div>
          )}

          {can('owner', 'admin') && meta?.configured && (
            <Button
              variant="secondary"
              className="mt-3"
              icon={<ExternalIcon className="h-4 w-4" />}
              loading={startingMeta}
              disabled={!meta.publicUrl}
              onClick={async () => {
                setStartingMeta(true);
                try {
                  const { url } = await api.get('/channels/meta/oauth/url');
                  window.location.assign(url);
                } catch (error) {
                  toast(error.message ?? 'Could not start Meta authorization', 'error');
                  setStartingMeta(false);
                }
              }}
            >
              Connect Meta account
            </Button>
          )}
        </Card>

        {/* ------------------------------------------------- More adapters */}
        <Card title="Available integrations" description="Adapters the server has registered.">
          <ConnectCatalogue onAdd={() => setAdding(true)} canManage={can('owner', 'admin')} />
        </Card>
      </div>

      {/* Step 3 of the Meta flow: the user picks a Page. */}
      {connectToken && (
        <PagePicker
          connectToken={connectToken}
          onDone={() => {
            setSearchParams({}, { replace: true });
            invalidate();
            toast('Channel connected. New messages will appear in the inbox.', 'success');
            navigate('/', { replace: true });
          }}
          onCancel={() => setSearchParams({}, { replace: true })}
        />
      )}

      {adding && (
        <AddChannelModal
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

/** One connected channel, with its status and admin actions. */
function ChannelRow({ channel, onChanged }) {
  const { can, toast } = useApp();
  const queryClient = useQueryClient();
  const canManage = can('owner', 'admin');

  const toggle = useMutation({
    mutationFn: (status) => api.patch(`/channels/${channel.id}`, { status }),
    onSuccess: () => {
      toast(channel.status === 'connected' ? 'Channel disconnected' : 'Channel connected', 'success');
      onChanged();
    },
    onError: (error) => toast(error.message ?? 'Could not update the channel', 'error'),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/channels/${channel.id}`),
    onSuccess: () => {
      toast('Channel removed, along with its conversations', 'success');
      onChanged();
    },
    onError: (error) => toast(error.message ?? 'Could not remove the channel', 'error'),
  });

  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium text-slate-900">{channel.name}</p>
          <Badge tone={statusTone(channel.status)}>{channel.status}</Badge>
          {channel.isDefault && <Badge tone="brand">default</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-slate-500">
          {CHANNEL_LABELS[channel.type] ?? channel.type}
          {channel.externalId ? ` · id ${channel.externalId}` : ''}
          {` · connected ${fullDate(channel.createdAt)}`}
        </p>
        {channel.lastError && (
          <p className="mt-1 text-xs text-rose-600">Last error: {channel.lastError}</p>
        )}
        {!channel.hasCredentials?.length && channel.type !== 'website' && (
          <p className="mt-1 text-xs text-amber-700">No credentials stored - messages will fail.</p>
        )}
      </div>

      {canManage && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            loading={toggle.isPending}
            onClick={() => toggle.mutate(channel.status === 'connected' ? 'disconnected' : 'connected')}
          >
            {channel.status === 'connected' ? 'Disconnect' : 'Connect'}
          </Button>
          {confirming ? (
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="danger"
                loading={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Delete for good
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Keep
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} title="Remove this channel">
              <TrashIcon className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

const statusTone = (status) =>
  ({ connected: 'green', disconnected: 'slate', error: 'rose' })[status] ?? 'slate';

/** The copy-paste snippet plus a live preview of the launcher button. */
function WidgetEmbed({ channel }) {
  const { toast } = useApp();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const key = channel.config?.widgetKey;

  const snippet = `<script src="${window.location.origin.replace(/:\d+$/, ':4000')}/widget/socialhub.js" data-key="${key}"></script>`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      toast('Embed snippet copied', 'success');
    } catch {
      toast('Could not copy - select the text and copy it manually', 'error');
    }
  };

  const regenerate = useMutation({
    mutationFn: () => api.post(`/channels/${channel.id}/regenerate-widget-key`, {}),
    onSuccess: (data) => {
      setOpen(false);
      toast('New widget key generated. Update the script on your site.', 'success');
      queryClient.invalidateQueries({ queryKey: ['channels'] });
    },
    onError: (error) => toast(error.message ?? 'Could not rotate the key', 'error'),
  });

  if (!key) return null;

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-slate-700">Paste this before </p>
        <code className="rounded bg-slate-200 px-1.5 py-0.5 text-[11px] text-slate-700">&lt;/body&gt;</code>
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" variant="secondary" icon={<CopyIcon className="h-3.5 w-3.5" />} onClick={copy}>
            Copy
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
            Rotate key
          </Button>
        </div>
      </div>

      <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100 scroll-slim">
        {snippet}
      </pre>

      <div className="flex items-center gap-2 text-[11px] text-slate-500">
        <span>Launcher colour</span>
        <span
          className="h-4 w-4 rounded-full ring-1 ring-slate-300"
          style={{ background: channel.config?.themeColor ?? '#6366f1' }}
        />
        <code className="text-slate-400">{channel.config?.themeColor ?? '#6366f1'}</code>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Rotate the widget key?"
        description="Every existing embed stops working immediately, because the key is the only thing that ties a site to this inbox."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={regenerate.isPending} onClick={() => regenerate.mutate()}>
              Generate a new key
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          Use this when a key leaked, or when the same site was embedded by accident. Otherwise leave it alone.
        </p>
      </Modal>
    </div>
  );
}

/** Creates a website channel, asking only for a name. */
function CreateWebsite({ onDone }) {
  const { toast } = useApp();
  const [name, setName] = useState('Website chat');
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex w-full flex-wrap items-end gap-2">
      <Input
        label="Channel name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        className="min-w-48 flex-1"
      />
      <Button
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api.post('/channels', { type: 'website', name: name.trim() || 'Website chat' });
            toast('Website channel created', 'success');
            onDone();
          } catch (error) {
            toast(error.message ?? 'Could not create the channel', 'error');
          } finally {
            setBusy(false);
          }
        }}
      >
        Create
      </Button>
    </div>
  );
}

/** Step 3 of the Meta flow. */
function PagePicker({ connectToken, onDone, onCancel }) {
  const { toast } = useApp();
  const [pageId, setPageId] = useState('');
  const [types, setTypes] = useState([]);
  const [whatsappBusinessAccountId, setWhatsappBusinessAccountId] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const session = useQuery({
    queryKey: ['meta-connect-session', connectToken],
    queryFn: () => api.get(`/channels/meta/connect/${encodeURIComponent(connectToken)}`),
  });
  const pages = session.data?.pages ?? [];
  const whatsappAccounts = session.data?.whatsappAccounts ?? [];

  useEffect(() => {
    if (!session.data) return;
    setPageId(session.data.pages?.[0]?.id ?? '');
    const firstAccount = session.data.whatsappAccounts?.[0];
    setWhatsappBusinessAccountId(firstAccount?.id ?? '');
    setPhoneNumberId(firstAccount?.phoneNumbers?.[0]?.id ?? '');
    setTypes(session.data.pages?.length ? ['messenger'] : firstAccount ? ['whatsapp'] : []);
  }, [session.data]);

  const connect = useMutation({
    mutationFn: () =>
      api.post('/channels/meta/connect', {
        connectToken,
        ...(pageId ? { pageId } : {}),
        types,
        ...(types.includes('whatsapp') ? { whatsappBusinessAccountId, phoneNumberId } : {}),
      }),
    onSuccess: (data) => {
      if (data.warnings?.length) {
        toast(data.warnings[0], 'warning');
      } else {
        toast('Page connected', 'success');
      }
      onDone();
    },
    onError: (error) => toast(error.message ?? 'Could not connect the Page', 'error'),
  });

  return (
    <Modal
      open
      onClose={onCancel}
      title="Choose channels to connect"
      description="Select a Page for Messenger or Instagram, and a phone number for WhatsApp."
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={
              !types.length ||
              (types.some((type) => type !== 'whatsapp') && !pageId) ||
              (types.includes('whatsapp') && (!whatsappBusinessAccountId || !phoneNumberId))
            }
            loading={connect.isPending}
            onClick={() => connect.mutate()}
          >
            Connect
          </Button>
        </>
      }
    >
      {session.isLoading && <p className="text-sm text-slate-500">Loading accounts…</p>}
      {session.isError && <Alert tone="danger">This authorization expired or could not be loaded. Start the Meta connection again.</Alert>}

      {pages.length > 0 && (
        <Select label="Facebook Page" value={pageId} onChange={(event) => setPageId(event.target.value)}>
          {pages.map((page) => <option key={page.id} value={page.id}>{page.name}</option>)}
        </Select>
      )}

      <fieldset className="mt-4">
        <legend className="label">Enable for</legend>
        {[
          ...(pages.length ? ['messenger', 'instagram'] : []),
          ...(whatsappAccounts.length ? ['whatsapp'] : []),
        ].map((type) => (
          <label key={type} className="flex items-center gap-2 py-1 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={types.includes(type)}
              onChange={(event) =>
                setTypes((current) =>
                  event.target.checked
                    ? [...current, type]
                    : current.filter((value) => value !== type),
                )
              }
            />
            {CHANNEL_LABELS[type] ?? type}
          </label>
        ))}
      </fieldset>

      {types.includes('whatsapp') && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Select
            label="WhatsApp Business Account"
            value={whatsappBusinessAccountId}
            onChange={(event) => {
              const account = whatsappAccounts.find((candidate) => candidate.id === event.target.value);
              setWhatsappBusinessAccountId(event.target.value);
              setPhoneNumberId(account?.phoneNumbers?.[0]?.id ?? '');
            }}
          >
            {whatsappAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </Select>
          <Select label="Phone number" value={phoneNumberId} onChange={(event) => setPhoneNumberId(event.target.value)}>
            {(whatsappAccounts.find((account) => account.id === whatsappBusinessAccountId)?.phoneNumbers ?? []).map((phone) => (
              <option key={phone.id} value={phone.id}>{phone.displayPhoneNumber || phone.verifiedName || phone.id}</option>
            ))}
          </Select>
        </div>
      )}
    </Modal>
  );
}

/** "Connect a channel" for the adapters that need no third party. */
function AddChannelModal({ onClose, onDone }) {
  const { toast, activeWorkspaceId } = useApp();
  const { data } = useQuery({ queryKey: ['channels', activeWorkspaceId], queryFn: () => api.get('/channels') });
  // Global catalogue of installed adapters - not tenant data, so unscoped.
  const catalogue = useQuery({ queryKey: ['catalogue'], queryFn: () => api.get('/channels/catalogue') });
  const [type, setType] = useState('website');
  const [name, setName] = useState('');
  const [externalId, setExternalId] = useState('');

  const entries = useMemo(() => {
    const connected = new Set((data?.channels ?? []).map((channel) => channel.type));
    return (catalogue.data?.channels ?? [])
      .filter((entry) => !['messenger', 'instagram', 'whatsapp'].includes(entry.type))
      .map((entry) => ({ ...entry, connected: connected.has(entry.type) }));
  }, [catalogue.data, data]);

  const create = useMutation({
    mutationFn: () =>
      api.post('/channels', {
        type,
        name: name.trim() || entries.find((entry) => entry.type === type)?.label,
        externalId: externalId.trim() || undefined,
      }),
    onSuccess: () => {
      toast('Channel created', 'success');
      onDone();
    },
    onError: (error) => toast(error.message ?? 'Could not create the channel', 'error'),
  });

  const selected = entries.find((entry) => entry.type === type);

  return (
    <Modal
      open
      onClose={onClose}
      title="Connect a channel"
      description="Create local website channels here. Connect Messenger, Instagram, and WhatsApp through Meta authorization above."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={!type || (type !== 'website' && !name.trim())}
            onClick={() => create.mutate()}
          >
            Create channel
          </Button>
        </>
      }
    >
      <Select
        label="Type"
        value={type}
        onChange={(event) => {
          setType(event.target.value);
          setName('');
        }}
      >
        {entries.map((entry) => (
          <option key={entry.type} value={entry.type} disabled={entry.connected}>
            {entry.label}
            {entry.connected ? ' (already connected)' : ''}
          </option>
        ))}
      </Select>

      {selected?.description && <p className="mt-2 text-xs text-slate-500">{selected.description}</p>}

      <Input
        label="Name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder={selected?.label}
        className="mt-3"
      />

      {type !== 'website' && (
        <Input
          label="External account id"
          value={externalId}
          onChange={(event) => setExternalId(event.target.value)}
          hint="The id Meta shows for the Page. Leave blank if you are not sure."
          className="mt-3"
        />
      )}
    </Modal>
  );
}

function ConnectCatalogue({ canManage, onAdd }) {
    const { data } = useQuery({ queryKey: ['catalogue'], queryFn: () => api.get('/channels/catalogue') });
    const entries = data?.channels ?? [];

    if (entries.length === 0) return <p className="text-sm text-slate-500">No adapters registered.</p>;

    return (
      <ul className="grid gap-3 sm:grid-cols-2">
        {entries.map((entry) => {
          // The server tells us which channels can actually work here, so we
          // never offer a button that is guaranteed to fail.
          const availability = entry.availability ?? { available: true, reason: '' };
          return (
          <li key={entry.type} className="rounded-lg border border-slate-200 p-3">
            <div className="flex items-center gap-2">
              {entry.requiresSignature ? (
                <BoltIcon className="h-4 w-4 text-brand-500" />
              ) : (
                <CheckIcon className="h-4 w-4 text-emerald-500" />
              )}
              <p className="text-sm font-medium text-slate-800">{entry.label}</p>
              {availability.available ? (
                <Badge tone="green">available</Badge>
              ) : (
                <Badge tone="amber">needs setup</Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-500">{entry.description}</p>

            <div className="mt-2 flex flex-wrap gap-1">
              {Object.entries(entry.capabilities ?? {})
                .filter(([, enabled]) => enabled)
                .map(([capability]) => (
                <Badge key={capability} tone="slate">
                  {capability}
                </Badge>
                ))}
            </div>

            {!availability.available && (
              <p className="mt-2 text-xs text-amber-700">{availability.reason}</p>
            )}

            {canManage && availability.available && (
              <Button
                variant="ghost"
                className="mt-2"
                onClick={() => onAdd(entry.type)}
              >
                Connect {entry.label}
              </Button>
            )}
          </li>
          );
        })}
      </ul>
    );
  }
