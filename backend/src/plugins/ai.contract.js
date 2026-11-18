/**
 * AI plugin contract.
 *
 * TWO KINDS OF AI PLUGIN
 * ---------------------
 * 1. PROVIDER plugin - a text-generation backend (OpenAI, Groq, Anthropic, a
 *    local Ollama, or a deterministic "offline" stub). Must implement
 *    `generate({ system, user }) -> { text }`. That single method is the whole
 *    surface the AI pipeline needs, so a new backend is one file.
 *
 * 2. BEHAVIOUR plugin - a small, named step in the reply pipeline (classify
 *    intent, decide escalation, phrase the answer, summarise a thread, redact
 *    PII). A behaviour is an async function that receives the shared context
 *    and may return a partial patch. Behaviours are ordered by `order`.
 *
 * The existing intent/escalation logic becomes built-in behaviours, so the same
 * hook points that let a plugin override "classify intent" are what let the
 * shipped code run today.
 */

/** A provider must expose this and it must return a string. */
export const AI_PROVIDER_METHOD = 'generate';

/** Built-in provider ids that always ship. */
export const BUILTIN_AI_PROVIDERS = ['offline', 'openai', 'groq'];

/**
 * Validates an AI provider class.
 * Throws with a precise reason so a bad plugin fails at boot, not mid-reply.
 */
export function validateAiProviderClass(ProviderClass, { source = 'unknown' } = {}) {
  if (typeof ProviderClass !== 'function') {
    throw new Error(`${source}: must export a class/function, got ${typeof ProviderClass}`);
  }

  const id = ProviderClass.id ?? ProviderClass.name;
  if (!id || typeof id !== 'string') {
    throw new Error(`${source}: must declare a static id (the AI_PROVIDER value)`);
  }
  if (!/^[a-z][a-z0-9_-]{1,39}$/.test(id)) {
    throw new Error(`${source}: id "${id}" must match /^[a-z][a-z0-9_-]{1,39}$/`);
  }

  // Accept either a class with a generate() prototype method, or a plain object
  // with a generate() function - both are valid providers.
  const generate = ProviderClass.prototype?.generate ?? ProviderClass.generate;
  if (typeof generate !== 'function') {
    throw new Error(`${source}: must implement generate({ system, user }) -> { text }`);
  }

  return true;
}

/**
 * Validates an AI behaviour plugin.
 * A behaviour is `{ id, order, run(ctx) }` where run returns a patch object.
 */
export function validateBehaviourPlugin(plugin, { source = 'unknown' } = {}) {
  if (!plugin || typeof plugin !== 'object') {
    throw new Error(`${source}: behaviour plugin must be an object`);
  }
  if (!plugin.id || typeof plugin.id !== 'string') {
    throw new Error(`${source}: behaviour must declare a string id`);
  }
  if (typeof plugin.run !== 'function') {
    throw new Error(`${source}: behaviour "${plugin.id}" must implement run(context)`);
  }
  if (plugin.order !== undefined && typeof plugin.order !== 'number') {
    throw new Error(`${source}: behaviour "${plugin.id}" order must be a number when present`);
  }
  return true;
}

/**
 * Normalises the many provider response shapes into { text, needsHuman? }.
 * A provider may return a plain string for convenience.
 */
export function normaliseProviderResult(result) {
  if (typeof result === 'string') return { text: result };
  if (result && typeof result === 'object') {
    return {
      text: typeof result.text === 'string' ? result.text : null,
      needsHuman: Boolean(result.needsHuman),
    };
  }
  return { text: null };
}
