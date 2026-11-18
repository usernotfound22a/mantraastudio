/**
 * Facebook Messenger adapter.
 *
 * Talks to the Meta Graph API. All Messenger/Instagram traffic goes through the
 * same `/me/messages` endpoint, but the payload shapes, echo behaviour and
 * conversation-window rules differ - which is exactly why they get their own
 * adapter instead of "a Meta adapter with a flag".
 *
 * Channel config (channels.config JSON):
 *   { pageId, accessToken, verifyToken, appSecret }
 *
 * Docs: https://developers.facebook.com/docs/messenger-platform
 */
import axios from 'axios';
import { BaseAdapter } from './BaseAdapter.js';
import { env } from '../config/env.js';
import { childLogger } from '../config/logger.js';
import { AppError } from '../middleware/error.js';
import { getMetaSettings } from '../services/meta-settings.service.js';

const log = childLogger('adapter:messenger');

/** Meta caps outbound text; longer messages are split by the platform anyway. */
const MAX_TEXT_LENGTH = 2000;
const metaEventDate = (value) => {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return new Date();
  return new Date(timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp);
};

export class MessengerAdapter extends BaseAdapter {
  static type = 'messenger';
  static label = 'Facebook Messenger';
  static description = 'Connect a Facebook Page and answer customers in Messenger.';
  static requiresSignature = true;

  static capabilities = {
    attachments: true,
    readReceipts: true,
    typingIndicator: true,
    proactiveMessaging: true,
    mediaUpload: true,
  };

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  get graphUrl() {
    return `https://graph.facebook.com/${env.META_GRAPH_VERSION}`;
  }

  /** Authenticated GET against the Graph API. */
  async graphGet(path, params = {}) {
    this.requireConfig('accessToken');
    const response = await axios.get(`${this.graphUrl}${path}`, {
      params: { ...params, access_token: this.config.accessToken },
      timeout: 10000,
    });
    return response.data;
  }

  /** Authenticated POST against the Graph API. */
  async graphPost(path, body) {
    this.requireConfig('accessToken');
    const response = await axios.post(
      `${this.graphUrl}${path}`,
      body,
      {
        params: { access_token: this.config.accessToken },
        timeout: 10000,
      },
    );
    return response.data;
  }

  // ---------------------------------------------------------------------
  // REQUIRED contract
  // ---------------------------------------------------------------------

  /**
   * Meta delivers POSTs shaped like:
   *   { object: 'page', entry: [ { id: PAGE_ID, time, messaging: [ ... ] } ] }
   *
   * Each `messaging` entry is one event: an incoming message, a postback, a
   * read receipt, or an echo of a message WE sent. We only turn real inbound
   * messages into normalised payloads and silently drop the rest.
   */
  parseInbound(payload) {
    const results = [];

    for (const entry of payload?.entry ?? []) {
      const pageId = entry.id;

      for (const event of entry.messaging ?? []) {
        // Echoes are our own outbound messages coming back. Storing them would
        // duplicate every reply in the inbox.
        if (event.message?.is_echo) continue;

        // Read receipts / delivery events carry no message body.
        if (!event.message && !event.postback) continue;

        const isPostback = Boolean(event.postback);
        const text = isPostback
          ? event.postback.title || event.postback.payload
          : event.message?.text;

        const attachments = this.normalizeAttachments(event.message?.attachments);

        // Attachments sometimes arrive with no text at all.
        const body =
          text && String(text).trim().length > 0
            ? String(text)
            : attachments.length > 0
              ? BaseAdapter.attachmentPlaceholder(attachments.length)
              : null;

        if (!body) continue;

        results.push({
          externalMessageId: event.message?.mid ?? `postback_${event.timestamp}_${event.sender?.id}`,
          conversationExternalId: event.sender?.id,
          contact: this.normalizeContact({
            senderId: event.sender?.id,
            profile: event.sender,
          }),
          content: {
            text: body,
            attachments,
            quickReplies: (event.message?.quick_replies ?? []).map((reply) => ({
              title: reply.title,
              payload: reply.payload,
              imageUrl: reply.image_url,
            })),
            postbackPayload: event.postback?.payload ?? null,
          },
          timestamp: event.timestamp ? metaEventDate(event.timestamp) : new Date(),
          metadata: {
            channel: 'messenger',
            pageId,
            isPostback,
            referral: event.referral
              ? { source: event.referral.source, ref: event.referral.ref }
              : null,
          },
        });
      }
    }

    log.debug({ events: results.length }, 'Parsed Messenger webhook');
    return results;
  }

  /** Messenger identifies people by PSID (page-scoped id); no name in payload. */
  normalizeContact(raw) {
    const profile = raw?.profile ?? raw ?? {};
    const name = [profile.first_name, profile.last_name].filter(Boolean).join(' ') || null;
    return {
      externalId: raw?.senderId ?? profile.id ?? null,
      name,
      avatarUrl: profile.profile_pic ?? null,
      email: null,
      locale: profile.locale ?? null,
    };
  }

