/**
 * OpenAI-compatible provider (built-in).
 *
 * "OpenAI-compatible" is the key word: Groq, Together, Ollama, LM Studio,
 * vLLM and others all expose the same /chat/completions shape. So this one
 * provider covers a whole family of backends just by changing baseUrl - which
 * is why Groq is registered as a preset of this class rather than a copy of it.
 */
import { env } from '../../config/env.js';
import { childLogger } from '../../config/logger.js';
import { normaliseProviderResult } from '../ai.contract.js';

const log = childLogger('ai-provider-openai');

/** Cached SDK client so we do not re-instantiate per reply. */
let client = null;

/** Builds (and caches) the OpenAI SDK client for a given key/baseUrl pair. */
async function getClient({ apiKey, baseUrl, timeout }) {
  const { default: OpenAI } = await import('openai');
  return new OpenAI({ apiKey, baseURL: baseUrl || undefined, timeout, maxRetries: 1 });
}

export class OpenAICompatibleProvider {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} [options.baseUrl]
   * @param {string} [options.model]
   */
  constructor({ apiKey, baseUrl, model } = {}) {
    this.apiKey = apiKey || env.OPENAI_API_KEY;
    this.baseUrl = baseUrl || null;
    this.model = model || env.OPENAI_MODEL;
    this.timeout = 8000;
  }

  async generate({ system, user } = {}) {
    if (!this.apiKey) {
      // No key: the caller falls back to the offline answer.
      return { text: null, generated: false, error: 'missing_api_key' };
    }
    if (!client) client = await getClient(this);

    try {
      const response = await client.chat.completions.create({
        model: this.model,
        temperature: 0.2,
        max_tokens: env.AI_MAX_TOKENS,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user ?? '' },
        ],
      });
      const text = response.choices?.[0]?.message?.content?.trim() ?? null;
      return { ...normaliseProviderResult(text), generated: true };
    } catch (error) {
      log.warn({ err: error.message }, 'provider call failed');
      // Never throw into the reply pipeline - the caller falls back to the FAQ.
      return { text: null, generated: false, error: error.message };
    }
  }
}

/** OpenAI preset. */
export class OpenAIProvider extends OpenAICompatibleProvider {
  static id = 'openai';
  static label = 'OpenAI';
  static description = 'OpenAI GPT models via the official API.';
  static requiresKey = true;
  static envKey = 'OPENAI_API_KEY';

  constructor(options = {}) {
    super({ ...options, baseUrl: null, apiKey: options.apiKey ?? env.OPENAI_API_KEY });
  }
}

/** Groq preset - same API, different base URL + key. */
export class GroqProvider extends OpenAICompatibleProvider {
  static id = 'groq';
  static label = 'Groq';
  static description = 'Fast OpenAI-compatible inference.';
  static requiresKey = true;
  static envKey = 'GROQ_API_KEY';
  static baseUrl = 'https://api.groq.com/openai/v1';

  constructor(options = {}) {
    super({
      ...options,
      baseUrl: options.baseUrl ?? GroqProvider.baseUrl,
      apiKey: options.apiKey ?? env.GROQ_API_KEY,
    });
  }
}
