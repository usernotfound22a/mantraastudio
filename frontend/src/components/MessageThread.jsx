/**
 * Message thread: header, scrollable history, composer and internal notes.
 *
 * Realtime `message:new` events are appended here. When the new message belongs
 * to a different conversation the thread must ignore it, which is why the
 * conversationId is compared rather than trusting the event alone.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useApp } from '../context/AppContext.jsx';
import { sendTyping } from '../lib/realtime.js';
import { CHANNEL_LABELS, dayLabel, clockTime, handoverLabel, truncate, INTENT_LABELS } from '../lib/format.js';
import { Alert, Badge, Button, Card, EmptyState, Skeleton, Textarea, cx } from './ui.jsx';
import { AlertIcon, ChevronIcon, NoteIcon, SendIcon, SparkIcon } from './Icons.jsx';

export default function MessageThread({ conversation, panelOpen, onTogglePanel, onBackToList }) {
  const { can, toast, onRealtime, EVENTS: EV } = useApp();
  const queryClient = useQueryClient();
  const conversationId = conversation.id;

  const messagesKey = ['messages', conversationId];
  const { data, isLoading } = useQuery({
    queryKey: messagesKey,
    queryFn: () => api.get(`/conversations/${conversationId}/messages?limit=50`),
    enabled: Boolean(conversationId),
  });

  const messages = useMemo(() => data?.messages ?? [], [data]);
  const [draft, setDraft] = useState('');
  const [showNotes, setShowNotes] = useState(false);
  const [typingUsers, setTypingUsers] = useState([]);
  const bottomRef = useRef(null);
  const typingTimeout = useRef(null);

  // Append or update a message from the socket, scoped to this thread.
  useEffect(() => {
    const offMessage = onRealtime(EV.MESSAGE_NEW, (payload) => {
      const message = payload?.message;
      if (!message || message.conversationId !== conversationId) return;
      queryClient.setQueryData(messagesKey, (current) => {
        if (!current?.messages) return current;
        if (current.messages.some((m) => m.id === message.id)) return current;
        return { ...current, messages: [...current.messages, message] };
      });
    });

    const offNote = onRealtime(EV.NOTE_CREATED, (payload) => {
      if (payload?.conversationId === conversationId) {
        queryClient.invalidateQueries({ queryKey: ['notes', conversationId] });
      }
    });

    const offTyping = onRealtime(EV.CONVERSATION_TYPING, (payload) => {
      if (payload?.conversationId !== conversationId || !payload.isTyping) return;
      setTypingUsers((current) =>
        current.some((u) => u.userId === payload.userId) ? current : [...current, { userId: payload.userId, name: payload.name }],
      );
      // Clear after a few seconds: a client that crashes mid-typing would
      // otherwise leave a permanent "typing…" row.
      setTimeout(
        () => setTypingUsers((current) => current.filter((u) => u.userId !== payload.userId)),
        4000,
      );
    });

    return () => {
      offMessage();
      offNote();
      offTyping();
    };
  }, [conversationId, messagesKey, onRealtime, queryClient]);

  // Keep the newest message in view.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, showNotes]);

  const send = useMutation({
    mutationFn: (body) => api.post(`/conversations/${conversationId}/messages`, { body }),
    onSuccess: (data) => {
      setDraft('');
      // Insert immediately rather than waiting for the socket round-trip.
      queryClient.setQueryData(messagesKey, (current) => {
        if (!current?.messages || current.messages.some((m) => m.id === data.message.id)) return current;
        return { ...current, messages: [...current.messages, data.message] };
      });
    },
    onError: (error) => toast(error.message ?? 'Message failed to send', 'error'),
  });

  const onDraftChange = (event) => {
    setDraft(event.target.value);
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    sendTyping(conversationId, true);
    typingTimeout.current = setTimeout(() => sendTyping(conversationId, false), 1500);
  };

  const submit = (event) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || send.isPending) return;
    sendTyping(conversationId, false);
    send.mutate(body);
  };

  const updateStatus = async (status) => {
    try {
      await api.patch(`/conversations/${conversationId}/status`, { status });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    } catch (error) {
      toast(error.message ?? 'Could not update the thread', 'error');
    }
  };

  const contact = conversation.contact ?? {};
  const grouped = groupByDay(messages);

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-50">
      {/* ---------------------------------------------------------- Header */}
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2.5 sm:flex-nowrap sm:gap-3 sm:px-4">
        <Button
          size="sm"
          variant="ghost"
          aria-label="Back to conversations"
          onClick={onBackToList}
          className="md:hidden"
        >
          <ChevronIcon className="h-4 w-4 rotate-180" />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-slate-500">
            {CHANNEL_LABELS[conversation.channelType] ?? conversation.channelType}
            {contact.email ? ` · ${contact.email}` : ''}
          </p>
        </div>

        {can('agent', 'admin', 'owner') && (
          <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">
            <Button
              size="sm"
              variant={conversation.status === 'open' ? 'secondary' : 'ghost'}
              onClick={() => updateStatus(conversation.status === 'open' ? 'pending' : 'open')}
            >
              {conversation.status === 'open' ? 'Mark pending' : 'Reopen'}
            </Button>
            {conversation.status !== 'closed' && (
              <Button size="sm" variant="secondary" onClick={() => updateStatus('closed')}>
                Close
              </Button>
            )}
            <Button
              size="sm"
              variant={showNotes ? 'subtle' : 'secondary'}
              onClick={() => setShowNotes((value) => !value)}
              icon={<NoteIcon className="h-4 w-4" />}
            >
              Notes
            </Button>
          </div>
        )}

        <Button size="sm" variant="ghost" onClick={onTogglePanel} className="hidden xl:inline-flex">
          <ChevronIcon className="h-4 w-4" />
        </Button>
      </header>

      {/* Handover banner: the single most important thing to tell an agent. */}
      {conversation.ai?.handover && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2.5">
          <p className="flex items-center gap-2 text-xs font-medium text-amber-900">
            <AlertIcon className="h-4 w-4 shrink-0" />
            {handoverLabel(conversation.ai.handoverReason)}
            {conversation.ai.confidence ? ` · confidence ${Math.round(conversation.ai.confidence * 100)}%` : ''}
          </p>
        </div>
      )}

      {/* --------------------------------------------------------- History */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 scroll-slim">
        {isLoading && (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className={cx('h-12', index % 2 ? 'ml-12' : 'mr-12')} />
            ))}
          </div>
        )}

        {!isLoading && messages.length === 0 && (
          <EmptyState title="No messages yet" description="Messages from this customer will appear here." />
        )}

        {grouped.map(([day, items]) => (
          <div key={day} className="mb-4">
            <div className="mb-2 flex items-center gap-3">
              <span className="h-px flex-1 bg-slate-200" />
              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{day}</span>
              <span className="h-px flex-1 bg-slate-200" />
            </div>
            <div className="space-y-2">
              {items.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))}
            </div>
          </div>
        ))}

        {typingUsers.length > 0 && (
          <p className="flex items-center gap-2 px-1 text-xs text-slate-500">
            <span className="flex gap-1">
              {[0, 1, 2].map((index) => (
                <span
                  key={index}
                  className="h-1.5 w-1.5 animate-bounce-soft rounded-full bg-slate-400"
                  style={{ animationDelay: `${index * 150}ms` }}
                />
              ))}
            </span>
            {typingUsers.map((user) => user.name).join(', ')} {typingUsers.length > 1 ? 'are' : 'is'} typing…
          </p>
        )}

        <div ref={bottomRef} />
      </div>

      {/* -------------------------------------------------------- Composer */}
      {can('agent', 'admin', 'owner') && conversation.status !== 'closed' ? (
        <form onSubmit={submit} className="border-t border-slate-200 bg-white p-3">
          <Textarea
            rows={2}
            value={draft}
            onChange={onDraftChange}
            placeholder="Type a reply…  (Enter to send, Shift+Enter for a new line)"
            className="[&>textarea]:border-0 [&>textarea]:px-0 [&>textarea]:focus:ring-0 [&>textarea]:py-2"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit(event);
              }
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="hidden text-[11px] text-slate-400 sm:block">
              Replies are sent to the customer through the {CHANNEL_LABELS[conversation.channelType]} adapter.
            </span>
            <Button type="submit" size="sm" loading={send.isPending} disabled={!draft.trim()} icon={<SendIcon className="h-4 w-4" />}>
              Send
            </Button>
          </div>
        </form>
      ) : (
        <div className="border-t border-slate-200 bg-white p-3 text-center text-xs text-slate-500">
          {conversation.status === 'closed' ? 'This thread is closed. Reopen it to reply.' : 'You have read-only access.'}
        </div>
      )}

      {/* ------------------------------------------------------------ Notes */}
      {showNotes && <NotePanel conversationId={conversationId} onClose={() => setShowNotes(false)} />}
    </div>
  );
}

