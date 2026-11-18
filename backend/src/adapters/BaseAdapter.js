/**
 * BaseAdapter - the contract every channel must implement.
 *
 * WHY THIS EXISTS
 * ---------------
 * Messenger, Instagram and the website widget deliver completely different
 * payloads and require completely different HTTP calls. Without a shared
 * contract, that difference leaks into:
 *   - the webhook routes        (if/else on channel type)
 *   - the inbox UI              (a switch statement per message)
 *   - the AI service            (which field holds the text?)
 *   - the analytics queries     (one column per channel)
 *
 * Instead, every channel is reduced to ONE normalised shape at the boundary.
 * Downstream code (conversations, messages, AI, sockets, analytics) only ever
 * sees that shape. The result: adding WhatsApp/Telegram/WhatsApp Business
 * means creating ONE new file and touching nothing else.
 *
 * The three methods an adapter MUST implement:
 *   1. parseInbound(payload)      -> normalised inbound message(s)
 *   2. normalizeContact(raw)      -> { externalId, name, avatarUrl, ... }
 *   3. sendMessage(message)       -> { externalId, status }
 *
 * Everything else is optional and already has a safe default.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../middleware/error.js';

export class BaseAdapter {
  // --- Static identity (read by the registry, never by instance code) ----

  /** Machine key stored in `channels.type`. */
  static type = 'base';

  /** Human name shown in the UI. */
  static label = 'Base channel';

  /** Shown in the "connect channel" screen. */
  static description = '';

  /** Capability flags - the UI hides features the channel cannot support. */
  static capabilities = {
    attachments: false,
    readReceipts: false,
    typingIndicator: false,
    proactiveMessaging: false,
    mediaUpload: false,
  };

  /**
   * Does this channel need Meta to sign the webhook body?
   * Website channels do not (there is no third party in the middle).
   */
  static requiresSignature = false;

  constructor({ channel, workspace } = {}) {
    // Guard against `new BaseAdapter()` - it cannot function.
    if (new.target === BaseAdapter) {
      throw new TypeError('BaseAdapter is abstract. Use one of the concrete adapters.');
    }
    this.channel = channel;
    this.workspace = workspace;
    this.config = channel?.config ?? {};
  }

  get channelId() {
    return this.channel?.id ?? null;
  }

  get workspaceId() {
    return this.channel?.workspace_id ?? this.workspace?.id ?? null;
  }

  // =======================================================================
  // REQUIRED contract
  // =======================================================================

  /**
   * Turns a raw channel payload into zero or more normalised inbound messages.
   * @returns {Array<NormalizedInbound>}
   *
   * @typedef {Object} NormalizedInbound
   * @property {string}   externalMessageId        channel-side message id
   * @property {string}   conversationExternalId   stable thread id for this contact
   * @property {Object}   contact                 { externalId, name, avatarUrl, email, locale }
   * @property {{text: string|null, attachments: Array, quickReplies: Array}} content
   * @property {Date}     timestamp
   * @property {Object}   metadata                channel-specific extras
   */
  // eslint-disable-next-line no-unused-vars
  parseInbound(payload) {
    throw new Error(`${this.constructor.name} must implement parseInbound()`);
  }

  /**
   * Maps a channel-specific contact/user object onto our internal contact shape.
   * @returns {{externalId: string, name: string|null, avatarUrl: string|null, email: string|null, locale: string|null}}
   */
  // eslint-disable-next-line no-unused-vars
  normalizeContact(raw) {
    throw new Error(`${this.constructor.name} must implement normalizeContact()`);
  }

  /**
   * Delivers an outbound message to the customer.
   * @param {{to: string, body: string, attachments?: Array, conversation?: Object}} message
   *        `to` is the contact's channel-side id (PSID / IGID / visitorId).
   * @returns {Promise<{externalId: string|null, status: 'sent'|'queued'|'failed', raw?: Object}>}
   */
  // eslint-disable-next-line no-unused-vars
  async sendMessage(message) {
    throw new Error(`${this.constructor.name} must implement sendMessage()`);
  }

  // =======================================================================
  // OPTIONAL capabilities - override where the channel supports them
  // =======================================================================

  /**
   * Verifies an inbound webhook request.
   * Return the channel identity when the request is legitimate, or throw.
   * Channels with `requiresSignature = true` must override `verifySignature`.
   */
  // eslint-disable-next-line no-unused-vars
  verifyWebhook({ payload, headers, rawBody }) {
    return { verified: true };
  }

  /**
   * HMAC-SHA256 signature check (Meta sends `X-Hub-Signature-256`).
   * Uses a constant-time compare so the check cannot be timed out.
   */
  verifySignature(rawBody, signatureHeader, secret) {
    if (!signatureHeader || !secret) return false;
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    const expectedBuffer = Buffer.from(expected);
    const receivedBuffer = Buffer.from(signatureHeader);
    return (
      expectedBuffer.length === receivedBuffer.length &&
      timingSafeEqual(expectedBuffer, receivedBuffer)
    );
  }

  /**
   * Extracts the remote ACCOUNT id from a raw webhook payload.
   *
   * This exists to break a chicken-and-egg problem in the webhook route:
   *   - to verify a signature we need the channel's credentials...
   *   - ...but we only know which channel a payload belongs to AFTER reading
   *     the account id out of it.
   * So we build a "detector" adapter (type only, no channel row), ask it for
   * the account id, look the channel up, and only then build the real,
   * fully-configured adapter.
   *
   * @returns {string|null} the value that matches `channels.external_id`
   */
  // eslint-disable-next-line no-unused-vars
  resolveAccountId(payload) {
    // Both Meta channels identify the account at entry[0].id.
    return payload?.entry?.[0]?.id ?? null;
  }

  /** Marks a thread as read. Channels without read receipts return "unsupported". */
  async markAsRead() {
    return { supported: false };
  }

  /**
   * Fetches a live profile (name/avatar) from the remote API.
   * Used on first contact so the inbox shows a real name, not "Unknown".
   */
  async fetchContactProfile() {
    return null;
  }

  /**
   * Threads-per-contact. Most channels are 1:1 (one thread per customer);
   * override for channels that support shared/group threads.
   */
  buildConversationExternalId(contactExternalId) {
    return contactExternalId;
  }

  /** Connector health for the settings screen ("Reconnect this page?"). */
  async healthCheck() {
    return { ok: true, message: 'No external service to contact' };
  }

  /** Frontend-facing description of this channel instance. */
  describe() {
    return {
      type: this.constructor.type,
      label: this.constructor.label,
      channelId: this.channelId,
      name: this.channel?.name,
      status: this.channel?.status,
      capabilities: { ...this.constructor.capabilities },
      config: this.publicConfig(),
    };
  }

  /** Channel config WITHOUT secrets - never send tokens to the browser. */
  publicConfig() {
    const { accessToken, appSecret, verifyToken, ...safe } = this.config;
    return safe;
  }

  // =======================================================================
  // Shared helpers for subclasses
  // =======================================================================

  /** Normalised attachment list. Every adapter funnels through this. */
  normalizeAttachments(rawAttachments = []) {
    if (!Array.isArray(rawAttachments)) return [];
    return rawAttachments
      .map((attachment) => ({
        url: attachment.url ?? attachment.payload?.url ?? null,
        name: attachment.name ?? null,
        mimeType: attachment.mimeType ?? attachment.mime_type ?? attachment.type ?? null,
        size: attachment.size ?? attachment.file_size ?? null,
        width: attachment.width ?? null,
        height: attachment.height ?? null,
      }))
      .filter((attachment) => attachment.url);
  }

  /** Consistent "no text but here are the attachments" placeholder. */
  static attachmentPlaceholder(count = 1) {
    return `Sent ${count} attachment${count === 1 ? '' : 's'}`;
  }

  /** Fails fast when a channel row is missing the credentials it needs. */
  requireConfig(...keys) {
    const missing = keys.filter((key) => !this.config[key]);
    if (missing.length) {
      throw AppError.serviceUnavailable(
        `Channel "${this.channel?.name}" is not configured (missing: ${missing.join(', ')}). Reconnect it in Settings.`,
      );
    }
    return true;
  }
}

export default BaseAdapter;
