/**
 * Customer panel: who this person is, what the AI inferred, and the actions an
 * agent needs (assign, priority, hand the AI back).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useApp } from '../context/AppContext.jsx';
import { fullDate, number, duration, INTENT_LABELS, handoverLabel, CHANNEL_LABELS } from '../lib/format.js';
import { Badge, Button, Select } from './ui.jsx';
import { CloseIcon, SparkIcon, AlertIcon } from './Icons.jsx';

export default function CustomerPanel({ conversation, onClose }) {
  const { can, toast, activeWorkspaceId } = useApp();
  const queryClient = useQueryClient();
  const id = conversation.id;
  const ai = conversation.ai ?? {};
  const contact = conversation.contact ?? {};

  // The assignee list is a separate endpoint, not part of /auth/me: it must only
  // include active members of THIS workspace.
  const agentsQuery = useQuery({
    queryKey: ['agents', activeWorkspaceId],
    queryFn: () => api.get(`/workspaces/${activeWorkspaceId}/agents`),
    enabled: Boolean(activeWorkspaceId),
  });
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['conversations'] });
    queryClient.invalidateQueries({ queryKey: ['conversation', id] });
  };

  const assign = useMutation({
    mutationFn: (assigneeId) =>
      // Two routes on purpose: /assign wants a real member id, so clearing the
      // assignee has to be the separate /unassign endpoint.
      assigneeId
        ? api.patch(`/conversations/${id}/assign`, { assigneeId })
        : api.patch(`/conversations/${id}/unassign`, {}),
    onSuccess: invalidate,
    onError: (error) => toast(error.message ?? 'Could not assign', 'error'),
  });

  const toggleHandover = useMutation({
    mutationFn: (handedOver) => api.patch(`/conversations/${id}/handover`, { handedOver }),
    onSuccess: (_data, handedOver) => {
      toast(handedOver ? 'The assistant is paused for this thread' : 'The assistant can reply again', 'success');
      invalidate();
    },
    onError: (error) => toast(error.message ?? 'Could not change the AI setting', 'error'),
  });

  return (
    <aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-slate-200 bg-white scroll-slim xl:block">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">Details</h2>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-700 xl:hidden">
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-4 p-4">
        {/* Customer */}
        <div className="flex items-center gap-3">
          <div className="min-w-0">
            {contact.email && <p className="truncate text-xs text-slate-500">{contact.email}</p>}
            {contact.locale && <p className="text-[11px] text-slate-400">{contact.locale}</p>}
          </div>
        </div>

        {/* AI insight */}
        <div className="rounded-xl border border-violet-200 bg-violet-50/60 p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-violet-900">
            <SparkIcon className="h-3.5 w-3.5" /> Assistant
          </p>

          {ai.handover ? (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-800">
              <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Paused · {handoverLabel(ai.handoverReason)}
                {ai.confidence ? ` (${Math.round(ai.confidence * 100)}% confidence)` : ''}
              </span>
            </p>
          ) : ai.resolved ? (
            <p className="mt-1.5 text-xs text-violet-800">
              Answered this thread without human help.
            </p>
          ) : (
            <p className="mt-1.5 text-xs text-violet-800">Watching this thread and will answer what it can.</p>
          )}

          {ai.leadTags?.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {ai.leadTags.map((tag) => (
                <Badge key={tag} tone="violet">
                  {INTENT_LABELS[tag] ?? tag}
                </Badge>
              ))}
            </div>
          )}

          {can('agent', 'admin', 'owner') && (
            <Button
              size="sm"
              variant={ai.handover ? 'secondary' : 'ghost'}
              className="mt-2.5 w-full"
              loading={toggleHandover.isPending}
              onClick={() => toggleHandover.mutate(!ai.handover)}
            >
              {ai.handover ? 'Let the assistant reply again' : 'Take over manually'}
            </Button>
          )}
        </div>

        {/* Assignment */}
        {can('agent', 'admin', 'owner') && (
          <div className="space-y-2.5">
            <Select
              label="Assignee"
              value={conversation.assignee?.id ?? ''}
              disabled={agentsQuery.isLoading}
              onChange={(event) => assign.mutate(event.target.value ? Number(event.target.value) : null)}
            >
              <option value="">Unassigned</option>
              {agentsQuery.data?.agents?.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                  {agent.role === 'owner' ? ' (owner)' : ''}
                </option>
              ))}
            </Select>
            <p className="text-[11px] text-slate-400">
              Assigning takes the thread out of the shared queue and puts it in this person's inbox.
            </p>
          </div>
        )}

        {/* Metrics */}
        <dl className="space-y-2 border-t border-slate-200 pt-3 text-xs">
          <Row label="Status">
            <Badge tone={conversation.status === 'open' ? 'green' : conversation.status === 'pending' ? 'amber' : 'slate'}>
              {conversation.status}
            </Badge>
          </Row>
          <Row label="Priority">
            <Badge tone={conversation.priority === 'high' ? 'rose' : conversation.priority === 'low' ? 'slate' : 'brand'}>
              {conversation.priority}
            </Badge>
          </Row>
          <Row label="Channel">{CHANNEL_LABELS[conversation.channelType] ?? conversation.channelType}</Row>
          <Row label="Unread">{number(conversation.unreadCount)}</Row>
          <Row label="First response">{duration(conversation.firstResponseSeconds)}</Row>
          <Row label="Last activity">{fullDate(conversation.lastMessageAt)}</Row>
          {conversation.subject && <Row label="Subject">{conversation.subject}</Row>}
        </dl>
      </div>
    </aside>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium text-slate-800">{children}</dd>
    </div>
  );
}