function MessageBubble({ message }) {
  const outbound = message.direction === 'outbound';
  const isAi = message.senderType === 'ai';
  const failed = message.status === 'failed';

  return (
    <div className={cx('flex', outbound ? 'justify-end' : 'justify-start')}>
      <div
        className={cx(
          'max-w-[78%] rounded-2xl px-3.5 py-2 shadow-sm',
          outbound
            ? isAi
              ? 'bg-violet-600 text-white'
              : 'bg-brand-600 text-white'
            : 'bg-white text-slate-800',
          failed && 'ring-2 ring-rose-400',
        )}
      >
        {(isAi || message.senderType === 'agent' || message.senderType === 'system') && (
          <p className={cx('mb-1 flex items-center gap-1 text-[11px] font-medium', outbound ? 'text-white/80' : 'text-slate-500')}>
            {isAi && <SparkIcon className="h-3 w-3" />}
            {isAi ? 'Assistant' : message.sender?.name ?? 'Agent'}
          </p>
        )}

        <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>

        {message.attachments?.length > 0 && (
          <ul className="mt-1.5 space-y-1">
            {message.attachments.map((file) => (
              <li key={file.url ?? file.name}>
                <a
                  href={file.url}
                  target="_blank"
                  rel="noreferrer"
                  className={cx(
                    'text-xs underline',
                    outbound ? 'text-white/90' : 'text-brand-700',
                  )}
                >
                  {file.name ?? 'Attachment'}
                </a>
              </li>
            ))}
          </ul>
        )}

        <div className={cx('mt-1 flex items-center gap-2 text-[10px]', outbound ? 'text-white/70' : 'text-slate-400')}>
          <span>{clockTime(message.sentAt)}</span>
          {message.intent && inbound_(message) && <span>{INTENT_LABELS[message.intent] ?? message.intent}</span>}
          {failed && <span className="font-medium">Not delivered</span>}
          {outbound && message.status === 'sent' && <span>Sent</span>}
          {outbound && message.status === 'delivered' && <span>Delivered</span>}
          {outbound && message.status === 'read' && <span>Read</span>}
        </div>
      </div>
    </div>
  );
}

