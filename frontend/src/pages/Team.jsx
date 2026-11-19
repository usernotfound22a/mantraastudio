/**
 * Team: who can see this workspace, and what they are allowed to do.
 *
 * Roles are fixed server-side (owner / admin / agent / viewer) and cannot be
 * created here, so this screen is a directory plus a role editor.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useApp } from '../context/AppContext.jsx';
import { fullDate, relativeTime } from '../lib/format.js';
import { Alert, Avatar, Badge, Button, Card, Input, Modal, Select, Skeleton } from '../components/ui.jsx';
import { PlusIcon, TeamIcon, TrashIcon } from '../components/Icons.jsx';

const ROLE_HELP = {
  owner: 'Full control, including billing and deleting the workspace.',
  admin: 'Everything except billing, deleting the workspace, or changing owners.',
  agent: 'Reads the inbox, replies, and manages the knowledge base.',
  viewer: 'Read-only. Sees conversations and analytics, cannot reply.',
};

const ROLE_TONE = { owner: 'brand', admin: 'violet', agent: 'slate', viewer: 'slate' };

export default function Team() {
  const { can, toast, activeWorkspaceId, onRealtime, EVENTS: EV } = useApp();
  const queryClient = useQueryClient();
  const [inviting, setInviting] = useState(false);
  const canManage = can('owner', 'admin');

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['members', activeWorkspaceId],
    queryFn: () => api.get(`/workspaces/${activeWorkspaceId}/members`),
    enabled: Boolean(activeWorkspaceId),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['members'] });

  useEffect(() => {
    const offs = [
      onRealtime(EV.MEMBER_ADDED, invalidate),
      onRealtime(EV.MEMBER_UPDATED, invalidate),
      onRealtime(EV.MEMBER_REMOVED, invalidate),
    ];
    return () => offs.forEach((off) => off());
  }, [onRealtime, EV, queryClient]);

  const members = data?.members ?? [];

  return (
    <div className="h-full overflow-y-auto scroll-slim">
      <div className="mx-auto max-w-4xl space-y-5 p-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
              <TeamIcon className="h-5 w-5 text-brand-600" /> Team
            </h1>
            <p className="text-sm text-slate-500">
              Everyone here shares this inbox and this knowledge base.
            </p>
          </div>
          {canManage && (
            <Button icon={<PlusIcon className="h-4 w-4" />} onClick={() => setInviting(true)}>
              Add a member
            </Button>
          )}
        </header>

        {isError && <Alert tone="danger">{error?.message ?? 'Could not load the team'}</Alert>}

        {isLoading && <Skeleton className="h-40" />}

        {!isLoading && (
          <Card bodyClassName="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="px-4 py-2.5 font-medium">Person</th>
                  <th className="px-4 py-2.5 font-medium">Role</th>
                  <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Last seen</th>
                  {canManage && <th className="px-4 py-2.5" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {members.map((member) => (
                  <MemberRow
                    key={member.membershipId}
                    member={member}
                    workspaceId={activeWorkspaceId}
                    canManage={canManage}
                    onChanged={invalidate}
                  />
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {canManage && (
          <Card title="What each role can do">
            <dl className="space-y-2.5">
              {Object.entries(ROLE_HELP).map(([role, help]) => (
                <div key={role} className="flex flex-wrap items-baseline gap-2 text-sm">
                  <Badge tone={ROLE_TONE[role]}>{role}</Badge>
                  <span className="min-w-0 flex-1 text-slate-600">{help}</span>
                </div>
              ))}
            </dl>
          </Card>
        )}
      </div>

      {inviting && (
        <InviteModal
          onClose={() => setInviting(false)}
          onDone={() => {
            setInviting(false);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function MemberRow({ member, workspaceId, canManage, onChanged }) {
  const { toast, user } = useApp();
  const [editing, setEditing] = useState(false);
  const [role, setRole] = useState(member.role);
  const [confirming, setConfirming] = useState(false);
  const isSelf = member.userId === user?.id;

  const save = useMutation({
    mutationFn: () => api.patch(`/workspaces/${workspaceId}/members/${member.membershipId}`, { role }),
    onSuccess: () => {
      toast('Role updated', 'success');
      setEditing(false);
      onChanged();
    },
    onError: (error) => {
      toast(error.message ?? 'Could not change the role', 'error');
      setRole(member.role);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/workspaces/${workspaceId}/members/${member.membershipId}`),
    onSuccess: () => {
      toast('Member removed', 'success');
      onChanged();
    },
    onError: (error) => toast(error.message ?? 'Could not remove the member', 'error'),
  });

  return (
    <tr>
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <Avatar name={member.name} src={member.avatarUrl} size="sm" />
          <div className="min-w-0">
            <p className="truncate font-medium text-slate-800">
              {member.name}
              {isSelf && <span className="ml-1 text-xs font-normal text-slate-400">(you)</span>}
            </p>
            <p className="truncate text-xs text-slate-500">{member.email}</p>
          </div>
        </div>
      </td>

      <td className="px-4 py-2.5">
        {editing ? (
          <Select value={role} onChange={(event) => setRole(event.target.value)} className="w-28">
            {['owner', 'admin', 'agent', 'viewer'].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        ) : (
          <Badge tone={ROLE_TONE[member.role]}>{member.role}</Badge>
        )}
      </td>

      <td className="hidden px-4 py-2.5 text-xs text-slate-500 sm:table-cell">
        {member.lastLoginAt ? relativeTime(member.lastLoginAt) : `joined ${fullDate(member.joinedAt)}`}
      </td>

      {canManage && (
        <td className="px-4 py-2.5 text-right">
          {isSelf ? (
            <span className="text-xs text-slate-400">—</span>
          ) : editing ? (
            <div className="flex justify-end gap-1.5">
              <Button size="sm" loading={save.isPending} onClick={() => save.mutate()}>
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setRole(member.role);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          ) : confirming ? (
            <div className="flex justify-end gap-1.5">
              <Button size="sm" variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
                Remove
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Keep
              </Button>
            </div>
          ) : (
            <div className="flex justify-end gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                Role
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} title="Remove">
                <TrashIcon className="h-4 w-4" />
              </Button>
            </div>
          )}
        </td>
      )}
    </tr>
  );
}

function InviteModal({ onClose, onDone }) {
  const { toast, activeWorkspaceId } = useApp();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('agent');

  const invite = useMutation({
    mutationFn: () => api.post(`/workspaces/${activeWorkspaceId}/members`, { email: email.trim(), role }),
    onSuccess: () => {
      toast('Member added', 'success');
      onDone();
    },
    onError: (error) => toast(error.message ?? 'Could not add that member', 'error'),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Add a team member"
      description="They need an existing Mantraa Studio account. Invitations are not sent by email yet."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={invite.isPending} disabled={!email.includes('@')} onClick={() => invite.mutate()}>
            Add member
          </Button>
        </>
      }
    >
      <Input
        label="Email"
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="teammate@company.com"
        hint="If the account does not exist yet, create it first from the sign-up page."
      />
      <Select label="Role" value={role} onChange={(event) => setRole(event.target.value)} className="mt-3">
        {['admin', 'agent', 'viewer'].map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </Select>
      <p className="mt-2 text-xs text-slate-500">{ROLE_HELP[role]}</p>
    </Modal>
  );
}
