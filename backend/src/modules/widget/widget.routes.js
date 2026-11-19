/**
 * Public website-widget API.
 *
 * Used by the embeddable chat bubble on a customer's own website, so it is
 * UNAUTHENTICATED. Two things replace a login here:
 *   1. `widgetKey` - an unguessable public id that resolves to exactly one
 *      channel + workspace (a rotated key is a full revoke).
 *   2. `visitorId` - a random id the widget stores in localStorage, which
 *      scopes a visitor to their own conversation.
 *
 * The optional `allowedDomains` config on the channel is checked as well, so a
 * leaked widget key cannot be embedded on someone else's site.
 *
 *   GET  /api/widget/config?key=...     bootstrap the bubble
 *   POST /api/widget/messages            customer sends a message
 *   GET  /api/widget/messages            customer polls for agent replies
 *   POST /api/widget/typing              "visitor is typing" -> agent UI
 *
 * Mounted at /api/widget
 */
import { Router } from 'express';
import { z } from 'zod';
import { queryOf, validate } from '../../middleware/validate.js';
import { AppError, asyncHandler } from '../../middleware/error.js';
import { publicLimiter } from '../../middleware/rateLimit.js';
import { callRpc } from '../../db/supabase.js';
import { createAdapterForChannel } from '../../adapters/index.js';
import { findWebsiteChannelByWidgetKey } from '../../services/channels.service.js';
import { ingestInboundMessage, mapMessage } from '../../services/conversation.service.js';
import { maybeAutoReply } from '../../services/ai.service.js';
import { emitToWorkspace } from '../../services/socket.service.js';
import { EVENTS } from '../../services/events.js';

const router = Router();

// The widget is public: cap volume per IP so the endpoint cannot be used as a
// free message relay for spammers.
router.use(publicLimiter);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const widgetKeyQuery = z.object({
  key: z.string().trim().min(8, 'Missing widget key'),
});

const sendMessageSchema = {
  body: z.object({
    widgetKey: z.string().trim().min(8),
    visitorId: z.string().trim().min(6).max(100),
    message: z.string().trim().min(1, 'Type a message first').max(4000),
    name: z.string().trim().max(120).optional(),
    email: z.string().trim().toLowerCase().email('Enter a valid email').optional(),
    locale: z.string().max(16).optional(),
    attachments: z
      .array(
        z.object({
          url: z.string().url(),
          name: z.string().max(255).optional(),
          mimeType: z.string().max(120).optional(),
          size: z.number().int().nonnegative().optional(),
        }),
      )
      .max(4, 'Too many attachments')
      .optional(),
    pageUrl: z.string().max(500).optional(),
    referrer: z.string().max(500).optional(),
  }),
};

const pollSchema = {
  query: z.object({
    key: z.string().trim().min(8),
    visitorId: z.string().trim().min(6).max(100),
    // Keyset pagination on message id: cheap and never repeats a message.
    afterId: z.coerce.number().int().nonnegative().optional(),
  }),
};

const typingSchema = {
  body: z.object({
    widgetKey: z.string().trim().min(8),
    visitorId: z.string().trim().min(6).max(100),
    isTyping: z.boolean().default(false),
  }),
};

/**
 * Resolves + validates a widget key and returns the channel row.
 * This is the single gatekeeper for every public widget route.
 */
async function resolveWidget({ widgetKey, headers }) {
  const channel = await findWebsiteChannelByWidgetKey(widgetKey);
  if (!channel || channel.status !== 'connected') {
    // Deliberately vague: a wrong key must not reveal that a workspace exists.
    throw AppError.notFound('This chat widget is not available');
  }

  // The adapter's own allow-list check (origin vs allowedDomains).
  const adapter = createAdapterForChannel(channel, { id: channel.workspace_id });
  adapter.verifyWebhook({ headers });

  return { channel, adapter, workspace: { id: channel.workspace_id } };
}

