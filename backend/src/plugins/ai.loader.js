/**
 * AI plugin loader.
 *
 * Responsibilities
 * ----------------
 * 1. Register the built-in provider presets (offline, openai, groq) and any
 *    third-party providers found in plugins/ai/<name>/
 * 2. Resolve env.AI_PROVIDER to a live provider instance
 * 3. Register and run BEHAVIOUR plugins - the ordered stages of the reply
 *    pipeline (classify intent, detect escalation, summarise, ...)
 *
 * The behaviour registry is the extension point the rest of ai.service.js uses.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { env } from '../config/env.js';
import { childLogger } from '../config/logger.js';
import { validateAiProviderClass, validateBehaviourPlugin, normaliseProviderResult } from './ai.contract.js';
import { OfflineProvider } from './ai.providers/offline.provider.js';
import { OpenAIProvider, GroqProvider } from './ai.providers/openai.provider.js';
import classifyIntentBehaviour from './ai.behaviours/classify-intent.behaviour.js';
import escalationBehaviour from './ai.behaviours/escalation.behaviour.js';

const log = childLogger('ai-plugins');

/** id -> ProviderClass (or plain object with generate()) */
const providers = new Map();

/** id -> behaviour plugin */
const behaviours = new Map();

const PLUGINS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../plugins/ai',
);

// ---------------------------------------------------------------- providers

/** Registers a provider. A later registration with the same id wins. */
export function registerAiProvider(ProviderClass) {
  validateAiProviderClass(ProviderClass, { source: ProviderClass?.name });
  const id = ProviderClass.id;
  if (providers.has(id)) {
    log.debug({ id }, 'overriding existing AI provider');
  }
  providers.set(id, ProviderClass);
  return ProviderClass;
}

function loadBuiltinProviders() {
  registerAiProvider(OfflineProvider);
  registerAiProvider(OpenAIProvider);
  registerAiProvider(GroqProvider);
}

function loadBuiltinBehaviours() {
  registerAiBehaviour(classifyIntentBehaviour, { source: 'builtin' });
  registerAiBehaviour(escalationBehaviour, { source: 'builtin' });
}

/** Loads any third-party provider/behaviour plugins in plugins/ai/. */
async function loadThirdPartyAiPlugins() {
  const loaded = [];
  const failures = [];
  let entries;
  try {
    entries = await fs.readdir(PLUGINS_ROOT, { withFileTypes: true });
  } catch {
    return { loaded, failures };
  }

  const folders = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const folder of folders) {
    const dir = path.join(PLUGINS_ROOT, folder);
    const source = `ai-plugin:${folder}`;
    try {
      const module = await import(pathToFileURL(path.join(dir, 'index.js')).href);
      // A folder may export a provider, a behaviour, or both.
      if (module.default) {
        if (typeof module.default.generate === 'function' || module.default.prototype?.generate) {
          registerAiProvider(module.default);
          loaded.push(`provider:${module.default.id ?? folder}`);
        }
      }
      if (Array.isArray(module.behaviours)) {
        for (const behaviour of module.behaviours) {
          registerAiBehaviour(behaviour, { source });
          loaded.push(`behaviour:${behaviour.id}`);
        }
      }
      if (typeof module.behaviour === 'object' && module.behaviour) {
        registerAiBehaviour(module.behaviour, { source });
        loaded.push(`behaviour:${module.behaviour.id}`);
      }
    } catch (error) {
      failures.push(`${source}: ${error.message}`);
    }
  }
  return { loaded, failures };
}

// ---------------------------------------------------------------- behaviours

/** Registers a behaviour stage in the reply pipeline. */
export function registerAiBehaviour(behaviour, { source = 'unknown' } = {}) {
  validateBehaviourPlugin(behaviour, { source });
  if (behaviours.has(behaviour.id)) {
    log.warn({ id: behaviour.id }, 'behaviour already registered - overwriting');
  }
  behaviours.set(behaviour.id, behaviour);
  return behaviour;
}

/** All behaviours in execution order (order, then id for stability). */
export function listAiBehaviour() {
  return [...behaviours.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
}

/**
 * Runs the behaviour pipeline over a context.
 * Each behaviour receives the context and may return a patch object which is
 * merged in before the next behaviour runs. This is how a plugin can, for
 * example, replace intent detection or add a PII redaction stage.
 *
 * A throwing behaviour is logged and skipped - a plugin must never break a reply.
 */
export async function runAiBehaviour(context) {
  let ctx = { ...context };
  for (const behaviour of listAiBehaviour()) {
    try {
      const patch = await behaviour.run(ctx);
      if (patch && typeof patch === 'object') {
        ctx = { ...ctx, ...patch };
        ctx.__behaviours = [...(ctx.__behaviours ?? []), behaviour.id];
      }
    } catch (error) {
      log.warn({ behaviour: behaviour.id, err: error.message }, 'behaviour stage failed - skipped');
    }
  }
  return ctx;
}

// ------------------------------------------------------------------ resolve

/**
 * Instantiates a provider and stamps its id onto the instance.
 *
 * Static class fields do NOT exist on instances, so `new OfflineProvider().id`
 * is undefined. Callers (ai.service.js) branch on `provider.id === 'offline'`,
 * so the id must be carried onto the instance here, once, for every provider.
 */
function instantiate(ProviderClass, id) {
  const instance = typeof ProviderClass === 'function' ? new ProviderClass() : ProviderClass;
  if (instance && typeof instance === 'object' && !instance.id) {
    instance.id = id;
  }
  return instance;
}

/**
 * Resolves the configured provider id to a live instance (with .id set).
 * Always returns something usable: if the configured provider is missing or has
 * no key, it falls back to the offline provider so the pipeline never breaks.
 */
export function resolveAiProvider(providerId = env.AI_PROVIDER) {
  const ProviderClass = providers.get(providerId);
  if (!ProviderClass) {
    log.warn({ provider: providerId, available: [...providers.keys()] }, 'unknown AI provider - using offline');
    const Offline = providers.get('offline');
    return instantiate(Offline, 'offline');
  }
  // Providers may be classes (new) or objects.
  return instantiate(ProviderClass, providerId);
}

/** Manifest list for the admin/settings screen. */
export function listAiProviderManifests() {
  return [...providers.values()]
    .map((P) => ({
      id: P.id,
      label: P.label ?? P.id,
      description: P.description ?? '',
      requiresKey: Boolean(P.requiresKey),
      envKey: P.envKey ?? null,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function getAiProviderManifest(id) {
  return listAiProviderManifests().find((p) => p.id === id) ?? null;
}

// --------------------------------------------------------------------- boot

let loaded = false;

export async function loadAiPlugins() {
  if (loaded) return;

  loadBuiltinProviders();
  loadBuiltinBehaviours();

  const { loaded: thirdParty, failures } = await loadThirdPartyAiPlugins();
  if (failures.length) {
    // Third-party AI plugin problems should not stop the app from booting - the
    // provider is an enhancement. Log loudly and continue.
    log.error({ failures }, 'some third-party AI plugins failed to load');
  }

  log.info(
    { providers: [...providers.keys()], thirdParty },
    'AI plugins ready',
  );
  loaded = true;
}

export { normaliseProviderResult };

export function resetAiPluginLoader() {
  loaded = false;
  providers.clear();
  behaviours.clear();
}
