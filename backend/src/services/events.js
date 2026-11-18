/**
 * The real-time event catalogue - the single source of truth for every
 * Socket.IO event name in the project.
 *
 * Why a constant instead of string literals: a typo in an event name fails
 * silently (the emitter logs a broadcast, the listener never fires, and the UI
 * just looks broken). Centralising the names means the emitter and the listener
 * cannot drift, and `scripts/routes.js` can assert that every event the server
 * emits is documented here.
 *
 * The frontend mirrors these names in `frontend/src/lib/realtime.js`. This
 * file is the contract between the two halves of the project.
 */
export const EVENTS = {
  // --- Connection / presence ---------------------------------------------
  WORKSPACE_SUBSCRIBED: 'workspace:subscribed',
  CONVERSATION_TYPING: 'conversation:typing',

  // --- Inbox ------------------------------------------------------------
  /** A thread was created or arrived from a channel. */
  CONVERSATION_UPSERTED: 'conversation:upserted',
  /** A thread changed in any way (status, assignment, handover, counters). */
  CONVERSATION_UPDATED: 'conversation:updated',
  /**
   * The assignee changed. Separate from CONVERSATION_UPDATED because the inbox
   * sidebar has to move the row between "mine" and "unassigned" filters without
   * refetching the whole list.
   */
  CONVERSATION_ASSIGNED: 'conversation:assigned',
  /** Someone read the thread, so other tabs can clear the unread badge. */
  CONVERSATION_READ: 'conversation:read',
  /** The AI stepped aside and a human is needed. */
  CONVERSATION_HANDOVER: 'conversation:handover',

  // --- Messages ---------------------------------------------------------
  /** A message was stored, in either direction. */
  MESSAGE_NEW: 'message:new',
  /** A send failed and can be retried. */
  MESSAGE_FAILED: 'message:failed',
  /** A delivery receipt arrived from a channel. */
  MESSAGE_DELIVERED: 'message:delivered',

  // --- Notes ------------------------------------------------------------
  NOTE_CREATED: 'note:created',
  NOTE_UPDATED: 'note:updated',
  NOTE_DELETED: 'note:deleted',

  // --- Channels ---------------------------------------------------------
  CHANNEL_CREATED: 'channel:created',
  CHANNEL_UPDATED: 'channel:updated',
  CHANNEL_DELETED: 'channel:deleted',

  // --- Knowledge base ---------------------------------------------------
  FAQ_CREATED: 'faq:created',
  FAQ_UPDATED: 'faq:updated',
  FAQ_DELETED: 'faq:deleted',

  // --- Workspace / team -------------------------------------------------
  MEMBER_ADDED: 'workspace:member_added',
  MEMBER_REMOVED: 'workspace:member_removed',
  MEMBER_UPDATED: 'workspace:member_updated',
  WORKSPACE_UPDATED: 'workspace:updated',

  // --- Billing ----------------------------------------------------------
  SUBSCRIPTION_UPDATED: 'billing:subscription_updated',

  // --- Widget (public side) ---------------------------------------------
  WIDGET_TYPING: 'widget:typing',
};

/** Human-readable catalogue, rendered by `npm run routes` for the report. */
export const EVENT_CATALOGUE = [
  { event: EVENTS.CONVERSATION_UPSERTED, direction: 'server -> client', purpose: 'New or re-found thread' },
  { event: EVENTS.CONVERSATION_UPDATED, direction: 'server -> client', purpose: 'Status, assignment, unread or handover changed' },
  { event: EVENTS.CONVERSATION_ASSIGNED, direction: 'server -> client', purpose: 'Thread moved between agents' },
  { event: EVENTS.CONVERSATION_READ, direction: 'server -> client', purpose: 'Thread read elsewhere' },
  { event: EVENTS.CONVERSATION_HANDOVER, direction: 'server -> client', purpose: 'AI asked for a human' },
  { event: EVENTS.MESSAGE_NEW, direction: 'server -> client', purpose: 'Message stored (inbound or outbound)' },
  { event: EVENTS.MESSAGE_FAILED, direction: 'server -> client', purpose: 'Outbound send failed' },
  { event: EVENTS.MESSAGE_DELIVERED, direction: 'server -> client', purpose: 'Channel confirmed delivery' },
  { event: EVENTS.CONVERSATION_TYPING, direction: 'both', purpose: 'Agent typing indicator' },
  { event: EVENTS.NOTE_CREATED, direction: 'server -> client', purpose: 'Internal note added' },
  { event: EVENTS.NOTE_UPDATED, direction: 'server -> client', purpose: 'Internal note edited' },
  { event: EVENTS.NOTE_DELETED, direction: 'server -> client', purpose: 'Internal note removed' },
  { event: EVENTS.CHANNEL_CREATED, direction: 'server -> client', purpose: 'Channel connected' },
  { event: EVENTS.CHANNEL_UPDATED, direction: 'server -> client', purpose: 'Channel settings or status changed' },
  { event: EVENTS.CHANNEL_DELETED, direction: 'server -> client', purpose: 'Channel removed' },
  { event: EVENTS.FAQ_CREATED, direction: 'server -> client', purpose: 'FAQ entry added' },
  { event: EVENTS.FAQ_UPDATED, direction: 'server -> client', purpose: 'FAQ entry edited' },
  { event: EVENTS.FAQ_DELETED, direction: 'server -> client', purpose: 'FAQ entry removed or archived' },
  { event: EVENTS.MEMBER_ADDED, direction: 'server -> client', purpose: 'Teammate joined' },
  { event: EVENTS.MEMBER_UPDATED, direction: 'server -> client', purpose: 'Teammate role or status changed' },
  { event: EVENTS.MEMBER_REMOVED, direction: 'server -> client', purpose: 'Teammate removed' },
  { event: EVENTS.WORKSPACE_UPDATED, direction: 'server -> client', purpose: 'Workspace settings changed' },
  { event: EVENTS.WORKSPACE_SUBSCRIBED, direction: 'server -> client', purpose: 'Switched active workspace' },
  { event: EVENTS.SUBSCRIPTION_UPDATED, direction: 'server -> client', purpose: 'Plan or usage changed' },
  { event: EVENTS.WIDGET_TYPING, direction: 'server -> client', purpose: 'Agent typing, seen by the widget' },
];

export default EVENTS;
