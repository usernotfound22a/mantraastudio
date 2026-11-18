/**
 * Offline AI provider (built-in, always available).
 *
 * Returns the curated FAQ answer unchanged. This is what runs when no API key
 * is configured, and it is why the AI pipeline can be exercised end to end with
 * zero external dependencies.
 */
import { normaliseProviderResult } from '../ai.contract.js';

export class OfflineProvider {
  static id = 'offline';
  static label = 'Offline (knowledge base only)';
  static description = 'Deterministic answers straight from the FAQ knowledge base. No API key needed.';
  static requiresKey = false;

  /**
   * @param {{ system?: string, user?: string, faqAnswer?: string }} input
   * @returns {Promise<{text: string|null, generated: boolean}>}
   */
  async generate({ faqAnswer } = {}) {
    return { ...normaliseProviderResult(faqAnswer ?? null), generated: false };
  }
}

export default OfflineProvider;
