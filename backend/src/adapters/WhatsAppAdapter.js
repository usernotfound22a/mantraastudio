/** WhatsApp Cloud API adapter. */
import axios from 'axios';
import { BaseAdapter } from './BaseAdapter.js';
import { env } from '../config/env.js';
import { childLogger } from '../config/logger.js';
import { AppError } from '../middleware/error.js';
import { getMetaSettings } from '../services/meta-settings.service.js';

const log = childLogger('adapter:whatsapp');

export class WhatsAppAdapter extends BaseAdapter {
  static type = 'whatsapp';
  static label = 'WhatsApp';
  static description = 'Connect a WhatsApp Business number through Meta Cloud API.';
  static requiresSignature = true;

  static capabilities = {
    attachments: false,
    readReceipts: false,
    typingIndicator: false,
    proactiveMessaging: false,
    mediaUpload: false,
  };

  get graphUrl() {
    return `https://graph.facebook.com/${env.META_GRAPH_VERSION}`;
  }

  parseInbound(payload) {
    const results = [];
    for (const entry of payload?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;
        const value = change.value ?? {};
        const phoneNumberId = value.metadata?.phone_number_id;
        const contacts = value.contacts ?? [];

        for (const message of value.messages ?? []) {
          const contact = contacts.find((candidate) => candidate.wa_id === message.from);
          const body = message.text?.body
            ?? message.interactive?.button_reply?.title
            ?? message.interactive?.list_reply?.title
            ?? (message.type && message.type !== 'text' ? `Received a ${message.type} message` : null);
          if (!body || !message.from) continue;

          results.push({
            externalMessageId: message.id,
            conversationExternalId: message.from,
            contact: this.normalizeContact({ waId: message.from, profile: contact }),
            content: { text: body, attachments: [], quickReplies: [] },
            timestamp: message.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date(),
            metadata: { channel: 'whatsapp', phoneNumberId, businessAccountId: entry.id, messageType: message.type },
          });
        }
      }
    }
    log.debug({ events: results.length }, 'Parsed WhatsApp webhook');
    return results;
  }

  normalizeContact(raw) {
    return {
      externalId: raw?.waId ?? raw?.profile?.wa_id ?? null,
      name: raw?.profile?.profile?.name ?? raw?.profile?.name ?? null,
      avatarUrl: null,
      email: null,
      locale: null,
    };
  }

  resolveAccountId(payload) {
    for (const entry of payload?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const phoneNumberId = change.value?.metadata?.phone_number_id;
        if (phoneNumberId) return String(phoneNumberId);
      }
    }
    return null;
  }

  verifyWebhook({ payload, headers = {}, rawBody, query = {} }) {
    const mode = query['hub.mode'] ?? payload?.hub_mode;
    if (mode) {
      const token = query['hub.verify_token'] ?? payload?.hub_verify_token;
      const challenge = query['hub.challenge'] ?? payload?.hub_challenge;
      if (token !== (this.config.verifyToken || env.META_VERIFY_TOKEN)) {
        throw AppError.forbidden('Webhook verify token mismatch');
      }
      return { kind: 'handshake', challenge };
    }

    const signature = headers['x-hub-signature-256'] ?? headers['X-Hub-Signature-256'];
    const secret = this.config.appSecret || getMetaSettings().appSecret;
    if (!signature) throw AppError.forbidden('Missing X-Hub-Signature-256 header');
    if (!secret) {
      if (env.isProd) {
        throw AppError.serviceUnavailable('Webhook verification is not configured (META_APP_SECRET is missing)');
      }
      log.warn('META_APP_SECRET is not set - webhook signature NOT verified (development only)');
      return { kind: 'event', verified: false, reason: 'app secret not configured' };
    }
    if (!this.verifySignature(rawBody ?? '', signature, secret)) {
      throw AppError.forbidden('Invalid X-Hub-Signature-256 signature');
    }
    return { kind: 'event', verified: true };
  }

  async sendMessage({ to, body }) {
    this.requireConfig('accessToken', 'phoneNumberId');
    if (!to || !String(body ?? '').trim()) throw new Error('sendMessage() requires a recipient and text');

    const { data } = await axios.post(
      `${this.graphUrl}/${this.config.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body: String(body).slice(0, 4096) },
      },
      { params: { access_token: this.config.accessToken }, timeout: 15000 },
    );
    return { externalId: data.messages?.[0]?.id ?? null, status: 'sent', raw: data };
  }
}

export default WhatsAppAdapter;