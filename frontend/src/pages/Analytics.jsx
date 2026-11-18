/**
 * Analytics dashboard.
 *
 * Deliberately dependency-free charts: a sparkline and bar rows drawn with
 * plain divs. A charting library would add hundreds of kilobytes for four
 * simple views, and hand-rolled bars are easier to label precisely.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useApp } from '../context/AppContext.jsx';
import { CHANNEL_LABELS, HANDOVER_LABELS, INTENT_LABELS, duration, number, percent } from '../lib/format.js';
import { Badge, Card, EmptyState, Skeleton, cx } from '../components/ui.jsx';
import { ChartIcon, SparkIcon } from '../components/Icons.jsx';

const RANGES = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
];

export default function Analytics() {
  const { activeWorkspaceId } = useApp();
  const [range, setRange] = useState('30d');

  const overview = useQuery({
    queryKey: ['analytics-overview', activeWorkspaceId, range],
    queryFn: () => api.get(`/analytics/overview?range=${range}`),
    enabled: Boolean(activeWorkspaceId),
  });

  const ai = useQuery({
    queryKey: ['analytics-ai', activeWorkspaceId, range],
    queryFn: () => api.get(`/analytics/ai?range=${range}`),
    enabled: Boolean(activeWorkspaceId),
  });

  const faqs = useQuery({
    queryKey: ['analytics-faqs', activeWorkspaceId],
    queryFn: () => api.get('/analytics/faqs'),
    enabled: Boolean(activeWorkspaceId),
  });

  const summary = overview.data?.summary;
  const daily = overview.data?.daily ?? [];
  const channels = overview.data?.channels ?? [];
  const aiStats = ai.data;
  const faqRows = faqs.data?.faqs ?? [];

  return (
    <div className="h-full overflow-y-auto scroll-slim">
      <div className="mx-auto max-w-6xl space-y-5 p-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Analytics</h1>
            <p className="text-sm text-slate-500">How the inbox and the assistant are performing.</p>
          </div>
          <div className="flex gap-1">
            {RANGES.map((item) => (
              <button
                key={item.id}
                onClick={() => setRange(item.id)}
                className={cx(
                  'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                  range === item.id ? 'bg-brand-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-100',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </header>

        {/* ------------------------------------------------- Headline cards */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat
            label="Conversations"
            value={summary ? number(summary.conversations) : null}
            trend={summary?.conversationTrend}
            loading={overview.isLoading}
          />
          <Stat
            label="AI resolution rate"
            value={summary ? percent(summary.aiResolutionRate, 1) : null}
            hint="Closed without a human"
            tone="violet"
            loading={overview.isLoading}
          />
          <Stat
            label="Avg first response"
            value={summary ? duration(summary.avgFirstResponseSeconds) : null}
            loading={overview.isLoading}
          />
          <Stat
            label="Customer rating"
            value={summary?.satisfaction?.avgRating ? `${summary.satisfaction.avgRating} / 5` : '—'}
            hint={summary?.satisfaction?.rated ? `${summary.satisfaction.rated} ratings` : 'No ratings yet'}
            loading={overview.isLoading}
          />
        </div>

        {/* ------------------------------------------------------- Volume */}
        <Card title="Conversation volume" description="New threads per day, and how many the assistant handled.">
          {overview.isLoading ? (
            <Skeleton className="h-40" />
          ) : daily.length === 0 ? (
            <EmptyState
              icon={<ChartIcon className="h-8 w-8" />}
              title="No conversations in this period"
              description="Pick a longer range, or connect a channel to start collecting data."
            />
          ) : (
            <BarChart data={daily} />
          )}
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          {/* ------------------------------------------------ Channels */}
          <Card title="By channel" description="Volume and response time per channel.">
            {channels.length === 0 ? (
              <p className="py-6 text-center text-xs text-slate-500">No channel data yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                    <th className="pb-2 font-medium">Channel</th>
                    <th className="pb-2 text-right font-medium">Threads</th>
                    <th className="pb-2 text-right font-medium">AI answered</th>
                    <th className="pb-2 text-right font-medium">First reply</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {channels.map((row) => (
                    <tr key={row.channel}>
                      <td className="py-2.5">
                        <Badge tone="brand">{CHANNEL_LABELS[row.channel] ?? row.channel}</Badge>
                      </td>
                      <td className="py-2.5 text-right tabular-nums text-slate-700">{number(row.conversations)}</td>
                      <td className="py-2.5 text-right tabular-nums text-violet-700">{number(row.aiResolved)}</td>
                      <td className="py-2.5 text-right tabular-nums text-slate-700">{duration(row.avgFirstResponse)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          {/* ------------------------------------------------------- AI */}
          <Card title="Assistant" description="Where it helped, and where it stood down.">
            {ai.isLoading ? (
              <Skeleton className="h-40" />
            ) : !aiStats || aiStats.aiMessages + aiStats.handovers === 0 ? (
              <p className="py-6 text-center text-xs text-slate-500">The assistant has not been active yet.</p>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3 text-center">
                  <Mini label="Replies" value={number(aiStats.aiMessages)} />
                  <Mini label="Handovers" value={number(aiStats.handovers)} tone="amber" />
                  <Mini label="Avg confidence" value={aiStats.avgConfidence ? `${Math.round(aiStats.avgConfidence * 100)}%` : '—'} />
                </div>

                <div>
                  <p className="mb-1.5 text-xs font-medium text-slate-600">Why it stepped aside</p>
                  <div className="space-y-1.5">
                    {aiStats.handoverReasons.map((row) => (
                      <div key={row.reason} className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate text-slate-600">
                          {HANDOVER_LABELS[row.reason] ?? row.reason}
                        </span>
                        <span className="shrink-0 tabular-nums font-medium text-slate-800">{row.count}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="mb-1.5 text-xs font-medium text-slate-600">What customers asked about</p>
                  <div className="flex flex-wrap gap-1.5">
                    {aiStats.topIntents.map((row) => (
                      <Badge key={row.intent} tone="slate">
                        {INTENT_LABELS[row.intent] ?? row.intent} · {row.count}
                      </Badge>
                    ))}
                  </div>
                </div>

                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  {number(aiStats.knowledgeGaps.distinctQuestions)} questions could not be answered
                  ({number(aiStats.knowledgeGaps.totalAsked)} asked). Add them to the knowledge base to raise the
                  resolution rate.
                </p>
              </div>
            )}
          </Card>
        </div>

        {/* --------------------------------------------------- FAQ table */}
        <Card
          title="Knowledge base effectiveness"
          description="How often each entry is used, and how often it almost was."
        >
          {faqs.isLoading ? (
            <Skeleton className="h-32" />
          ) : faqRows.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-500">No FAQ entries yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="pb-2 font-medium">Question</th>
                  <th className="pb-2 text-right font-medium">Used</th>
                  <th className="pb-2 text-right font-medium">Near miss</th>
                  <th className="pb-2 text-right font-medium">Hit rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {faqRows.map((row) => (
                  <tr key={row.id}>
                    <td className="max-w-md truncate py-2.5 text-slate-700">{row.question}</td>
                    <td className="py-2.5 text-right tabular-nums text-slate-700">{number(row.matchCount)}</td>
                    <td className="py-2.5 text-right tabular-nums text-amber-700">{number(row.noMatchCount)}</td>
                    <td className="py-2.5 text-right tabular-nums text-slate-700">
                      {row.hitRate === null ? '—' : percent(row.hitRate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, hint, trend, tone = 'slate', loading }) {
  return (
    <div className="card p-4">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-20" />
      ) : (
        <p
          className={cx(
            'mt-1 text-2xl font-semibold tabular-nums',
            tone === 'violet' ? 'text-violet-700' : 'text-slate-900',
          )}
        >
          {value ?? '—'}
        </p>
      )}
      {(hint || trend !== null && trend !== undefined) && (
        <p className="mt-1 text-[11px] text-slate-500">
          {trend !== null && trend !== undefined && (
            <span className={trend >= 0 ? 'font-medium text-emerald-600' : 'font-medium text-rose-600'}>
              {trend >= 0 ? '+' : ''}
              {trend}%
            </span>
          )}
          {trend !== null && trend !== undefined && hint ? ' · ' : ''}
          {hint}
        </p>
      )}
    </div>
  );
}

function Mini({ label, value, tone = 'slate' }) {
  return (
    <div className="rounded-lg bg-slate-50 px-2 py-2.5">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className={cx('mt-0.5 text-base font-semibold tabular-nums', tone === 'amber' ? 'text-amber-700' : 'text-slate-900')}>
        {value}
      </p>
    </div>
  );
}

/** Stacked bars: total threads, split into AI-answered vs needing a human. */
function BarChart({ data }) {
  const max = Math.max(...data.map((row) => row.conversations), 1);
  return (
    <div className="overflow-x-auto scroll-slim">
      <div className="flex min-w-full items-end gap-1.5" style={{ height: 160 }}>
        {data.map((row) => {
          const height = (row.conversations / max) * 140;
          const aiShare = row.conversations ? (row.aiResolved / row.conversations) * 100 : 0;
          return (
            <div key={row.day} className="group relative flex flex-1 flex-col justify-end" title={`${row.day}: ${row.conversations} threads, ${row.aiResolved} AI answered`}>
              <div
                className="flex flex-col overflow-hidden rounded-t bg-brand-600"
                style={{ height: Math.max(height, 3) }}
              >
                <div className="w-full bg-violet-500" style={{ height: `${aiShare}%` }} />
              </div>
              <div className="mt-1 hidden text-center text-[9px] text-slate-400 group-hover:block">
                {String(row.day).slice(5)}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex items-center gap-4 text-[11px] text-slate-500">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-brand-600" /> Needed a human
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-violet-500" /> Answered by the assistant
        </span>
      </div>
    </div>
  );
}
