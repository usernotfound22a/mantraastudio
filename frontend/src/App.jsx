/**
 * Routes.
 *
 * Three zones:
 *   - /login, /register          public, redirect away when already signed in
 *   - / (AppShell + Outlet)       authenticated workspace screens
 *   - /embed                       the standalone widget, outside the shell
 *
 * Auth is decided by AppContext's `booting`/`user` pair rather than by a token
 * check here, so a hard refresh does not flash the login screen at a signed-in
 * user while /auth/me is still in flight.
 */
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppProvider, useApp } from './context/AppContext.jsx';
import { Spinner } from './components/ui.jsx';
import AppShell from './components/AppShell.jsx';
import Inbox from './components/Inbox.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import Analytics from './pages/Analytics.jsx';
import Channels from './pages/Channels.jsx';
import Knowledge from './pages/Knowledge.jsx';
import Team from './pages/Team.jsx';
import Billing from './pages/Billing.jsx';
import Settings from './pages/Settings.jsx';
import ApiKeys from './pages/ApiKeys.jsx';
import Webhooks from './pages/Webhooks.jsx';
import Plugins from './pages/Plugins.jsx';
import WidgetDemo from './pages/WidgetDemo.jsx';
import NotFound from './pages/NotFound.jsx';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Inbox data is pushed over the socket, so polling would only duplicate
      // work and cause the list to re-sort under the cursor.
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: (failureCount, error) => {
        // Never retry an auth or permission failure: it will not get better,
        // and retrying delays the redirect to the login screen.
        const status = error?.status;
        if (status === 401 || status === 403 || status === 404) return false;
        return failureCount < 2;
      },
    },
  },
});

/** Gate for everything inside the shell. */
function RequireAuth({ children }) {
  const { user, booting } = useApp();
  const location = useLocation();

  if (booting) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

/** Keeps a signed-in user out of the login page. */
function PublicOnly({ children }) {
  const { user, booting } = useApp();
  if (booting) return <FullPageSpinner />;
  if (user) return <Navigate to="/" replace />;
  return children;
}

function FullPageSpinner() {
  return (
    <div className="flex h-screen items-center justify-center bg-slate-50">
      <div className="flex flex-col items-center gap-3">
        <Spinner className="h-7 w-7 text-brand-600" />
        <p className="text-xs text-slate-500">Loading your workspace…</p>
      </div>
    </div>
  );
}

/** No workspace yet: the account exists but there is nothing to show. */
function NoWorkspace() {
  const { user, signOut } = useApp();
  return (
    <div className="flex h-screen items-center justify-center bg-slate-50 p-6">
      <div className="card max-w-md p-6 text-center">
        <h1 className="text-base font-semibold text-slate-900">No workspace yet</h1>
        <p className="mt-2 text-sm text-slate-600">
          {user?.email} is not a member of any workspace. Ask an owner for an invite, or create a
          workspace from the API, then sign in again.
        </p>
        <button onClick={signOut} className="btn btn-secondary mt-4">
          Sign out
        </button>
      </div>
    </div>
  );
}

function Shell() {
  const { activeWorkspaceId } = useApp();
  return (
    <RequireAuth>
      {activeWorkspaceId ? <AppShell /> : <NoWorkspace />}
    </RequireAuth>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppProvider>
          <Routes>
            {/* The widget must not be wrapped in the dashboard shell or the
                auth gate: it authenticates with its widget key, not a JWT. */}
            <Route path="/embed/:channelId" element={<WidgetDemo />} />

            <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />
            <Route path="/register" element={<PublicOnly><Register /></PublicOnly>} />

            {/* Preview opens in its own tab, but stays inside the shell so the
                user can see the snippet without losing their place. */}
            <Route element={<Shell />}>
              <Route index element={<Inbox />} />
              <Route path="analytics" element={<Analytics />} />
              <Route path="widget-preview" element={<WidgetDemo />} />
              <Route path="settings" element={<Settings />} />
              <Route path="settings/channels" element={<Channels />} />
              <Route path="settings/faq" element={<Knowledge />} />
              <Route path="settings/team" element={<Team />} />
              <Route path="settings/billing" element={<Billing />} />
              {/* Developer surface: the three plugin systems. */}
              <Route path="settings/api-keys" element={<ApiKeys />} />
              <Route path="settings/webhooks" element={<Webhooks />} />
              <Route path="settings/plugins" element={<Plugins />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </AppProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
