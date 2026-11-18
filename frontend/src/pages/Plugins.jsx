import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useApp } from '../context/AppContext.jsx';
import { Alert, Badge, Card, EmptyState, Skeleton } from '../components/ui.jsx';
import { BoltIcon, ChannelsIcon, PluginIcon, SparkIcon } from '../components/Icons.jsx';

/**
 * Plugins inventory (read-only).
 *
 * There is intentionally no install button: a plugin is code, so it is added by
 * dropping a folder or file into the project and restarting the server. This
 * page answers the questions that actually matter at runtime - what did the
 * server load, which provider is live, in what order do the AI behaviours run,
 * and what is still missing before a plugin can be used.
 */
export default function Plugins() {
  const { activeWorkspaceId } = useApp();

  const { data, isLoading } = useQuery({
    queryKey: ['plugins', activeWorkspaceId],
    queryFn: () => api.get('/plugins'),
    enabled: Boolean(activeWorkspaceId),
  });

  if (isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="h-64" />
      </div>
    );
  }

  const channels = data?.channels ?? [];
  const ai = data?.ai ?? { providers: [], behaviours: [] };

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Plugins</h1>
        <p className="text-sm text-slate-500">
          Channel adapters, AI providers and AI behaviours loaded in this server.
        </p>
      </div>

      <Alert tone="info" title="How to add one">
        Channel adapter: drop a folder in{' '}
        <code className="rounded bg-slate-100 px-1">backend/plugins/</code> with{' '}
        <code className="rounded bg-slate-100 px-1">manifest.json</code> and an{' '}
        <code className="rounded bg-slate-100 px-1">index.js</code>. AI provider or behaviour: add
        a file exporting <code className="rounded bg-slate-100 px-1">manifest</code> in{' '}
        <code className="rounded bg-slate-100 px-1">src/plugins/ai.providers/</code> or{' '}
        <code className="rounded bg-slate-100 px-1">src/plugins/ai.behaviours/</code>. Then restart
        the server.
      </Alert>

      {/* --- channel adapters ------------------------------------------- */}
      <Card
        title="Channel adapters"
        description="Each one knows how to verify, parse and send for one platform."
        actions={<Badge tone="brand">{channels.length} loaded</Badge>}
      >
        {channels.length === 0 ? (
          <EmptyState
            icon={<ChannelsIcon className="h-6 w-6" />}
            title="No channel adapters"
            description="No adapter was registered at boot."
          />
        ) : (
          <div className="space-y-2">
            {channels.map((channel) => (
              <div
                key={channel.type}
                className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-slate-200 p-3"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-slate-900">{channel.label}</p>
                    <span className="font-mono text-xs text-slate-400">{channel.type}</span>
                    {channel.version && <Badge tone="slate">v{channel.version}</Badge>}
                    {channel.vendor && <Badge tone="violet">{channel.vendor}</Badge>}
                  </div>

                  {channel.description && (
                    <p className="text-sm text-slate-500">{channel.description}</p>
                  )}

                  {typeof channel.capabilities === 'object' && channel.capabilities && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {Object.entries(channel.capabilities)
                        .filter(([, enabled]) => enabled)
                        .map(([capability]) => (
                          <Badge key={capability} tone="slate">
                            {capability}
                          </Badge>
                        ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* --- AI providers ------------------------------------------------ */}
      <Card
        title="AI providers"
        description="Only one is active at a time, chosen with AI_PROVIDER."
        actions={<Badge tone="brand">active: {ai.activeProviderLabel}</Badge>}
      >
        <div className="space-y-2">
          {ai.providers.map((provider) => (
            <div
              key={provider.id}
              className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-slate-200 p-3"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-slate-900">{provider.label}</p>
                  <span className="font-mono text-xs text-slate-400">{provider.id}</span>
                  {provider.active && <Badge tone="green">active</Badge>}
                </div>
                {provider.description && (
                  <p className="text-sm text-slate-500">{provider.description}</p>
                )}
                {!provider.availability.available && (
                  <p className="text-xs text-amber-700">{provider.availability.reason}</p>
                )}
              </div>

              <div className="flex items-center gap-2">
                {provider.requiresKey && (
                  <Badge tone={provider.availability.available ? 'green' : 'slate'}>
                    <BoltIcon className="h-3 w-3" />
                    {provider.envKey}
                  </Badge>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* --- AI behaviours ----------------------------------------------- */}
      <Card
        title="AI behaviour pipeline"
        description="Runs in this order for every inbound message. A stage that throws is skipped."
        actions={<Badge tone="brand">{ai.behaviours.length} stages</Badge>}
      >
        {ai.behaviours.length === 0 ? (
          <EmptyState
            icon={<PluginIcon className="h-6 w-6" />}
            title="No behaviour stages"
            description="Intent detection and escalation will not run."
          />
        ) : (
          <ol className="space-y-2">
            {ai.behaviours.map((behaviour, index) => (
              <li
                key={behaviour.id}
                className="flex items-start gap-3 rounded-lg border border-slate-200 p-3"
              >
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">
                  {index + 1}
                </span>
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-slate-900">{behaviour.label}</p>
                    <span className="font-mono text-xs text-slate-400">{behaviour.id}</span>
                    <Badge tone="slate">order {behaviour.order}</Badge>
                  </div>
                  {behaviour.description && (
                    <p className="text-sm text-slate-500">{behaviour.description}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {data?.externalDir && (
        <p className="text-xs text-slate-400">
          External plugin directory: <code>{data.externalDir}</code>
        </p>
      )}

      <p className="flex items-center gap-2 text-xs text-slate-400">
        <SparkIcon className="h-3 w-3" />
        Plugins are loaded once at boot; restart the server after adding one.
      </p>
    </div>
  );
}
