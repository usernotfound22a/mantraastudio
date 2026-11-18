/**
 * Webhook routes - the proof that the Adapter Pattern works.
 *
 * READ THIS FILE: there is not a single `if (channel === 'messenger')` in it.
 * The route knows only the shape of the pipeline:
 *
 *     1. ask a "detector" adapter to verify the signature (app-level secret)
 *     2. ask the same detector which account sent this payload
 *     3. look up the connected channel row for that account
 *     4. build the real adapter for that channel
 *     5. adapter.parseInbound()   -> normalise every message
 *     6. hand each normalised message to the conversation service
 *
 * Adding a channel means writing ONE adapter file. This file never changes.
 *
 *   GET  /api/webhooks/:channelType   Meta subscription handshake
 *   POST /api/webhooks/:channelType   inbound events
 *
 * Auth: none from the user's side. Authenticity comes from
 * `adapter.verifyWebhook()` (HMAC signature / verify token).
 */
import express, { Router } from 'express';
import {
  getAdapterClass,
  listAdapterTypes,
  createAdapterForType,
  createAdapterForChannel,
} from '../../adapters/index.js';
import { findChannelByExternalId } from '../../services/channels.service.js';
import { ingestInboundMessage } from '../../services/conversation.service.js';
import { maybeAutoReply } from '../../services/ai.service.js';
import { AppError, asyncHandler } from '../../middleware/error.js';
import { env } from '../../config/env.js';
import { childLogger } from '../../config/logger.js';
import { getMetaSettings } from '../../services/meta-settings.service.js';

const log = childLogger('webhooks');

const router = Router();

/**
 * Meta signs the body, so we need the EXACT bytes - not the parsed object.
 * This router is mounted BEFORE the global express.json() parser in app.js and
 * applies its own raw parser here.
 */
router.use(express.raw({ type: 'application/json', limit: '5mb' }));

/** Parses the raw body, tolerating a driver that already parsed it. */
function readPayload(req) {
  if (Buffer.isBuffer(req.body)) {
    try {
      return { payload: JSON.parse(req.body.toString('utf8')), rawBody: req.body };
    } catch {
      return { payload: null, rawBody: req.body };
    }
  }
  // Already parsed (e.g. a test harness posted a different content type).
  return { payload: req.body ?? null, rawBody: Buffer.from(JSON.stringify(req.body ?? {})) };
}

/** 404 for an unknown channel type - tells the developer, not the customer. */
function requireAdapterClass(req, res, next) {
  const AdapterClass = getAdapterClass(req.params.channelType);
  if (!AdapterClass) {
    return next(
      new AppError(
        `No adapter registered for channel type "${req.params.channelType}". ` +
          `Available: ${listAdapterTypes().join(', ')}`,
        404,
        'UNKNOWN_CHANNEL',
      ),
    );
  }
  req.AdapterClass = AdapterClass;
  return next();
}

// ---------------------------------------------------------------------------
// GET - Meta verifies your webhook URL when you save it in the App Dashboard.
// The response body must be the challenge token, verbatim, as text/plain.
// ---------------------------------------------------------------------------
router.get(
  '/:channelType',
  requireAdapterClass,
  asyncHandler(async (req, res) => {
    // The handshake happens BEFORE any channel is connected, so verification
    // falls back to the app-level token in the environment.
      log.info({ requestId: req.id, channelType: req.params.channelType }, 'Webhook verification requested');
    const detector = createAdapterForType(req.params.channelType);
    const { payload } = readPayload(req);

    const result = detector.verifyWebhook({
      payload,
      headers: req.headers,
      rawBody: null,
      query: req.query,
    });

    log.info({ channelType: req.params.channelType }, 'Webhook handshake verified');
    res.type('text/plain').send(result.challenge);
  }),
);

