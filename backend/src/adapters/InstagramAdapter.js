/**
 * Instagram Messaging adapter.
 *
 * Instagram looks similar to Messenger because both ride on the same Meta
 * messaging infrastructure, but the differences are real and are exactly what
 * an adapter is for:
 *
 *   - Contacts are IGIDs, not PSIDs.
 *   - Profile fields differ (`name`, `username`, `profile_pic_url`).
 *   - Instagram ECHOES our own outbound messages back to the webhook, and those
 *     must be filtered out or every reply is duplicated in the inbox.
 *   - Ads/referral payloads are common (IG is mostly ad traffic).
 *   - No read receipts or typing indicators.
 *   - Reaches the API through the Page token with an
 *     `instagram_business_account` edge, not `/me`.
 *
 * Channel config (channels.config JSON):
 *   { instagramUserId, pageId, accessToken, verifyToken, appSecret }
 */
import axios from 'axios';
import { BaseAdapter } from './BaseAdapter.js';
import { env } from '../config/env.js';
import { childLogger } from '../config/logger.js';
import { AppError } from '../middleware/error.js';
import { getMetaSettings } from '../services/meta-settings.service.js';

const log = childLogger('adapter:instagram');

/** Instagram messaging is a request/response channel: keep replies short. */
const MAX_TEXT_LENGTH = 1000;
const metaEventDate = (value) => {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return new Date();
  return new Date(timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp);
};

export class InstagramAdapter extends BaseAdapter {
  static type = 'instagram';
  static label = 'Instagram';
  static description = 'Reply to DMs from a professional Instagram account.';
  static requiresSignature = true;

  static capabilities = {
    attachments: true,
    readReceipts: false,
    typingIndicator: false,
    proactiveMessaging: true,
    mediaUpload: false,
  };

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  get graphUrl() {
    return `https://graph.facebook.com/${env.META_GRAPH_VERSION}`;
  }

  async graphGet(path, params = {}) {
    this.requireConfig('accessToken');
    const response = await axios.get(`${this.graphUrl}${path}`, {
      params: { ...params, access_token: this.config.accessToken },
      timeout: 10000,
    });
    return response.data;
  }

  async graphPost(path, body) {
    this.requireConfig('accessToken');
    const response = await axios.post(`${this.graphUrl}${path}`, body, {
      params: { access_token: this.config.accessToken },
      timeout: 10000,
    });
    return response.data;
  }

  /**
   * IG sending is addressed to the IG business account rather than the page.
   * We reuse the channel's stored `pageId` when present.
   */
  get senderId() {
    return this.config.pageId || 'me';
  }

  // ---------------------------------------------------------------------
  // REQUIRED contract
  // ---------------------------------------------------------------------

  parseInbound(payload) {
    const results = [];

    for (const entry of payload?.entry ?? []) {
      // The `instagram` object carries the account id on some payload versions.
      const accountId = this.config.instagramUserId ?? entry.instagram?.id ?? null;

      for (const event of entry.messaging ?? []) {
        // >>> The big one: Instagram echoes our own messages back to us. <<<
        if (event.message?.is_echo) continue;
        if (!event.message && !event.postback) continue;

        const isPostback = Boolean(event.postback);
        const text = isPostback
          ? event.postback.title || event.postback.payload
          : event.message?.text;

        const attachments = this.normalizeAttachments(event.message?.attachments);
        const body =
          text && String(text).trim().length > 0
            ? String(text)
            : attachments.length > 0
              ? BaseAdapter.attachmentPlaceholder(attachments.length)
              : null;

        if (!body) continue;

        results.push({
          externalMessageId:
            event.message?.mid ?? `ig_postback_${event.timestamp}_${event.sender?.id}`,
          conversationExternalId: event.sender?.id,
          contact: this.normalizeContact({ senderId: event.sender?.id, profile: event.sender }),
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
            channel: 'instagram',
            accountId,
            isPostback,
            // IG traffic very often arrives from an ad - worth surfacing in
            // analytics ("which campaign drives DMs?").
            referral: event.referral
              ? {
                  source: event.referral.source,
                  ref: event.referral.ref,
                  ads: event.referral.ads ?? null,
                }
              : null,
          },
        });
      }
    }

