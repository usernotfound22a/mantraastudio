/**
 * API client.
 *
 * Responsibilities:
 *   - attach the access token and the active workspace header
 *   - transparently refresh an expired access token once, then replay the
 *     request, so an agent sitting on an open dashboard is never logged out
 *   - normalise every error into one shape the UI can render
 *
 * Only ONE refresh is ever in flight: concurrent 401s await the same promise
 * instead of each firing their own refresh (which would race and, with rotating
 * refresh tokens, invalidate itself).
 */
import { supabase } from './supabase.js';

const BASE = import.meta.env.VITE_API_URL ?? '/api';

const ACCESS_KEY = 'socialhub.accessToken';
const REFRESH_KEY = 'socialhub.refreshToken';
const USER_KEY = 'socialhub.user';

export const tokens = {
  get access() {
    return localStorage.getItem(ACCESS_KEY);
  },
  get refresh() {
    return localStorage.getItem(REFRESH_KEY);
  },
  get user() {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  },
  save({ accessToken, refreshToken, user }) {
    if (accessToken) localStorage.setItem(ACCESS_KEY, accessToken);
    if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    if (accessToken && refreshToken) {
      supabase.auth
        .setSession({ access_token: accessToken, refresh_token: refreshToken })
        .catch(() => {});
    }
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
  },
};

export class ApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let refreshInFlight = null;

async function refreshAccessToken() {
  refreshInFlight ??= (async () => {
    const refreshToken = tokens.refresh;
    if (!refreshToken) return false;

    const response = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) {
      tokens.clear();
      window.dispatchEvent(new CustomEvent('socialhub:auth-expired'));
      return false;
    }

    const data = await response.json();
    tokens.save({ accessToken: data.accessToken, refreshToken: data.refreshToken });
    return true;
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

async function request(path, { method = 'GET', body, auth = true, workspaceId, isRetry = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth) {
    const access = tokens.access;
    if (access) headers.authorization = `Bearer ${access}`;
    const workspace = workspaceId ?? getActiveWorkspaceId();
    if (workspace) headers['x-workspace-id'] = String(workspace);
  }

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (response.status === 204) return null;

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }

  if (response.ok) return payload;

  // One retry after a successful refresh. `isRetry` stops a refresh failure
  // from looping forever.
  if (response.status === 401 && auth && !isRetry && (await refreshAccessToken())) {
    return request(path, { method, body, auth, workspaceId, isRetry: true });
  }

  const error = payload?.error ?? payload;
  throw new ApiError(error?.message ?? payload?.message ?? `Request failed (${response.status})`, {
    status: response.status,
    code: error?.code ?? payload?.code,
    details: error?.details ?? payload?.details,
  });
}

const WORKSPACE_KEY = 'socialhub.workspaceId';

export const getActiveWorkspaceId = () => {
  const stored = localStorage.getItem(WORKSPACE_KEY);
  return stored ? Number(stored) : null;
};

export const setActiveWorkspaceId = (id) => {
  if (id) localStorage.setItem(WORKSPACE_KEY, String(id));
  else localStorage.removeItem(WORKSPACE_KEY);
};

export const api = {
  get: (path, options) => request(path, { ...options, method: 'GET' }),
  post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
  patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
  put: (path, body, options) => request(path, { ...options, method: 'PUT', body }),
  delete: (path, options) => request(path, { ...options, method: 'DELETE' }),
  refresh: refreshAccessToken,
};
