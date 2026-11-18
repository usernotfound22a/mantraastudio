/**
 * Workspace settings: identity, AI behaviour, and the account behind it.
 *
 * The AI switches here are the ones that decide whether the assistant acts at
 * all, so each one explains the consequence rather than just being a toggle.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useApp } from '../context/AppContext.jsx';
import { fullDate, number } from '../lib/format.js';
import { Alert, Button, Card, Input, Select, Switch, Skeleton } from '../components/ui.jsx';
import { BoltIcon, SparkIcon } from '../components/Icons.jsx';

const TIMEZONES = [
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Madrid',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Australia/Sydney',
];

export default function Settings() {
  const { activeWorkspaceId, can, toast, signOut, user, refreshProfile } = useApp();
  const queryClient = useQueryClient();
  const isAdmin = can('owner', 'admin');

  const { data, isLoading } = useQuery({
    queryKey: ['workspace', activeWorkspaceId],
    queryFn: () => api.get(`/workspaces/${activeWorkspaceId}`),
    enabled: Boolean(activeWorkspaceId),
  });

  const workspace = data?.workspace;
  const [form, setForm] = useState(null);
  const [profile, setProfile] = useState({ fullName: '', jobTitle: '' });
  const [password, setPassword] = useState({ currentPassword: '', newPassword: '' });

  // Only seed the form once per workspace; otherwise every realtime refresh
  // would overwrite whatever the user is currently typing.
  useEffect(() => {
    if (workspace && !form) {
      setForm({
        name: workspace.name,
        supportName: workspace.supportName ?? '',
        timezone: workspace.timezone ?? 'UTC',
        aiEnabled: workspace.aiEnabled,
        aiAutoSend: workspace.aiAutoSend,
      });
    }
  }, [workspace, form]);

  useEffect(() => {
    if (user && !profile.fullName) {
      setProfile({ fullName: user.fullName ?? '', jobTitle: user.jobTitle ?? '' });
    }
  }, [user, profile.fullName]);

  const saveWorkspace = useMutation({
    mutationFn: () => api.patch(`/workspaces/${activeWorkspaceId}`, form),
    onSuccess: (payload) => {
      toast('Workspace updated', 'success');
      setForm(null);
      queryClient.setQueryData(['workspace', activeWorkspaceId], payload);
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    },
    onError: (error) => toast(error.message ?? 'Could not save', 'error'),
  });

  const saveProfile = useMutation({
    mutationFn: () => api.patch('/auth/me', { fullName: profile.fullName.trim(), jobTitle: profile.jobTitle.trim() || undefined }),
    onSuccess: () => {
      toast('Profile updated', 'success');
      refreshProfile?.();
    },
    onError: (error) => toast(error.message ?? 'Could not save your profile', 'error'),
  });

  const changePassword = useMutation({
    mutationFn: () => api.post('/auth/change-password', password),
    onSuccess: () => {
      toast('Password changed', 'success');
      setPassword({ currentPassword: '', newPassword: '' });
    },
    onError: (error) => toast(error.message ?? 'Could not change the password', 'error'),
  });

  if (isLoading) return <div className="p-6"><Skeleton className="h-64" /></div>;

  return (
    <div className="h-full overflow-y-auto scroll-slim">
      <div className="mx-auto max-w-3xl space-y-5 p-6">
        <header>
          <h1 className="text-lg font-semibold text-slate-900">Settings</h1>
          <p className="text-sm text-slate-500">Workspace, assistant and account.</p>
        </header>

        {/* ----------------------------------------------------- Workspace */}
        <Card title="Workspace" description="How this inbox introduces itself to customers.">
          {workspace && form && (
            <div className="space-y-4">
              <Input
                label="Workspace name"
                value={form.name}
                disabled={!isAdmin}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              />
              <Input
                label="Assistant name"
                hint="What the AI calls itself in replies."
                value={form.supportName}
                disabled={!isAdmin}
                onChange={(event) => setForm((current) => ({ ...current, supportName: event.target.value }))}
              />
              <Select
                label="Timezone"
                hint="Used for daily reports and business hours."
                value={form.timezone}
                disabled={!isAdmin}
                onChange={(event) => setForm((current) => ({ ...current, timezone: event.target.value }))}
              >
                {TIMEZONES.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </Select>

              {isAdmin && (
                <Button loading={saveWorkspace.isPending} onClick={() => saveWorkspace.mutate()}>
                  Save workspace
                </Button>
              )}
            </div>
          )}
        </Card>

        {/* ------------------------------------------------------------ AI */}
        <Card title="AI assistant" description="Whether the assistant replies at all, and how boldly.">
          {workspace && form && (
            <div className="space-y-4">
              <Switch
                checked={form.aiEnabled}
                disabled={!isAdmin}
                onChange={(value) => setForm((current) => ({ ...current, aiEnabled: value }))}
                label="Enable the assistant"
                description="When off, every message waits for a human. Messages are still stored and searchable."
              />

              <Switch
                checked={form.aiAutoSend}
                disabled={!isAdmin || !form.aiEnabled}
                onChange={(value) => setForm((current) => ({ ...current, aiAutoSend: value }))}
                label="Send replies automatically"
                description="When off, the assistant drafts a reply and waits for an agent to send it. Useful while you tune the knowledge base."
              />

              <div className="rounded-lg bg-slate-50 p-3">
                <p className="flex items-center gap-1.5 text-xs font-medium text-slate-700">
                  <SparkIcon className="h-3.5 w-3.5 text-violet-500" /> How it decides
                </p>
                <ul className="mt-1.5 space-y-1 text-[11px] text-slate-600">
                  <li>• Answers only from the knowledge base, and only above the confidence threshold.</li>
                  <li>• Anything below the threshold, or anything urgent, is handed to a human instead of guessed.</li>
                  <li>• Every question it could not answer is recorded, so the gap can be filled.</li>
                </ul>
              </div>

              {isAdmin && (
                <Button loading={saveWorkspace.isPending} onClick={() => saveWorkspace.mutate()}>
                  Save assistant settings
                </Button>
              )}
            </div>
          )}
        </Card>

        {/* ------------------------------------------------------- Account */}
        <Card title="Your account" description={user?.email}>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Full name"
                value={profile.fullName}
                onChange={(event) => setProfile((current) => ({ ...current, fullName: event.target.value }))}
              />
              <Input
                label="Job title"
                value={profile.jobTitle}
                onChange={(event) => setProfile((current) => ({ ...current, jobTitle: event.target.value }))}
                placeholder="Support lead"
              />
            </div>
            <Button loading={saveProfile.isPending} onClick={() => saveProfile.mutate()}>
              Save profile
            </Button>
          </div>
        </Card>

        <Card title="Password">
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              changePassword.mutate();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Current password"
                type="password"
                autoComplete="current-password"
                value={password.currentPassword}
                onChange={(event) => setPassword((current) => ({ ...current, currentPassword: event.target.value }))}
              />
              <Input
                label="New password"
                type="password"
                autoComplete="new-password"
                value={password.newPassword}
                onChange={(event) => setPassword((current) => ({ ...current, newPassword: event.target.value }))}
                hint="At least 8 characters."
              />
            </div>
            <Button
              type="submit"
              variant="secondary"
              loading={changePassword.isPending}
              disabled={!password.currentPassword || password.newPassword.length < 8}
            >
              Change password
            </Button>
          </form>
        </Card>

        <Card title="Danger zone">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-slate-800">Sign out</p>
              <p className="text-xs text-slate-500">Ends this session on this device only.</p>
            </div>
            <Button variant="secondary" onClick={signOut}>
              Sign out
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
