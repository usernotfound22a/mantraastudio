/**
 * Realtime (Socket.IO) client for the dashboard.
 *
 * Key points:
 *   - auth is sent on the handshake (access token + workspace id), so an
 *     unauthenticated socket never joins any room
 *   - `subscribe(workspaceId)` re-validates membership by calling
 *     `workspace:subscribe`; it also leaves the previous workspace room
 *   - `watchConversation`/`unwatchConversation` join/leave the per-thread room
 *   - every listener is registered with a stable id so the UI can clean up
 *     without leaking callbacks
 */
import { io } from 'socket.io-client';
import { tokens, getActiveWorkspaceId, setActiveWorkspaceId } from './api.js';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? window.location.origin;

let socket = null;
let currentWorkspace = null;
const listeners = new Map();

export function connect() {
  if (socket) return socket;

  socket = io(SOCKET_URL, {
    auth: {
      token: tokens.access,
      workspaceId: getActiveWorkspaceId(),
    },
    autoConnect: true,
    reconnection: true,
    reconnectionAttempts: 20,
    reconnectionDelay: 1000,
    transports: ['websocket', 'polling'],
  });

  socket.on('connect_error', (error) => {
    console.warn('[socket] connect_error:', error?.message);
  });
  socket.on('disconnect', (reason) => {
    console.warn('[socket] disconnected:', reason);
  });

  return socket;
}

export function disconnect() {
  socket?.disconnect();
  socket = null;
  currentWorkspace = null;
  listeners.clear();
}

export function isConnected() {
  return socket?.connected ?? false;
}

/** Register a listener. Returns an unsubscribe function. */
export function on(event, handler) {
  connect();
  const wrapped = (payload) => handler(payload);
  const list = listeners.get(event) ?? [];
  list.push(wrapped);
  listeners.set(event, list);
  socket.on(event, wrapped);
  return () => off(event, wrapped);
}

/** Unregister one wrapped handler. */
export function off(event, wrapped) {
  const list = listeners.get(event) ?? [];
  const filtered = list.filter((fn) => fn !== wrapped);
  if (filtered.length) listeners.set(event, filtered);
  else listeners.delete(event);
  socket?.off(event, wrapped);
}

/** Clear all listeners for an event, or every event. */
export function clearListeners(event) {
  if (event) {
    listeners.delete(event);
    socket?.off(event);
  } else {
    for (const e of listeners.keys()) socket?.off(e);
    listeners.clear();
  }
}

/** Switch the active workspace room. */
export async function subscribe(workspaceId) {
  connect();
  if (currentWorkspace === workspaceId) return { ok: true };

  return new Promise((resolve) => {
    socket.emit('workspace:subscribe', { workspaceId }, (response) => {
      if (response?.ok) {
        currentWorkspace = workspaceId;
        setActiveWorkspaceId(workspaceId);
      }
      resolve(response ?? { ok: false });
    });
  });
}

/** Join/leave the conversation room to get typing + focused updates. */
export function watchConversation(conversationId) {
  connect();
  socket.emit('conversation:watch', { conversationId });
}
export function unwatchConversation(conversationId) {
  connect();
  socket.emit('conversation:unwatch', { conversationId });
}

export function sendTyping(conversationId, isTyping) {
  connect();
  socket.emit('conversation:typing', { conversationId, isTyping });
}

/** Send a heartbeat to keep the UI's "live" status accurate. */
export async function ping() {
  connect();
  return new Promise((resolve) => {
    socket.emit('ping:check', (response) => resolve(response ?? { ok: false }));
  });
}

export const EVENTS = {
  WORKSPACE_SUBSCRIBED: 'workspace:subscribed',
  CONVERSATION_UPSERTED: 'conversation:upserted',
  CONVERSATION_UPDATED: 'conversation:updated',
  CONVERSATION_ASSIGNED: 'conversation:assigned',
  CONVERSATION_READ: 'conversation:read',
  CONVERSATION_HANDOVER: 'conversation:handover',
  CONVERSATION_TYPING: 'conversation:typing',
  MESSAGE_NEW: 'message:new',
  MESSAGE_FAILED: 'message:failed',
  MESSAGE_DELIVERED: 'message:delivered',
  NOTE_CREATED: 'note:created',
  NOTE_UPDATED: 'note:updated',
  NOTE_DELETED: 'note:deleted',
  CHANNEL_CREATED: 'channel:created',
  CHANNEL_UPDATED: 'channel:updated',
  CHANNEL_DELETED: 'channel:deleted',
  FAQ_CREATED: 'faq:created',
  FAQ_UPDATED: 'faq:updated',
  FAQ_DELETED: 'faq:deleted',
  MEMBER_ADDED: 'workspace:member_added',
  MEMBER_REMOVED: 'workspace:member_removed',
  MEMBER_UPDATED: 'workspace:member_updated',
  WORKSPACE_UPDATED: 'workspace:updated',
  SUBSCRIPTION_UPDATED: 'billing:subscription_updated',
  WIDGET_TYPING: 'widget:typing',
};