const inbound_ = (message) => message.direction === 'inbound';

/** Groups messages under a day heading, preserving order. */
function groupByDay(messages) {
  const groups = new Map();
  for (const message of messages) {
    const label = dayLabel(message.sentAt);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(message);
  }
  return [...groups.entries()];
}

/** Internal notes, shown as a slide-over panel above the composer. */
function NotePanel({ conversationId, onClose }) {
  const { toast } = useApp();
  const queryClient = useQueryClient();
  const notesKey = ['notes', conversationId];
  const [body, setBody] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: notesKey,
    queryFn: () => api.get(`/conversations/${conversationId}/notes`),
  });

  const create = useMutation({
    mutationFn: () => api.post(`/conversations/${conversationId}/notes`, { body }),
    onSuccess: () => {
      setBody('');
      queryClient.invalidateQueries({ queryKey: notesKey });
    },
    onError: (error) => toast(error.message ?? 'Could not save the note', 'error'),
  });

  const notes = data?.notes ?? [];

  return (
    <div className="border-t border-slate-200 bg-amber-50/60">
      <div className="flex items-center justify-between px-4 py-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
          <NoteIcon className="h-4 w-4" /> Internal notes
          <span className="font-normal text-slate-500">({notes.length})</span>
        </p>
        <button onClick={onClose} className="text-xs text-slate-500 hover:text-slate-800">
          Close
        </button>
      </div>

      <div className="max-h-48 space-y-2 overflow-y-auto px-4 pb-2 scroll-slim">
        {isLoading && <Skeleton className="h-12" />}
        {notes.length === 0 && !isLoading && (
          <p className="py-2 text-xs text-slate-500">No notes yet. Notes are never sent to the customer.</p>
        )}
        {notes.map((note) => (
          <div key={note.id} className="rounded-lg border border-amber-200 bg-white px-3 py-2">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-xs font-medium text-slate-800">{note.author?.name ?? 'Agent'}</p>
              <span className="text-[10px] text-slate-400">{clockTime(note.createdAt)}</span>
            </div>
            <p className="mt-0.5 whitespace-pre-wrap text-xs text-slate-600">{note.body}</p>
          </div>
        ))}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (body.trim()) create.mutate();
        }}
        className="flex gap-2 px-4 pb-3"
      >
        <input
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Add a note for your team…"
          className="field"
        />
        <Button type="submit" size="sm" loading={create.isPending} disabled={!body.trim()}>
          Add
        </Button>
      </form>
    </div>
  );
}
