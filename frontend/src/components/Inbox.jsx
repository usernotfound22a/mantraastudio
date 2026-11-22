/**
 * Inbox: the three-pane layout.
 *
 *   list  ->  thread  ->  customer panel
 *
 * The list is the source of truth for the sidebar. Realtime events patch it in
 * place (a new message re-sorts the row) rather than triggering a refetch, so
 * typing in the thread never makes the list flicker.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useApp } from '../context/AppContext.jsx';
import { watchConversation, unwatchConversation } from '../lib/realtime.js';
import { CHANNEL_LABELS, handoverLabel, relativeTime, truncate } from '../lib/format.js';
import { Badge, Button, EmptyState, Skeleton, cx } from './ui.jsx';
import { AlertIcon, InboxIcon, SearchIcon, SparkIcon } from './Icons.jsx';
import MessageThread from './MessageThread.jsx';
import CustomerPanel from './CustomerPanel.jsx';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'pending', label: 'Pending' },
  { id: 'unassigned', label: 'Unassigned' },
  { id: 'unread', label: 'Unread' },
];

export default function Inbox() {
  const { activeWorkspaceId, onRealtime, EVENTS: EV } = useApp();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [showPanel, setShowPanel] = useState(true);
  const [mobileThreadOpen, setMobileThreadOpen] = useState(false);

  const params = useMemo(() => {
    const query = new URLSearchParams({ limit: '50' });
    if (filter === 'unassigned') query.set('assigneeId', 'unassigned');
    else if (filter === 'unread') query.set('unreadOnly', 'true');
    else if (filter !== 'all') query.set('status', filter);
    if (search.trim()) query.set('search', search.trim());
    return query.toString();
  }, [filter, search]);

  const listKey = ['conversations', activeWorkspaceId, params];

  const { data, isLoading, isError, error } = useQuery({
    queryKey: listKey,
    queryFn: () => api.get(`/conversations?${params}`),
    enabled: Boolean(activeWorkspaceId),
  });

  const conversations = useMemo(() => data?.conversations ?? [], [data]);

  /*
    Realtime patching.
    Events carry the changed conversation, so the cache is updated directly.
    A full refetch is only needed when an event arrives for something outside
    the current filter (e.g. a new thread while the list is filtered to
    "unread"), which is handled by invalidating instead of inserting.
  */
  useEffect(() => {
    if (!activeWorkspaceId) return undefined;

    const patchOrInvalidate = (payload) => {
      const incoming = payload?.conversation;
      queryClient.setQueryData(listKey, (current) => {
        if (!current?.conversations) return current;
        const exists = current.conversations.some((c) => c.id === incoming?.id);
        if (!exists) {
          // Not in the current view (wrong filter/page): let the query refetch
          // rather than injecting a row that may not belong here.
          queryClient.invalidateQueries({ queryKey: ['conversations', activeWorkspaceId] });
          return current;
        }
        return {
          ...current,
          conversations: current.conversations.map((c) =>
            c.id === incoming.id ? { ...c, ...incoming } : c,
          ),
        };
      });
    };

    const offs = [
      onRealtime(EV.CONVERSATION_UPSERTED, (payload) => {
        if (payload?.conversation) {
          queryClient.setQueryData(listKey, (current) => {
            if (!current?.conversations) return current;
            if (current.conversations.some((c) => c.id === payload.conversation.id)) return current;
            return { ...current, conversations: [payload.conversation, ...current.conversations] };
          });
        } else {
          queryClient.invalidateQueries({ queryKey: ['conversations', activeWorkspaceId] });
        }
      }),
      onRealtime(EV.CONVERSATION_UPDATED, patchOrInvalidate),
      onRealtime(EV.CONVERSATION_ASSIGNED, patchOrInvalidate),
      onRealtime(EV.MESSAGE_NEW, (payload) => {
        const conversationId = payload?.message?.conversationId;
        if (!conversationId) return;
        queryClient.setQueryData(listKey, (current) => {
          if (!current?.conversations) return current;
          return {
            ...current,
            conversations: current.conversations.map((c) =>
              c.id === conversationId
                ? {
                    ...c,
                    lastMessageAt: payload.message.sentAt,
                    lastMessagePreview: truncate(payload.message.body),
                    lastMessageDirection: payload.message.direction,
                    unreadCount:
                      payload.message.direction === 'inbound' ? (c.unreadCount ?? 0) + 1 : c.unreadCount,
                  }
                : c,
            ),
          };
        });
      }),
      // The AI stepping aside is a real-time event; the customer panel shows
      // the reason immediately.
      onRealtime(EV.CONVERSATION_HANDOVER, (payload) => {
        if (payload?.conversationId) {
          queryClient.invalidateQueries({ queryKey: ['conversation', payload.conversationId] });
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [activeWorkspaceId, onRealtime, listKey, queryClient]);

  // Keep a selection as the list changes; open the first thread on desktop.
  useEffect(() => {
    if (conversations.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!conversations.some((c) => c.id === selectedId)) {
      setSelectedId(conversations[0].id);
    }
  }, [conversations, selectedId]);

  // Mark the open thread as read so the badge does not linger.
  const markRead = useCallback(
    (conversationId) => {
      if (!conversationId || !activeWorkspaceId) return;
      api.post(`/conversations/${conversationId}/read`, {}).catch(() => {});
      queryClient.setQueryData(listKey, (current) => {
        if (!current?.conversations) return current;
        return {
          ...current,
          conversations: current.conversations.map((c) =>
            c.id === conversationId ? { ...c, unreadCount: 0 } : c,
          ),
        };
      });
    },
    [activeWorkspaceId, listKey, queryClient],
  );

  useEffect(() => {
    if (selectedId) markRead(selectedId);
  }, [selectedId, markRead]);

  // Join/leave the thread room so typing indicators and focused updates arrive.
  useEffect(() => {
    if (!selectedId) return undefined;
    watchConversation(selectedId);
    return () => unwatchConversation(selectedId);
  }, [selectedId]);

  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="flex h-full min-h-0">
      {/* ------------------------------------------------------------ List */}
      <div className={cx(
        'w-full max-w-none shrink-0 flex-col border-r border-slate-200 bg-white md:flex md:w-96 md:max-w-sm',
        mobileThreadOpen ? 'hidden md:flex' : 'flex',
      )}>
        <div className="border-b border-slate-200 p-3">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search conversations"
              className="field pl-9"
            />
          </div>

          <div className="mt-3 flex gap-1 overflow-x-auto">
            {FILTERS.map((item) => (
              <button
                key={item.id}
                onClick={() => setFilter(item.id)}
                className={cx(
                  'whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                  filter === item.id ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto scroll-slim">
          {isLoading && (
            <div className="space-y-3 p-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="flex gap-3">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3 w-2/3" />
                    <Skeleton className="h-3 w-full" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {isError && (
            <div className="p-4">
              <p className="text-sm text-rose-600">{error?.message ?? 'Could not load conversations'}</p>
            </div>
          )}

          {!isLoading && !isError && conversations.length === 0 && (
            <EmptyState
              icon={<InboxIcon className="h-9 w-9" />}
              title="No conversations yet"
              description={
                search
                  ? 'Nothing matched that search.'
                  : 'Connect a channel and send the widget a message to see threads appear here.'
              }
            />
          )}

          {conversations.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              active={conversation.id === selectedId}
              onSelect={() => {
                setSelectedId(conversation.id);
                setMobileThreadOpen(true);
              }}
            />
          ))}
        </div>
      </div>

      {/* ---------------------------------------------------------- Thread */}
      <div className={cx('min-w-0 flex-1', mobileThreadOpen ? 'flex' : 'hidden md:flex')}>
        {selected ? (
          <MessageThread
            conversation={selected}
            onTogglePanel={() => setShowPanel((value) => !value)}
            onBackToList={() => setMobileThreadOpen(false)}
            panelOpen={showPanel}
          />
        ) : (
          <EmptyState
            icon={<InboxIcon className="h-10 w-10" />}
            title="Select a conversation"
            description="Pick a thread on the left to read it and reply."
          />
        )}
      </div>

      {/* ----------------------------------------------------------- Panel */}
      {selected && showPanel && (
        <CustomerPanel conversation={selected} onClose={() => setShowPanel(false)} />
      )}
    </div>
  );
}

function ConversationRow({ conversation, active, onSelect }) {
  const { contact, unreadCount, lastMessagePreview, lastMessageDirection, ai } = conversation;

  return (
    <button
      onClick={onSelect}
      className={cx(
        'flex w-full gap-3 border-b border-slate-100 px-3 py-3 text-left transition-colors',
        active ? 'bg-brand-50' : 'hover:bg-slate-50',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-end gap-2">
          <span className="shrink-0 text-[11px] text-slate-400">{relativeTime(conversation.lastMessageAt)}</span>
        </div>

        <p className={cx('mt-0.5 truncate text-xs', unreadCount > 0 ? 'text-slate-700' : 'text-slate-500')}>
          {lastMessageDirection === 'outbound' && <span className="text-slate-400">You: </span>}
          {truncate(lastMessagePreview ?? 'No messages yet', 70)}
        </p>

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Badge tone="slate">{CHANNEL_LABELS[conversation.channelType] ?? conversation.channelType}</Badge>
          {conversation.status !== 'open' && <Badge tone={conversation.status === 'pending' ? 'amber' : 'slate'}>{conversation.status}</Badge>}
          {ai?.handover && (
            <Badge tone="amber" icon={<AlertIcon className="h-3 w-3" />}>
              Needs a human
            </Badge>
          )}
          {ai?.resolved && !ai?.handover && (
            <Badge tone="violet" icon={<SparkIcon className="h-3 w-3" />}>
              AI answered
            </Badge>
          )}
          {unreadCount > 0 && (
            <span className="ml-auto rounded-full bg-brand-600 px-1.5 py-0.5 text-[11px] font-semibold text-white">
              {unreadCount}
            </span>
          )}
        </div>

        {ai?.handover && ai?.handoverReason && (
          <p className="mt-1 truncate text-[11px] text-amber-700">{handoverLabel(ai.handoverReason)}</p>
        )}
      </div>
    </button>
  );
}
