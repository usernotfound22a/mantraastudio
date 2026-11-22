/**
 * Socket.IO bootstrap + emit helpers.
 *
 * How real-time works in SocialHub
 * ------------------------------
 * 1. The SPA connects with `io(BASE_URL, { auth: { token: accessToken,
 *    workspaceId } })`. The handshake token is verified here, so an
 *    unauthenticated socket can never join a room.
 * 2. Every socket joins the room `ws:<workspaceId>` (+ a personal room
 *    `user:<userId>` for cross-workspace notifications).
 * 3. Server-side code never touches the io instance directly for business
 *    events - it calls `emitToWorkspace()` from anywhere (HTTP route, webhook
 *    handler, AI service). That keeps real-time a side effect of a normal
 *    request instead of a separate code path.
 *
 * The full event catalogue lives in ./events.js, which is the contract shared
 * with the frontend.
 */
import { Server } from 'socket.io';
import { createUserClient, getAdminClient, withSupabaseClient, selectOne } from '../db/supabase.js';
import { findMembership } from './membership.service.js';
import { env } from '../config/env.js';
import { childLogger } from '../config/logger.js';
import { EVENTS } from './events.js';

const log = childLogger('socket');

/** io instance, set by initSocket(). */
let io = null;

/** Room name helpers - always use these instead of raw strings. */
export const rooms = {
  workspace: (workspaceId) => `ws:${workspaceId}`,
  user: (userId) => `user:${userId}`,
  conversation: (conversationId) => `conv:${conversationId}`,
};

/**
 * Attaches Socket.IO to the HTTP server.
 * @param {import('node:http').Server} httpServer
 */
export function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: env.CORS_ORIGINS, credentials: true },
    // Long-poll fallback stays alive behind proxies/tunnels.
    pingTimeout: 25000,
    pingInterval: 20000,
  });

  // --- Authentication during the handshake -------------------------------
  io.use(async (socket, next) => {
    try {
      const { token, workspaceId } = socket.handshake.auth || {};

      if (!token) return next(new Error('Missing auth token'));
      const client = createUserClient(token);
      const { data: authData, error: authError } = await client.auth.getUser(token);
      if (authError || !authData.user) return next(new Error('Invalid or expired auth token'));
      const user = await withSupabaseClient(client, () =>
        selectOne('users', 'id,email,full_name,avatar_url,status', {
          auth_user_id: authData.user.id,
          status: 'active',
        }),
      );
      if (!user) return next(new Error('Unknown user'));

      socket.data.user = user;
      socket.data.supabaseClient = client;

      // A workspace in the handshake is optional: the client may connect first
      // and switch workspaces later with the `workspace:subscribe` event.
      if (workspaceId) {
        const membership = await withSupabaseClient(client, () =>
          findMembership(user.id, workspaceId),
        );
        if (!membership) return next(new Error('Not a member of that workspace'));
        socket.data.workspaceId = Number(workspaceId);
        socket.data.role = membership.role;
      }

      return next();
    } catch (error) {
      return next(new Error(error.message || 'Socket authentication failed'));
    }
  });

  // --- Connection --------------------------------------------------------
  io.on('connection', (socket) => {
    const { user } = socket.data;
    log.info({ userId: user.id, socketId: socket.id }, 'Socket connected');

    socket.join(rooms.user(user.id));
    if (socket.data.workspaceId) {
      socket.join(rooms.workspace(socket.data.workspaceId));
    }

    /**
     * Client -> server: switch active workspace without reconnecting.
     * Re-validates membership every time, because roles change.
     */
    socket.on('workspace:subscribe', async (payload, ack) => {
      const workspaceId = Number(payload?.workspaceId);
      try {
        const membership = await withSupabaseClient(socket.data.supabaseClient, () =>
          findMembership(user.id, workspaceId),
        );
        if (!membership) throw new Error('Not a member of that workspace');

        // Leave the previous workspace room.
        for (const room of socket.rooms) {
          if (room.startsWith('ws:')) socket.leave(room);
        }
        socket.join(rooms.workspace(workspaceId));
        socket.data.workspaceId = workspaceId;
        socket.data.role = membership.role;

        ack?.({ ok: true, workspaceId, role: membership.role });
        socket.emit(EVENTS.WORKSPACE_SUBSCRIBED, { workspaceId, role: membership.role });
      } catch (error) {
        ack?.({ ok: false, error: error.message });
      }
    });

    /**
     * Client -> server: watch one thread (used to focus the chat pane).
     *
     * Membership of the conversation's WORKSPACE is re-checked here. Without it
     * any authenticated user could join any thread's room by guessing an id and
     * receive another tenant's messages.
     */
    socket.on('conversation:watch', async (payload, ack) => {
      const conversationId = Number(payload?.conversationId);
      const workspaceId = socket.data.workspaceId;
      if (!conversationId || !workspaceId) return;

      const conversation = await withSupabaseClient(socket.data.supabaseClient, () =>
        selectOne('conversations', 'id', { id: conversationId, workspace_id: workspaceId }),
      );
      if (!conversation) {
        log.warn(
          { userId: user.id, conversationId, workspaceId },
          'Refused to join a conversation room the user cannot access',
        );
        ack?.({ ok: false, error: 'Conversation not found' });
        return;
      }

      socket.join(rooms.conversation(conversationId));
      ack?.({ ok: true, conversationId });
    });

    socket.on('conversation:unwatch', (payload) => {
      const conversationId = Number(payload?.conversationId);
      if (conversationId) socket.leave(rooms.conversation(conversationId));
    });

    /**
     * Typing indicators -> relayed to the rest of the thread.
     * Same ownership check as `conversation:watch`.
     */
    socket.on('conversation:typing', async (payload) => {
      const conversationId = Number(payload?.conversationId);
      const workspaceId = socket.data.workspaceId;
      if (!conversationId || !workspaceId) return;

      const conversation = await withSupabaseClient(socket.data.supabaseClient, () =>
        selectOne('conversations', 'id', { id: conversationId, workspace_id: workspaceId }),
      );
      if (!conversation) return;

      socket.to(rooms.conversation(conversationId)).emit(EVENTS.CONVERSATION_TYPING, {
        conversationId,
        userId: user.id,
        name: user.full_name,
        isTyping: Boolean(payload?.isTyping),
      });
    });

    /** Heartbeat used by the frontend to show "live"/"reconnecting". */
    socket.on('ping:check', (ack) => ack?.({ ok: true, at: Date.now() }));

    socket.on('disconnect', (reason) => {
      log.info({ userId: user.id, socketId: socket.id, reason }, 'Socket disconnected');
    });
  });

  log.info('Socket.IO initialised');
  return io;
}

