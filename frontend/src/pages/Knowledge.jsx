/**
 * Knowledge base: the FAQ entries the assistant answers from, plus the list of
 * real customer questions it could not answer.
 *
 * The "Gaps" tab is the important one: it is the only screen that turns AI
 * failures into content, by turning a question into an answer in two clicks.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useApp } from '../context/AppContext.jsx';
import { fullDate, number, percent, relativeTime } from '../lib/format.js';
import { Alert, Badge, Button, Card, EmptyState, Input, Modal, Select, Skeleton, Textarea, cx } from '../components/ui.jsx';
import { FaqIcon, PlusIcon, SearchIcon, TrashIcon } from '../components/Icons.jsx';

const TABS = [
  { id: 'entries', label: 'Entries' },
  { id: 'gaps', label: 'Gaps' },
  { id: 'import', label: 'Import' },
];

export default function Knowledge() {
  const { can, toast, onRealtime, EVENTS: EV, activeWorkspaceId } = useApp();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('entries');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [editing, setEditing] = useState(null);
  const [resolving, setResolving] = useState(null);
  const canManage = can('owner', 'admin');

  const params = new URLSearchParams();
  if (search.trim()) params.set('search', search.trim());
  if (category) params.set('category', category);

  // All three read through the X-Workspace header, so each key carries the
  // active workspace id - otherwise switching tenants shows the old FAQ set.
  const { data, isLoading } = useQuery({
    queryKey: ['faqs', activeWorkspaceId, search, category],
    queryFn: () => api.get(`/faqs?${params.toString()}`),
  });
  const gaps = useQuery({
    queryKey: ['unanswered', activeWorkspaceId],
    queryFn: () => api.get('/faqs/unanswered'),
  });
  const top = useQuery({
    queryKey: ['faqs-top', activeWorkspaceId],
    queryFn: () => api.get('/faqs/top'),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['faqs'] });
    queryClient.invalidateQueries({ queryKey: ['unanswered'] });
    queryClient.invalidateQueries({ queryKey: ['faqs-top'] });
  };

  // The knowledge base is shared: another teammate editing it refreshes here.
  useEffect(() => {
    const offs = [
      onRealtime(EV.FAQ_CREATED, invalidate),
      onRealtime(EV.FAQ_UPDATED, invalidate),
      onRealtime(EV.FAQ_DELETED, invalidate),
    ];
    return () => offs.forEach((off) => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRealtime, EV, queryClient]);

  const faqs = data?.faqs ?? [];
  const categories = data?.categories ?? [];
  const gapCount = gaps.data?.total ?? 0;

  return (
    <div className="h-full overflow-y-auto scroll-slim">
      <div className="mx-auto max-w-4xl space-y-5 p-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
              <FaqIcon className="h-5 w-5 text-brand-600" /> Knowledge base
            </h1>
            <p className="text-sm text-slate-500">
              What the assistant is allowed to answer, and what it still gets wrong.
            </p>
          </div>
          {canManage && (
            <Button icon={<PlusIcon className="h-4 w-4" />} onClick={() => setEditing({})}>
              New entry
            </Button>
          )}
        </header>

        {gapCount > 0 && tab !== 'gaps' && (
          <Alert tone="warning" title={`${gapCount} customer questions could not be answered`}>
            <button onClick={() => setTab('gaps')} className="font-medium underline">
              Review them
            </button>{' '}
            and add answers, so the same question never fails twice.
          </Alert>
        )}

        <div className="flex gap-1 border-b border-slate-200">
          {TABS.map((item) => (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              className={cx(
                '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                tab === item.id
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700',
              )}
            >
              {item.label}
              {item.id === 'gaps' && gapCount > 0 && (
                <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">
                  {gapCount}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ------------------------------------------------------- Entries */}
        {tab === 'entries' && (
          <>
            <div className="flex flex-wrap gap-2">
              <div className="relative min-w-56 flex-1">
                <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search questions and answers"
                  className="field pl-9"
                />
              </div>
              {categories.length > 0 && (
                <Select value={category} onChange={(event) => setCategory(event.target.value)} className="w-48">
                  <option value="">All categories</option>
                  {categories.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </Select>
              )}
            </div>

            {isLoading && (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-16" />
                ))}
              </div>
            )}

            {!isLoading && faqs.length === 0 && (
              <EmptyState
                icon={<FaqIcon className="h-9 w-9" />}
                title={search ? 'Nothing matched' : 'No knowledge base entries yet'}
                description={
                  search
                    ? 'Try a different word, or clear the category filter.'
                    : 'Without entries the assistant can only greet and escalate. Add your ten most common questions to start.'
                }
              />
            )}

            <ul className="space-y-2">
              {faqs.map((faq) => (
                <FaqCard key={faq.id} faq={faq} canManage={canManage} onEdit={() => setEditing(faq)} onChanged={invalidate} />
              ))}
            </ul>
          </>
        )}

        {/* ---------------------------------------------------------- Gaps */}
        {tab === 'gaps' && (
          <>
            <p className="text-sm text-slate-500">
              Real questions customers asked that the assistant could not answer. Answering one creates
              the FAQ entry for you.
            </p>

            {gaps.isLoading && <Skeleton className="h-32" />}

            {gaps.data?.questions?.length === 0 && (
              <EmptyState
                icon={<FaqIcon className="h-9 w-9" />}
                title="No gaps recorded"
                description="Either the assistant is answering everything, or no conversation has asked anything it did not know yet."
              />
            )}

            <ul className="space-y-2">
              {gaps.data?.questions?.map((gap) => (
                <li key={gap.id} className="card flex flex-wrap items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-800">{gap.question}</p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      asked {gap.occurrences === 1 ? 'once' : `${gap.occurrences} times`} · last{' '}
                      {relativeTime(gap.lastAskedAt)}
                    </p>
                  </div>
                  {canManage && (
                    <Button size="sm" onClick={() => setResolving(gap)}>
                      Add answer
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {/* -------------------------------------------------------- Import */}
        {tab === 'import' && <ImportPanel onDone={invalidate} canManage={canManage} />}

        {/* ---------------------------------------------------- Health bits */}
        {tab === 'entries' && top.data && !isLoading && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Card title="Most used">
              {top.data.mostUsed.length === 0 ? (
                <p className="text-xs text-slate-500">No matches recorded yet.</p>
              ) : (
                <ol className="space-y-1.5">
                  {top.data.mostUsed.slice(0, 5).map((faq, index) => (
                    <li key={faq.id} className="flex items-baseline gap-2 text-xs">
                      <span className="w-4 shrink-0 text-slate-400">{index + 1}</span>
                      <span className="min-w-0 flex-1 truncate text-slate-700">{faq.question}</span>
                      <span className="shrink-0 tabular-nums text-slate-500">{number(faq.match_count)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
            <Card title="Never matched" description="Dead weight, or a wording problem.">
              {top.data.neverMatched.length === 0 ? (
                <p className="text-xs text-slate-500">Every entry has been used at least once.</p>
              ) : (
                <ul className="space-y-1.5">
                  {top.data.neverMatched.map((faq) => (
                    <li key={faq.id} className="truncate text-xs text-slate-600">
                      {faq.question}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}
      </div>

      {editing && (
        <FaqEditor
          faq={editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            invalidate();
          }}
        />
      )}

      {resolving && (
        <GapResolver
          gap={resolving}
          onClose={() => setResolving(null)}
          onDone={() => {
            setResolving(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function FaqCard({ faq, canManage, onEdit, onChanged }) {
  const { toast } = useApp();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const remove = useMutation({
    mutationFn: () => api.delete(`/faqs/${faq.id}`),
    onSuccess: (data) => {
      toast(data?.archived ? 'Archived (it is referenced by past conversations)' : 'Entry deleted', 'success');
      onChanged();
    },
    onError: (error) => toast(error.message ?? 'Could not delete the entry', 'error'),
  });

  const archive = useMutation({
    mutationFn: (isActive) => api.patch(`/faqs/${faq.id}`, { isActive }),
    onSuccess: onChanged,
    onError: (error) => toast(error.message ?? 'Could not update the entry', 'error'),
  });

  const reset = useMutation({
    mutationFn: () => api.post(`/faqs/${faq.id}/reset-stats`, {}),
    onSuccess: () => {
      toast('Usage counters reset', 'success');
      onChanged();
    },
  });

  const total = (faq.matchCount ?? 0) + (faq.noMatchCount ?? 0);
  const hitRate = total ? (faq.matchCount / total) * 100 : null;

  return (
    <li className={cx('card p-3', !faq.isActive && 'opacity-60')}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-slate-900">{faq.question}</p>
          <p className="mt-1 line-clamp-2 text-xs text-slate-500">{faq.answer}</p>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {faq.category && <Badge tone="brand">{faq.category}</Badge>}
            {faq.source && <Badge tone="slate">{faq.source}</Badge>}
            {!faq.isActive && <Badge tone="amber">archived</Badge>}
            {faq.keywords?.slice(0, 4).map((keyword) => (
              <span key={keyword} className="text-[11px] text-slate-400">
                #{keyword}
              </span>
            ))}
          </div>
        </div>

        <div className="w-28 shrink-0 text-right">
          <p className="text-sm font-semibold tabular-nums text-slate-800">{number(faq.matchCount)}</p>
          <p className="text-[11px] text-slate-500">matched</p>
          {hitRate !== null && (
            <p className="mt-1 text-[11px] text-slate-400">{percent(hitRate)} hit rate</p>
          )}
          {faq.lastMatchedAt && (
            <p className="text-[10px] text-slate-400">last {relativeTime(faq.lastMatchedAt)}</p>
          )}
        </div>

        {canManage && (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={onEdit}>
              Edit
            </Button>
            {confirming ? (
              <>
                <Button size="sm" variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
                  Delete
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  No
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} title="Delete entry">
                <TrashIcon className="h-4 w-4" />
              </Button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function FaqEditor({ faq, onClose, onDone }) {
  const { toast } = useApp();
  const editing = Boolean(faq.id);
  const [form, setForm] = useState({
    question: faq.question ?? '',
    answer: faq.answer ?? '',
    category: faq.category ?? '',
    keywords: (faq.keywords ?? []).join(', '),
  });

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        question: form.question.trim(),
        answer: form.answer.trim(),
        category: form.category.trim() || undefined,
        keywords: form.keywords
          .split(',')
          .map((word) => word.trim())
          .filter(Boolean),
      };
      return editing ? api.patch(`/faqs/${faq.id}`, payload) : api.post('/faqs', payload);
    },
    onSuccess: () => {
      toast(editing ? 'Entry updated' : 'Entry created', 'success');
      onDone();
    },
    onError: (error) => toast(error.message ?? 'Could not save the entry', 'error'),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? 'Edit entry' : 'New knowledge base entry'}
      description="Write the answer the way you would say it. The assistant reuses it almost verbatim."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={save.isPending}
            disabled={form.question.trim().length < 3 || !form.answer.trim()}
            onClick={() => save.mutate()}
          >
            {editing ? 'Save changes' : 'Create entry'}
          </Button>
        </>
      }
    >
      <Input
        label="Question"
        value={form.question}
        onChange={set('question')}
        placeholder="How do I reset my password?"
        hint="Phrase it the way a customer would ask it."
      />
      <Textarea
        label="Answer"
        rows={6}
        value={form.answer}
        onChange={set('answer')}
        className="mt-3"
        placeholder="Open Settings, choose Security, then Reset password. We email a link that is valid for one hour."
      />
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Input label="Category" value={form.category} onChange={set('category')} placeholder="Billing" />
        <Input
          label="Keywords"
          value={form.keywords}
          onChange={set('keywords')}
          placeholder="password, login, locked out"
          hint="Comma separated. Extra words the retriever should match on."
        />
      </div>
    </Modal>
  );
}

function GapResolver({ gap, onClose, onDone }) {
  const { toast } = useApp();
  const [answer, setAnswer] = useState('');
  const [category, setCategory] = useState('');

  const resolve = useMutation({
    mutationFn: () =>
      api.post(`/faqs/unanswered/${gap.id}/resolve`, {
        answer: answer.trim(),
        category: category.trim() || undefined,
      }),
    onSuccess: () => {
      toast('Added to the knowledge base', 'success');
      onDone();
    },
    onError: (error) => toast(error.message ?? 'Could not add the answer', 'error'),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Answer this question"
      description="This creates a knowledge base entry and clears the gap."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={resolve.isPending} disabled={!answer.trim()} onClick={() => resolve.mutate()}>
            Add to knowledge base
          </Button>
        </>
      }
    >
      <p className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-sm font-medium text-slate-800">
        {gap.question}
      </p>
      <p className="mb-3 text-xs text-slate-500">
        Asked {gap.occurrences === 1 ? 'once' : `${gap.occurrences} times`}, first {fullDate(gap.firstAskedAt)}.
      </p>
      <Textarea
        label="The answer"
        rows={6}
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        placeholder="Type the answer you would give to a customer."
      />
      <Input
        label="Category"
        value={category}
        onChange={(event) => setCategory(event.target.value)}
        placeholder="General"
        className="mt-3"
      />
    </Modal>
  );
}

function ImportPanel({ onDone, canManage }) {
  const { toast } = useApp();
  const [csv, setCsv] = useState('');

  const run = useMutation({
    mutationFn: () => api.post('/faqs/import', { format: 'csv', csv }),
    onSuccess: (data) => {
      if (data.failed === 0) {
        toast(`Imported ${data.imported} entries`, 'success');
        setCsv('');
        onDone();
      } else {
        toast(`Imported ${data.imported}, ${data.failed} rows failed`, 'warning');
        onDone();
      }
    },
    onError: (error) => toast(error.message ?? 'Import failed', 'error'),
  });

  const sample = `question,answer,keywords,category
How do I reset my password?,Open Settings then Security then Reset password.,password login,Billing
Do you offer refunds?,Yes within 30 days. Email billing@socialhub.test.,refund money,Billing`;

  return (
    <div className="space-y-4">
      <Alert tone="info" title="CSV format">
        Header row required: <code>question</code> and <code>answer</code> are mandatory;{' '}
        <code>keywords</code> (pipe separated) and <code>category</code> are optional. Rows are imported
        individually, so one typo does not lose the rest.
      </Alert>

      <Textarea
        rows={10}
        value={csv}
        onChange={(event) => setCsv(event.target.value)}
        placeholder={sample}
        className="font-mono text-xs"
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          loading={run.isPending}
          disabled={!csv.trim() || !canManage}
          onClick={() => run.mutate()}
        >
          Import
        </Button>
        <Button variant="ghost" onClick={() => setCsv(sample)}>
          Fill with an example
        </Button>
        {!canManage && <span className="text-xs text-slate-500">Only owners and admins can import.</span>}
      </div>
    </div>
  );
}
