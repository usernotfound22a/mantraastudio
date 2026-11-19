/**
 * EXAMPLE third-party channel plugin.
 *
 * This folder is not part of the application source - it is exactly what a
 * partner (or you, later) would drop into plugins/ to add a channel without
 * touching the codebase. It exists to prove and document the contract.
 *
 * It implements a working "Telegram" channel: Telegram's Bot API is a simple
 * HTTPS JSON API, so the whole plugin is ~120 lines and needs no database
 * change (channels.type is a VARCHAR and is validated against the registry).
 *
 * To make it live:
 *   1. set TELEGRAM_BOT_TOKEN in backend/.env
 *   2. add TELEGRAM_BOT_TOKEN to env.js
 *   3. point a Telegram webhook at POST /api/webhooks/telegram
 *   4. restart the API - the bundled adapter is registered at startup
 *   5. POST /api/channels { "type": "telegram", "name": "...",
 *                          "config": { "botToken": "..." } }
 */
import { BaseAdapter } from '../../src/adapters/BaseAdapter.js';
import { AppError } from '../../src/middleware/error.js';

const API = 'https://api.telegram.org';

export default class TelegramAdapter extends BaseAdapter {
  static pluginName = 'Telegram';
  static type = 'telegram';
  static label = 'Telegram';
  static description = 'Telegram bot channel via the Bot API.';
  static family = 'chat';
  static version = '1.0.0';
  static vendor = 'SocialHub (example)';
  static requiresSignature = false;
  static capabilities = {
    attachments: true,
    readReceipts: false,
    typingIndicator: true,
    proactiveMessaging: true,
    mediaUpload: false,
  };
  static configSchema = [
    { key: 'botToken', label: 'Bot token', type: 'password', required: true },
    { key: 'botUsername', label: 'Bot username', type: 'string', required: false },
  ];
  static requiredConfig = ['botToken'];

  /** Telegram calls this method, so the token is a plain config field. */
  async call(method, payload) {
    const token = this.requireConfig('botToken') && this.config.botToken;
    const response = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
    const body = await response.json();
    if (!body.ok) {
      throw AppError.serviceUnavailable(`Telegram ${method} failed: ${body.description ?? response.status}`);
    }
    return body.result;
  }

  // ------------------------------------------------------------- inbound

  parseInbound(payload) {
    // Telegram posts { message: { message_id, from, chat, text/photo, date } }
    const update = payload?.message ?? payload?.edited_message;
    if (!update?.chat?.id) return [];

    const contact = this.normalizeContact(update.from);
    return [
      {
        externalMessageId: String(update.message_id),
        conversationExternalId: this.buildConversationExternalId(String(update.chat.id)),
        contact,
        content: {
          text: update.text ?? (update.photo ? '[photo]' : null),
          attachments: update.photo
            ? this.normalizeAttachments([
                {
                  // Telegram file ids must be fetched via getFile; the customer
                  // sees a placeholder here rather than a broken permanent URL.
                  url: null,
                  name: `telegram-${update.photo.file_id}.jpg`,
                  mimeType: 'image/jpeg',
                },
              ])
            : [],
          quickReplies: [],
        },
        timestamp: new Date((update.date ?? 0) * 1000),
        metadata: { chatId: update.chat.id },
      },
    ];
  }

  normalizeContact(raw) {
    return {
      externalId: String(raw?.id ?? ''),
      name: [raw?.first_name, raw?.last_name].filter(Boolean).join(' ') || 'Telegram user',
      avatarUrl: null,
      email: null,
      locale: raw?.language_code ?? null,
    };
  }

  // ------------------------------------------------------------ outbound

  async sendMessage({ to, body, attachments = [] }) {
    if (attachments.length) {
      // Uploading files needs multipart plumbing; text-only is honest and safe.
      body = `${body}\n\n(attachments: ${attachments.length})`.trim();
    }
    const sent = await this.call('sendMessage', {
      chat_id: to,
      text: body,
    });
    return { externalId: String(sent?.message_id ?? ''), status: 'sent' };
  }

  async sendTyping(to) {
    await this.call('sendChatAction', { chat_id: to, action: 'typing' });
    return { supported: true };
  }

  async healthCheck() {
    const me = await this.call('getMe', {});
    return { ok: true, message: `Connected as @${me.username ?? me.first_name}` };
  }
}