/**
 * Broadcast to every tab viewing a workspace.
 *
 * This is ALSO the single fan-out point for outbound webhooks: every business
 * event in the app is emitted through here, so subscribing to a customer's
 * webhook here is what keeps the two channels in sync without any route having
 * to remember to call both.
 *
 * Webhook dispatch is fire-and-forget and deliberately never awaited - a slow
 * or dead customer endpoint must not delay the HTTP response that caused the
 * event, and a webhook failure must not fail the request.
 */
export function emitToWorkspace(workspaceId, event, payload) {
  const room = rooms.workspace(workspaceId);
  const targetSockets = io?.sockets.adapter.rooms.get(room)?.size ?? 0;
  if (io) {
    io.to(room).emit(event, payload);
    log.info({ workspaceId, room, event, targetSockets }, 'Realtime event emitted');
  } else {
    log.warn({ workspaceId, event }, 'Realtime event not emitted: Socket.IO is not initialized');
  }

  // Imported lazily to avoid a circular import at module load time
  // (webhook.service -> db, crypto; socket.service is imported by events).
  import('./webhook.service.js')
    .then(({ dispatchEvent }) =>
      withSupabaseClient(getAdminClient(), () => dispatchEvent(workspaceId, event, payload)),
    )
    .catch((err) => log.error({ err: err.message, event }, 'webhook dispatch failed'));
}

/** Broadcast to everyone viewing one conversation (sidebar + open chat). */
export function emitToConversation(workspaceId, conversationId, event, payload) {
  if (!io) return;
  io.to(rooms.workspace(workspaceId)).to(rooms.conversation(conversationId)).emit(event, payload);
}

/** Target one user's tabs across every workspace. */
export function emitToUser(userId, event, payload) {
  if (!io) return;
  io.to(rooms.user(userId)).emit(event, payload);
}

/** For tests / graceful shutdown. */
export const getIo = () => io;
export async function closeSocket() {
  if (io) {
    await new Promise((resolve) => io.close(resolve));
    io = null;
    log.info('Socket.IO closed');
  }
}
