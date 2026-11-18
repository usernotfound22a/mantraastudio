/**
 * Global app state: authentication, the active workspace and toasts.
 *
 * One provider rather than three because these three are genuinely
 * interdependent - signing out has to close the socket, clear the cached
 * workspace and drop the token together, and that is far easier to reason
 * about in one place.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, tokens, getActiveWorkspaceId, setActiveWorkspaceId } from '../lib/api.js';
import { connect, subscribe, disconnect, clearListeners, on, EVENTS } from '../lib/realtime.js';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [user, setUser] = useState(tokens.user);
  const [workspaces, setWorkspaces] = useState([]);
  const [activeWorkspaceId, setActive] = useState(getActiveWorkspaceId());
  const [booting, setBooting] = useState(Boolean(tokens.access));
  const [live, setLive] = useState(false);
  const [toasts, setToasts] = useState([]);

  const toast = useCallback((message, tone = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 5000);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  /** Restore the session from the refresh token on a hard reload. */
  useEffect(() => {
    if (!tokens.access && !tokens.refresh) {
      setBooting(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get('/auth/me');
        if (cancelled) return;
        setUser(data.user);
        setWorkspaces(data.workspaces ?? []);
        const current = getActiveWorkspaceId();
        const valid = (data.workspaces ?? []).some((w) => w.id === current);
        setActive(valid ? current : data.workspaces?.[0]?.id ?? null);
      } catch {
        // A stale or rejected token: fall back to a clean signed-out state
        // rather than leaving a half-authenticated shell on screen.
        if (!cancelled) signOut();
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Keep the socket alive and reflect its state in the UI. */
  useEffect(() => {
    if (!user || !activeWorkspaceId) return undefined;

    const socket = connect();
    setLive(socket.connected);
    const onConnect = () => setLive(true);
    const onDisconnect = () => setLive(false);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    subscribe(activeWorkspaceId);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, [user, activeWorkspaceId]);

  const signIn = useCallback(async (email, password) => {
    const data = await api.post('/auth/login', { email, password }, { auth: false });
    // Login nests the pair under `tokens`; refresh returns a flat accessToken.
    tokens.save({
      accessToken: data.tokens?.accessToken ?? data.accessToken,
      refreshToken: data.tokens?.refreshToken,
      user: data.user,
    });
    setUser(data.user);
    setWorkspaces(data.workspaces ?? []);
    const first = data.workspaces?.[0]?.id ?? null;
    setActiveWorkspaceId(first);
    setActive(first);
    return data;
  }, []);

  const signOut = useCallback(() => {
    clearListeners();
    disconnect();
    tokens.clear();
    setActiveWorkspaceId(null);
    setUser(null);
    setWorkspaces([]);
    setActive(null);
    setLive(false);
  }, []);

  const switchWorkspace = useCallback(async (workspaceId) => {
    const result = await subscribe(workspaceId);
    if (result?.ok) {
      setActiveWorkspaceId(workspaceId);
      setActive(workspaceId);
    } else {
      toast(result?.error ?? 'Could not switch workspace', 'error');
    }
    return result;
  }, [toast]);

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId],
  );

  const activeRole = activeWorkspace?.role ?? null;

  /** Can this role perform an action? Mirrors the backend's requireRole. */
  const can = useCallback(
    (...roles) => (activeRole ? roles.includes(activeRole) : false),
    [activeRole],
  );

  /**
   * Subscribes to a server event for the life of a component.
   *
   * `onRealtime(EVENTS.MESSAGE_NEW, (payload) => ...)` returns an unsubscribe
   * function; the handler is a plain callback, so a screen can either patch the
   * cache directly or invalidate the queries it cares about.
   */
  const onRealtime = useCallback((event, handler) => on(event, handler), []);

  /** Re-reads /auth/me, so a profile edit shows up without a reload. */
  const refreshProfile = useCallback(async () => {
    try {
      const data = await api.get('/auth/me');
      setUser(data.user);
      setWorkspaces(data.workspaces ?? []);
    } catch {
      // A failed refresh is not worth a toast: the user just edited their own
      // profile and will see the result on the next navigation anyway.
    }
  }, []);

  const value = useMemo(
    () => ({
      user,
      workspaces,
      activeWorkspace,
      activeWorkspaceId,
      activeRole,
      can,
      live,
      booting,
      signIn,
      signOut,
      switchWorkspace,
      refreshProfile,
      toast,
      toasts,
      dismissToast,
      onRealtime,
      EVENTS,
    }),
    [
      user,
      workspaces,
      activeWorkspace,
      activeWorkspaceId,
      activeRole,
      can,
      live,
      booting,
      signIn,
      signOut,
      switchWorkspace,
      refreshProfile,
      toast,
      toasts,
      dismissToast,
      onRealtime,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside <AppProvider>');
  return context;
}