    log.debug({ events: results.length }, 'Parsed Instagram webhook');
    return results;
  }

  normalizeContact(raw) {
    const profile = raw?.profile ?? raw ?? {};
    return {
      externalId: raw?.senderId ?? profile.id ?? null,
      name: profile.name ?? null,
      avatarUrl: profile.profile_pic ?? profile.profile_pic_url ?? null,
      email: null,
      locale: null,
    };
  }

  /**
   * Instagram's account id lives on `entry[].instagram.id` in newer payload
   * versions; `channels.external_id` stores exactly that value.
   */
  resolveAccountId(payload) {
    return (
      this.config.instagramUserId ??
      payload?.entry?.[0]?.instagram?.id ??
      payload?.entry?.[0]?.id ??
      null
    );
  }

  async sendMessage({ to, body, attachments = [] }) {
    this.requireConfig('accessToken', 'instagramUserId');
    if (!to) throw new Error('sendMessage() requires a recipient IGID');

    const message = {};
    if (body && String(body).trim()) {
      message.text = String(body).slice(0, MAX_TEXT_LENGTH);
    }

    const [attachment] = attachments;
    if (attachment?.url) {
      // Instagram only accepts image URLs for attachments in DMs.
      message.attachment = { type: 'image', payload: { url: attachment.url } };
    }

    if (!message.text && !message.attachment) {
      throw new Error('sendMessage() needs either a body or an attachment');
    }

    const result = await this.graphPost(`/${this.senderId}/messages`, {
      recipient: { id: to },
      messaging_type: 'RESPONSE',
      message,
    });

    return { externalId: result.message_id ?? null, status: 'sent', raw: result };
  }

  // ---------------------------------------------------------------------
  // Optional capabilities
  // ---------------------------------------------------------------------

  verifyWebhook({ payload, headers = {}, rawBody, query = {} }) {
    const mode = query['hub.mode'] ?? payload?.hub_mode;
    if (mode) {
      const token = query['hub.verify_token'] ?? payload?.hub_verify_token;
      const challenge = query['hub.challenge'] ?? payload?.hub_challenge;
      const expected = this.config.verifyToken || env.META_VERIFY_TOKEN;
      if (token !== expected) throw AppError.forbidden('Webhook verify token mismatch');
      return { kind: 'handshake', challenge };
    }

    const signature = headers['x-hub-signature-256'] ?? headers['X-Hub-Signature-256'] ?? null;
    const secret = this.config.appSecret || getMetaSettings().appSecret;

    if (!signature) throw AppError.forbidden('Missing X-Hub-Signature-256 header');
    if (!secret) {
      // Fail CLOSED in production (see MessengerAdapter for the rationale).
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

    const accountId =
      payload?.entry?.[0]?.instagram?.id ?? this.config.instagramUserId ?? null;
    return { kind: 'event', verified: true, accountId };
  }

  async fetchContactProfile(igid) {
    if (!igid) return null;
    try {
      const data = await this.graphGet(`/${igid}`, { fields: 'name,username,profile_pic_url' });
      return this.normalizeContact({ senderId: data.id, profile: data });
    } catch (error) {
      log.warn({ igid, err: error.message }, 'Could not fetch Instagram profile');
      return null;
    }
  }

  /** Resolves the IG business account linked to the connected page. */
  async healthCheck() {
    try {
      const pages = await this.graphGet('/me/accounts', { fields: 'id,name,instagram_business_account' });
      const page = pages.data?.[0];
      const ig = page?.instagram_business_account;
      return {
        ok: Boolean(ig),
        message: ig
          ? `Linked to Instagram @${ig.username ?? ig.id}`
          : 'This Facebook Page has no linked Instagram professional account',
        instagramUserId: ig?.id ?? null,
      };
    } catch (error) {
      return { ok: false, message: `Token rejected by Meta: ${error.message}` };
    }
  }
}

export default InstagramAdapter;
