/**
 * Application shell: fixed sidebar, workspace switcher, live indicator and the
 * toast stack. Every authenticated page renders inside this.
 */
import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useApp } from '../context/AppContext.jsx';
import { Avatar, Badge, Button, Select, cx } from './ui.jsx';
import {
  InboxIcon,
  ChartIcon,
  ChannelsIcon,
  FaqIcon,
  TeamIcon,
  BillingIcon,
  CloseIcon,
  LogoutIcon,
  MenuIcon,
  ExternalIcon,
  KeyIcon,
  WebhookIcon,
  PluginIcon,
} from './Icons.jsx';

const NAV = [
  { to: '/', label: 'Inbox', icon: InboxIcon, end: true },
  { to: '/analytics', label: 'Analytics', icon: ChartIcon },
  { to: '/settings/channels', label: 'Channels', icon: ChannelsIcon },
  { to: '/settings/faq', label: 'Knowledge base', icon: FaqIcon },
  { to: '/settings/team', label: 'Team', icon: TeamIcon },
  { to: '/settings/billing', label: 'Billing', icon: BillingIcon },
  // The three plugin systems: channel adapters, the scoped public API, and
  // outbound webhooks.
  { to: '/settings/plugins', label: 'Plugins', icon: PluginIcon },
  { to: '/settings/api-keys', label: 'API keys', icon: KeyIcon },
  { to: '/settings/webhooks', label: 'Webhooks', icon: WebhookIcon },
  // The widget preview lives outside the shell, so it opens in a new tab
  // instead of being a nav link that would leave the dashboard chrome behind.
  { to: '/widget-preview', label: 'Widget preview', icon: ExternalIcon, external: true },
];

export default function AppShell() {
  const { user, workspaces, activeWorkspace, activeWorkspaceId, live, signOut, switchWorkspace, toasts, dismissToast } =
    useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [signingOut, setSigningOut] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleSignOut = async () => {
    setSigningOut(true);
    // Drop the cache before the token so no stale tenant data can be rendered
    // if the user signs in again.
    queryClient.clear();
    signOut();
    navigate('/login', { replace: true });
  };

  return (
    <div className="relative flex h-screen overflow-hidden bg-slate-50">
      {mobileMenuOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setMobileMenuOpen(false)}
          className="fixed inset-0 z-30 bg-slate-950/50 md:hidden"
        />
      )}
      {/* ------------------------------------------------------- Sidebar */}
      <aside
        id="primary-navigation"
        className={cx(
          'fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col bg-slate-900 transition-transform duration-200 md:static md:z-auto md:translate-x-0',
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center gap-2 px-5 py-5">
          <img
            src="/socialhub-icon.png"
            alt=""
            className="h-9 w-9 shrink-0 rounded-xl object-contain"
          />
          <span className="text-base font-semibold tracking-tight text-white">Mantraa Studio</span>
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setMobileMenuOpen(false)}
            className="ml-auto rounded-md p-1.5 text-slate-300 hover:bg-white/10 md:hidden"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        {workspaces.length > 0 && (
          <div className="px-3 pb-3">
            <label className="sr-only" htmlFor="workspace-switcher">
              Active workspace
            </label>
            <Select
              id="workspace-switcher"
              className="[&>select]:bg-slate-800 [&>select]:border-slate-700 [&>select]:text-white [&>select]:text-sm [&>select]:py-1.5"
              value={activeWorkspaceId ?? ''}
              onChange={(event) => switchWorkspace(Number(event.target.value))}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </Select>
          </div>
        )}

        <nav className="flex-1 space-y-1 px-3">
          {NAV.map(({ to, label, icon: Icon, end, external }) => (
            external ? (
              <a key={to} href={to} className="nav-link" onClick={() => setMobileMenuOpen(false)}>
                <Icon className="h-4 w-4" />
                {label}
              </a>
            ) : (
              <NavLink
                key={to}
                to={to}
                end={end}
                onClick={() => setMobileMenuOpen(false)}
                className={({ isActive }) => cx('nav-link', isActive && 'nav-link-active')}
              >
                <Icon className="h-4 w-4" />
                {label}
              </NavLink>
            )
          ))}
        </nav>

        <div className="border-t border-white/10 px-3 py-3">
          <div className="flex items-center gap-2.5 px-2 py-1.5">
            <Avatar name={user?.fullName} src={user?.avatarUrl} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white">{user?.fullName ?? 'Account'}</p>
              <p className="truncate text-xs text-slate-400">{user?.email}</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSignOut}
            loading={signingOut}
            icon={<LogoutIcon className="h-4 w-4" />}
            className="mt-1 w-full justify-start text-slate-300 hover:bg-white/10 hover:text-white"
          >
            Sign out
          </Button>
        </div>
      </aside>

      {/* --------------------------------------------------------- Content */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 sm:gap-4 sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              aria-label="Open navigation"
              aria-controls="primary-navigation"
              aria-expanded={mobileMenuOpen}
              onClick={() => setMobileMenuOpen(true)}
              className="rounded-md p-2 text-slate-600 hover:bg-slate-100 md:hidden"
            >
              <MenuIcon className="h-5 w-5" />
            </button>
            <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-slate-900">
              {activeWorkspace?.name ?? 'Mantraa Studio'}
            </h1>
            {activeWorkspace?.slug && (
              <p className="truncate text-xs text-slate-500">{activeWorkspace.slug}.socialhub.app</p>
            )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            {activeWorkspace && <Badge className="hidden sm:inline-flex" tone={activeWorkspace.role === 'owner' ? 'brand' : 'slate'}>{activeWorkspace.role}</Badge>}
            <span
              className="flex items-center gap-1.5 text-xs text-slate-500"
              title={live ? 'Connected to the live event stream' : 'Reconnecting…'}
            >
              <span
                className={cx(
                  'h-2 w-2 rounded-full',
                  live ? 'bg-emerald-500' : 'animate-pulse bg-amber-400',
                )}
              />
              {live ? 'Live' : 'Offline'}
            </span>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>

      {/* ---------------------------------------------------------- Toasts */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[calc(100%-2rem)] max-w-80 flex-col gap-2 sm:bottom-5 sm:right-5">
        {toasts.map((item) => (
          <div
            key={item.id}
            role="status"
            onClick={() => dismissToast(item.id)}
            className={cx(
              'pointer-events-auto cursor-pointer rounded-lg px-3.5 py-2.5 text-sm shadow-lg animate-slide-up',
              item.tone === 'error'
                ? 'bg-rose-600 text-white'
                : item.tone === 'success'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-900 text-white',
            )}
          >
            {item.message}
          </div>
        ))}
      </div>
    </div>
  );
}