// ---------------------------------------------------------------------------
// GET /api/widget/config - everything the bubble needs to render itself.
// ---------------------------------------------------------------------------
router.get(
  '/config',
  validate({ query: widgetKeyQuery }),
  asyncHandler(async (req, res) => {
    const { channel } = await resolveWidget({
      widgetKey: queryOf(req).key,
      headers: req.headers,
    });

    const config = channel.config ?? {};
    res.json({
      channelId: channel.id,
      workspaceId: channel.workspace_id,
      companyName: config.companyName ?? null,
      greeting: config.greeting ?? 'Hi! How can we help?',
      themeColor: config.themeColor ?? '#4f46e5',
      placeholder: config.placeholder ?? 'Type your message...',
      requireName: config.requireName ?? true,
      collectEmail: config.collectEmail ?? false,
      aiEnabled: config.aiEnabled ?? true,
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/widget/messages - the customer sends a message.
// ---------------------------------------------------------------------------
router.post(
  '/messages',
  validate(sendMessageSchema),
  asyncHandler(async (req, res) => {
    const { widgetKey, visitorId, message, attachments = [], ...visitor } = req.body;
    const { channel, adapter, workspace } = await resolveWidget({
      widgetKey,
      headers: req.headers,
    });

    // The website adapter turns this into the same NormalizedInbound shape the
    // Meta adapters produce - which is why the rest of this handler is generic.
    const [normalised] = adapter.parseInbound({
      visitorId,
      name: visitor.name,
      email: visitor.email,
      locale: visitor.locale,
      message,
      attachments,
      pageUrl: visitor.pageUrl,
      referrer: visitor.referrer,
      userAgent: req.headers['user-agent'] ?? null,
    });

    const { conversation, message: stored, duplicate } = await ingestInboundMessage({
      channel,
      payload: normalised,
    });

    if (duplicate) {
      return res.status(200).json({ duplicate: true, conversationId: conversation.id });
    }

    // Let the assistant try to answer straight away (Part 7 fills this in).
    const aiResult = await maybeAutoReply({
      conversation,
      message: stored,
      channel,
      workspace,
    });

    res.status(201).json({
      conversationId: conversation.id,
      message: mapMessage(stored),
      ai: { action: aiResult.action, reply: aiResult.message ?? null },
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/widget/messages - poll for agent replies.
//
// Why polling instead of a socket? The agent side already uses Socket.IO, but
// the visitor's browser often sits behind aggressive corporate proxies and
// corporate VPNs break long-lived websockets. Polling every 3s is one cheap
// request and always works. Swap in a public Socket.IO namespace later if you
// want instant delivery - the payload shape would not change.
// ---------------------------------------------------------------------------
router.get(
  '/messages',
  validate(pollSchema),
  asyncHandler(async (req, res) => {
    const { key, visitorId, afterId } = queryOf(req);
    const { channel } = await resolveWidget({ widgetKey: key, headers: req.headers });

    // Scoped to this visitor's own conversation: a visitor can never read
    // someone else's thread.
    const rows = await callRpc('poll_widget_messages', {
      p_widget_key: key,
      p_visitor_id: visitorId,
      p_after_id: afterId ?? 0,
    });

    res.json({
      messages: rows.map(mapMessage),
      lastId: rows.length ? rows[rows.length - 1].id : (afterId ?? 0),
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/widget/typing - shows "typing..." in the agent's chat view.
// ---------------------------------------------------------------------------
router.post(
  '/typing',
  validate(typingSchema),
  asyncHandler(async (req, res) => {
    const { widgetKey, visitorId, isTyping } = req.body;
    const { channel } = await resolveWidget({ widgetKey, headers: req.headers });

    // The agent's UI listens on the workspace room, so the visitor's state can
    // be broadcast without the visitor ever joining a socket room.
    emitToWorkspace(channel.workspace_id, EVENTS.WIDGET_TYPING, {
      visitorId,
      isTyping,
    });

    res.json({ ok: true });
  }),
);

export default router;
