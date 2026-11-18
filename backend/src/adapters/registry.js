/**
 * Adapter registry.
 *
 * Responsibilities
 * ----------------
 * 1. Keep one entry per channel TYPE (not per connected channel row).
 * 2. Discover adapter files on disk at boot.
 *
 * THE KEY DESIGN DECISION (this is what "add a channel = one file" means)
 * -------------------------------------------------------------------------
 * `loadAdaptersFromDisk()` imports EVERY .js file in this folder and
 * auto-registers any exported class that extends BaseAdapter, keyed by its
 * static `type`.
 *
 * So adding a new channel is literally:
 *     touch src/adapters/TelegramAdapter.js   # export a class, set static type
 *     restart the server
 *
 * No factory edit, no index edit, no switch statement anywhere else. If a new
 * adapter file has a syntax error, the server refuses to start and prints the
 * file name rather than half-working.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BaseAdapter } from './BaseAdapter.js';
import { childLogger } from '../config/logger.js';
import { AppError } from '../middleware/error.js';

const log = childLogger('adapter-registry');

/** type -> AdapterClass */
const registry = new Map();

/**
 * Optional manifest lookup, injected by the plugin loader at boot.
 * Declared here (rather than imported) so the registry stays independent of the
 * loader, and the loader can depend on the registry without a cycle.
 * @type {null | ((type: string) => object|null)}
 */
let getPluginManifest = null;

/** Called once by the plugin loader to wire manifest lookups into the catalogue. */
export function setPluginManifestLookup(fn) {
  getPluginManifest = typeof fn === 'function' ? fn : null;
}

/** Absolute path of this folder. */
export const ADAPTERS_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Registers an adapter class.
 * @param {typeof BaseAdapter} AdapterClass
 */
export function registerAdapter(AdapterClass) {
  const type = AdapterClass?.type;

  if (!type || type === 'base') {
    throw new Error(`${AdapterClass?.name} must declare a unique static type`);
  }
  if (typeof AdapterClass !== 'function' || !(AdapterClass.prototype instanceof BaseAdapter)) {
    throw new Error(`${AdapterClass?.name} must extend BaseAdapter`);
  }
  if (registry.has(type) && registry.get(type) !== AdapterClass) {
    throw new Error(
      `Duplicate adapter for channel type "${type}": ` +
        `${registry.get(type).name} and ${AdapterClass.name}`,
    );
  }

  registry.set(type, AdapterClass);
  log.info(
    { type, adapter: AdapterClass.name, label: AdapterClass.label },
    'Adapter registered',
  );
  return AdapterClass;
}

/** @returns {typeof BaseAdapter|null} */
export function getAdapterClass(type) {
  return registry.get(type) ?? null;
}

/** Every registered channel type. */
export function listAdapterTypes() {
  return [...registry.keys()].sort();
}

/**
 * Frontend-facing catalogue for the "Connect a channel" screen.
 * Contains no secrets - it only describes what each channel can do.
 * When a plugin supplied a richer manifest, its version/vendor/config schema
 * are folded in so the UI can show them without a second endpoint.
 */
export function listAdapterCatalogue() {
  return [...registry.values()]
    .map((AdapterClass) => {
      // Optional: the registry must not depend on the plugin loader (which
      // depends on the registry), so the manifest lookup is injected at boot.
      const manifest = typeof getPluginManifest === 'function' ? getPluginManifest(AdapterClass.type) : null;
      return {
        type: AdapterClass.type,
        label: AdapterClass.label,
        description: AdapterClass.description,
        capabilities: AdapterClass.capabilities,
        requiresSignature: AdapterClass.requiresSignature,
        // Plugin metadata (only present for manifest-described plugins).
        version: manifest?.version ?? null,
        vendor: manifest?.vendor ?? null,
        family: manifest?.family ?? 'chat',
        configSchema: manifest?.configSchema ?? [],
        requiredConfig: manifest?.requiredConfig ?? [],
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function unregisterAdapter(type) {
  return registry.delete(type);
}

/** Test helper: wipe the registry. */
export function clearRegistry() {
  registry.clear();
}

/**
 * Imports every adapter file in this directory and registers what it exports.
 * Idempotent - safe to call more than once.
 */
export async function loadAdaptersFromDisk() {
  const entries = await fs.readdir(ADAPTERS_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
    .filter((name) => !['BaseAdapter.js', 'registry.js', 'factory.js', 'index.js'].includes(name))
    .sort();

  const found = [];
  const failures = [];

  for (const file of files) {
    try {
      // pathToFileURL is required on Windows: a bare "C:\..." path is not a
      // valid ESM specifier ("Received protocol 'c:'").
      const module = await import(pathToFileURL(path.join(ADAPTERS_DIR, file)).href);
      const candidates = [
        module.default,
        ...Object.values(module).filter(
          (value) => typeof value === 'function' && value.prototype instanceof BaseAdapter,
        ),
      ].filter(Boolean);

      if (candidates.length === 0) {
        failures.push(`${file}: exports no class extending BaseAdapter`);
        continue;
      }
      for (const AdapterClass of new Set(candidates)) {
        registerAdapter(AdapterClass);
        found.push(AdapterClass.type);
      }
    } catch (error) {
      failures.push(`${file}: ${error.message}`);
    }
  }

  if (failures.length) {
    // A broken adapter file must not silently disable that channel.
    log.error({ failures }, 'Some adapter files failed to load');
    throw new Error(`Adapter auto-discovery failed:\n  - ${failures.join('\n  - ')}`);
  }

  log.info({ adapters: found, count: found.length }, 'Adapter discovery complete');
  return found;
}

/** Throws a helpful error for an unknown channel type. */
export function assertAdapterExists(type) {
  const AdapterClass = getAdapterClass(type);
  if (!AdapterClass) {
    throw AppError.badRequest(
      `Unsupported channel type "${type}". Available: ${listAdapterTypes().join(', ')}`,
    );
  }
  return AdapterClass;
}