// ---------------------------------------------------------------------------
// POST - real inbound events.
// ---------------------------------------------------------------------------
router.post(
  '/:channelType',
  requireAdapterClass,
  asyncHandler(async (req, res) => {
    const { channelType } = req.params;
    log.info(
      {
        requestId: req.id,
        channelType,
        contentType: req.get('content-type'),
        contentLength: Number(req.get('content-length')) || 0,
        signaturePresent: Boolean(req.get('x-hub-signature-256')),
      },
      'Inbound webhook received',
    );
    const { payload, rawBody } = readPayload(req);

    if (!payload) {
      // Malformed JSON: answer 200 so Meta stops retrying a payload we can
      // never parse, but log it loudly.
      log.error({ channelType }, 'Webhook body was not valid JSON');
      return res.sendStatus(200);
    }

    // --- Step 1: authenticate BEFORE touching the database ---------------
    // Verified against the APP-level secret (the detector has no channel, so
    // it uses META_APP_SECRET). Doing this first means an unauthenticated
    // request can never reach the DB or the message pipeline.
    const detector = createAdapterForType(channelType);
    try {
      detector.verifyWebhook({ payload, headers: req.headers, rawBody, query: req.query });
    } catch (error) {
      log.warn({ channelType, err: error.message }, 'Webhook rejected before processing');
      return res.status(403).json({ error: { code: 'INVALID_SIGNATURE', message: error.message } });
    }
    log.info({ requestId: req.id, channelType }, 'Webhook signature verified');

    // --- Step 2: which account is this? ---------------------------------
    // The detector has no channel row, so it can only read the account id.
    const accountId = detector.resolveAccountId(payload);
    log.info({ requestId: req.id, channelType, accountId }, 'Webhook account resolved');

    // --- Step 3: find the connected channel ------------------------------
    const channel = accountId ? await findChannelByExternalId(channelType, accountId) : null;

    if (!channel) {
      // Return 200 ON PURPOSE. A 4xx makes Meta retry the same event for days,
      // and it can never succeed until someone connects that page.
      log.warn(
        { channelType, accountId },
        'No connected channel for this account - event ignored (connect it in Settings)',
      );
      return res.sendStatus(200);
    }
    if (channel.status === 'disconnected') {
      log.warn({ channelId: channel.id }, 'Event for a disconnected channel - ignored');
      return res.sendStatus(200);
    }

    const workspace = { id: channel.workspace_id };

    // --- Step 4: the real, fully-configured adapter ---------------------
    const adapter = createAdapterForChannel(channel, workspace);

    // Re-verify only if this channel overrides the app secret (a workspace
    // running its own Meta app). Otherwise step 1 already proved authenticity.
    if (channel.config?.appSecret && channel.config.appSecret !== getMetaSettings().appSecret) {
      try {
        adapter.verifyWebhook({ payload, headers: req.headers, rawBody, query: req.query });
      } catch (error) {
        log.warn({ channelType, channelId: channel.id, err: error.message }, 'Channel signature rejected');
        return res.status(403).json({ error: { code: 'INVALID_SIGNATURE', message: error.message } });
      }
    }

    // --- Step 5: normalise ---------------------------------------------
    const inboundMessages = adapter.parseInbound(payload);
    log.info(
      { requestId: req.id, channelType, channelId: channel.id, messageCount: inboundMessages.length },
      'Inbound webhook parsed',
    );

    if (inboundMessages.length === 0) {
      log.debug({ channelType, channelId: channel.id }, 'No inbound messages in this event');
      return res.sendStatus(200);
    }

    // --- Step 6: persist, enrich, then let the AI answer ----------------
    const results = [];

    for (const normalised of inboundMessages) {
      try {
        // Meta webhooks omit the customer's name/avatar, so the inbox would
        // show "Unknown customer". One profile lookup fixes it.
        if (!normalised.contact?.name && typeof adapter.fetchContactProfile === 'function') {
          const profile = await adapter
            .fetchContactProfile(normalised.contact?.externalId)
            .catch(() => null);
          if (profile?.name) {
            normalised.contact.name = profile.name;
            normalised.contact.avatarUrl = profile.avatarUrl;
          }
        }

        const { conversation, message, duplicate } = await ingestInboundMessage({
          channel,
          payload: normalised,
        });

        if (duplicate) {
          log.info(
            { requestId: req.id, channelType, channelId: channel.id, conversationId: conversation?.id },
            'Duplicate inbound message ignored',
          );
          results.push({ conversationId: conversation?.id, duplicate: true });
          continue;
        }

        // The AI runs AFTER persistence and its failures are swallowed inside
        // maybeAutoReply, so a slow model never delays the inbox.
        const aiResult = await maybeAutoReply({ conversation, message, channel, workspace });
        log.info(
          { requestId: req.id, channelType, conversationId: conversation.id, action: aiResult.action },
          'Inbound message processing completed',
        );

        results.push({ conversationId: conversation.id, ai: aiResult.action });
      } catch (error) {
        // One bad message must not lose the rest of the batch.
        log.error(
          { channelType, channelId: channel.id, err: error.message },
          'Failed to process inbound message',
        );
        results.push({ error: error.message });
      }
    }

    log.info(
      { channelType, channelId: channel.id, received: inboundMessages.length, processed: results.length },
      'Webhook processed',
    );
    return res.sendStatus(200);
  }),
);

export default router;