  /**
   * Sends a text (or attachment) message to a PSID.
   *
   * Note on the 24-hour window: outside 24h of the customer's last message Meta
   * requires a `message_tag`. We keep the plain RESPONSE form, which is correct
   * for the reactive support use case SocialHub is built for.
   */
  async sendMessage({ to, body, attachments = [] }) {
    this.requireConfig('accessToken');
    if (!to) throw new Error('sendMessage() requires a recipient PSID');

    const message = {};

    if (body && String(body).trim()) {
      message.text = String(body).slice(0, MAX_TEXT_LENGTH);
    }

    // Messenger takes one attachment per API call.
    const [attachment] = attachments;
    if (attachment?.url) {
      message.attachment = { type: 'image', payload: { url: attachment.url, is_reusable: true } };
    }

    if (!message.text && !message.attachment) {
      throw new Error('sendMessage() needs either a body or an attachment');
    }

    const result = await this.graphPost('/me/messages', {
      recipient: { id: to },
      messaging_type: 'RESPONSE',
      message,
    });

    return { externalId: result.message_id ?? null, status: 'sent', raw: result };
  }

  // ---------------------------------------------------------------------
  // Optional capabilities
  // ---------------------------------------------------------------------

  /**
   * Webhook verification has two distinct jobs:
   *  - the GET handshake (hub.mode / hub.verify_token / hub.challenge)
   *  - the POST signature (X-Hub-Signature-256), which is what actually
   *    authenticates an inbound event
   * Both are implemented here so the webhook route stays channel-agnostic.
   */
  verifyWebhook({ payload, headers = {}, rawBody, query = {} }) {
    // --- 1. GET handshake -------------------------------------------------
    const mode = query['hub.mode'] ?? payload?.hub_mode;
    if (mode) {
      const token = query['hub.verify_token'] ?? payload?.hub_verify_token;
      const challenge = query['hub.challenge'] ?? payload?.hub_challenge;
      const expected = this.config.verifyToken || env.META_VERIFY_TOKEN;
      if (token !== expected) {
        throw AppError.forbidden('Webhook verify token mismatch');
      }
      return { kind: 'handshake', challenge };
    }

    // --- 2. POST signature ------------------------------------------------
    const signature =
      headers['x-hub-signature-256'] ?? headers['X-Hub-Signature-256'] ?? null;
    const secret = this.config.appSecret || getMetaSettings().appSecret;

    if (!signature) throw AppError.forbidden('Missing X-Hub-Signature-256 header');
    if (!secret) {
      // Fail CLOSED in production: an unconfigured server must not accept
      // unauthenticated webhooks. In development we allow it so you can test
      // the pipeline with curl before wiring up a Meta app.
      if (env.isProd) {
        throw AppError.serviceUnavailable(
          'Webhook verification is not configured on this server (META_APP_SECRET is missing)',
        );
      }
      log.warn(
        'META_APP_SECRET is not set - webhook signature NOT verified (development only)',
      );
      return { kind: 'event', verified: false, reason: 'app secret not configured' };
    }
    if (!this.verifySignature(rawBody ?? '', signature, secret)) {
      throw AppError.forbidden('Invalid webhook signature - request rejected');
    }

    return { kind: 'event', verified: true, pageId: payload?.entry?.[0]?.id ?? null };
  }

  /** Shows the "Seen" tick in Messenger. */
  async markAsRead({ to }) {
    try {
      await this.graphPost('/me/messages', {
        recipient: { id: to },
        messaging_type: 'RESPONSE',
        sender_action: 'mark_seen',
      });
      return { supported: true };
    } catch (error) {
      log.warn({ err: error.message }, 'markAsRead failed');
      return { supported: true, error: error.message };
    }
  }

  /** Shows the typing indicator for 20 seconds. */
  async sendTypingIndicator({ to, isTyping = true }) {
    try {
      await this.graphPost('/me/messages', {
        recipient: { id: to },
        messaging_type: 'RESPONSE',
        sender_action: isTyping ? 'typing_on' : 'typing_off',
      });
      return { supported: true };
    } catch {
      return { supported: false };
    }
  }

  /**
   * Resolves the customer's real name/avatar. Messenger webhooks deliberately
   * omit them, so the inbox would show "Unknown" without this.
   */
  async fetchContactProfile(psid) {
    if (!psid) return null;
    try {
      const data = await this.graphGet(`/${psid}`, {
        fields: 'first_name,last_name,profile_pic,locale',
      });
      return this.normalizeContact({
        senderId: data.id,
        profile: { ...data, profile_pic: data.profile_pic },
      });
    } catch (error) {
      log.warn({ psid, err: error.message }, 'Could not fetch Messenger profile');
      return null;
    }
  }

  /** Confirms the page token still works (used by the settings screen). */
  async healthCheck() {
    try {
      const data = await this.graphGet('/me', { fields: 'id,name' });
      return {
        ok: true,
        message: `Connected to page "${data.name}" (${data.id})`,
        pageId: data.id,
      };
    } catch (error) {
      return { ok: false, message: `Token rejected by Meta: ${error.message}` };
    }
  }
}

export default MessengerAdapter;
