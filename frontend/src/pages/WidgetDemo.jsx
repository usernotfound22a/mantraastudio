/**
 * Widget preview: the real widget script, inside an iframe that pretends to be
 * the customer's website.
 *
 * An iframe rather than a div, because the widget positions itself with
 * `position: fixed` and reads `document.referrer`. Loading it inline would make
 * it share the dashboard's DOM, styles and origin - the exact conditions under
 * which an embed bug hides.
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useApp } from '../context/AppContext.jsx';
import { Alert, Button, Card, cx } from '../components/ui.jsx';
import { CopyIcon, ExternalIcon } from '../components/Icons.jsx';

export default function WidgetDemo() {
  const { activeWorkspaceId, toast } = useApp();
  const [searchParams] = useSearchParams();
  const [device, setDevice] = useState('desktop');

  const { data, isLoading } = useQuery({
    queryKey: ['channels', activeWorkspaceId],
    queryFn: () => api.get('/channels'),
  });

  const website = data?.channels?.find((channel) => channel.type === 'website');
  const key = searchParams.get('key') ?? website?.config?.widgetKey;

  const apiBase = useMemo(() => {
    if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL;
    return 'http://localhost:4000/api';
  }, []);

  // The harness page is served BY the API (it sits next to socialhub.js), so the
  // preview talks to the same origin a real customer would.
  const widgetOrigin = apiBase.replace(/\/api\/?$/, '');
  const src = useMemo(() => {
    if (!key) return null;
    return `${widgetOrigin}/widget/index.html?key=${encodeURIComponent(key)}&api=${encodeURIComponent(apiBase)}&v=${Date.now()}`;
  }, [key, apiBase, widgetOrigin]);

  const snippet = key
    ? `<script src="${widgetOrigin}/widget/socialhub.js" data-key="${key}"></script>`
    : null;

  return (
    <div className="h-full overflow-y-auto bg-slate-100 scroll-slim">
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <header>
          <h1 className="text-lg font-semibold text-slate-900">Website widget</h1>
          <p className="text-sm text-slate-500">
            The exact script a customer embeds, running as a visitor would see it.
          </p>
        </header>

        {!isLoading && !website && (
          <Alert tone="warning" title="No website channel yet">
            Create one in{' '}
            <a href="/settings/channels" className="font-medium underline">
              Settings &rarr; Channels
            </a>{' '}
            to get a widget key.
          </Alert>
        )}

        {snippet && (
          <Card title="Embed snippet" description="Paste this before the closing </body> tag.">
            <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100 scroll-slim">
              {snippet}
            </pre>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                icon={<CopyIcon className="h-3.5 w-3.5" />}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(snippet);
                    toast('Snippet copied', 'success');
                  } catch {
                    toast('Copy failed - select the text manually', 'error');
                  }
                }}
              >
                Copy snippet
              </Button>
              <a href={`${widgetOrigin}/widget/index.html?key=${key}`} target="_blank" rel="noreferrer">
                <Button size="sm" variant="ghost" icon={<ExternalIcon className="h-3.5 w-3.5" />}>
                  Open in a new tab
                </Button>
              </a>
            </div>
          </Card>
        )}

        <Card
          title="Preview"
          description="This iframe is the real widget, not a mock-up."
          actions={
            <div className="flex gap-1">
              {['desktop', 'mobile'].map((option) => (
                <button
                  key={option}
                  onClick={() => setDevice(option)}
                  className={cx(
                    'rounded-lg px-2.5 py-1 text-xs font-medium capitalize',
                    device === option ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600',
                  )}
                >
                  {option}
                </button>
              ))}
            </div>
          }
        >
          {!src ? (
            <p className="py-10 text-center text-sm text-slate-500">No widget key to preview.</p>
          ) : (
            <div className="flex justify-center">
              <iframe
                title="Widget preview"
                src={src}
                className={cx(
                  'h-[560px] rounded-xl border border-slate-300 bg-white',
                  device === 'mobile' ? 'w-[390px]' : 'w-full',
                )}
              />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
