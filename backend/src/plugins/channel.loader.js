/**
 * Channel plugin loader.
 *
 * Scans two sources and registers everything it finds as an adapter:
 *   1. src/adapters/ (built-in .js files)
 *   2. plugins/&lt;folder&gt;/index.js   (third-party, with a manifest.json)
 *
 * Built-in adapters are self-describing (static fields on the class), so they
 * do not need a manifest file. Third-party plugins SHOULD ship manifest.json so
 * an operator can see version/vendor/config before connecting it; if it is
 * missing we synthesise one from the class and log a warning.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BaseAdapter } from '../adapters/BaseAdapter.js';
import { registerAdapter, setPluginManifestLookup } from '../adapters/registry.js';
import { childLogger } from '../config/logger.js';
import { validateManifest, validateAdapterClass, manifestFromClass } from './contract.js';

const log = childLogger('channel-plugins');

/** type -> normalised manifest */
const manifests = new Map();

/** Absolute path of the built-in adapter folder. */
export const BUILTIN_ADAPTERS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../adapters',
);

/**
 * Absolute path of the third-party plugin folder, overridable by env so a
 * deployment can keep plugins outside the repo.
 */
export const PLUGINS_DIR = path.resolve(
  process.env.CHANNEL_PLUGINS_DIR
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../plugins'),
);

const SKIP_BUILTIN_FILES = new Set([
  'BaseAdapter.js',
  'registry.js',
  'factory.js',
  'index.js',
]);

/** Records the manifest for a type (used by the catalogue + admin screen). */
function recordManifest(AdapterClass, manifest) {
  manifests.set(AdapterClass.type, manifest);
}

/** Every known manifest, for the UI and the docs. */
export function listPluginManifests() {
  return [...manifests.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** The manifest for one channel type, if a plugin provides it. */
export function getPluginManifest(type) {
  return manifests.get(type) ?? null;
}

// ---------------------------------------------------------------- built-ins

async function loadBuiltinPlugins() {
  const entries = await fs.readdir(BUILTIN_ADAPTERS_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
    .filter((name) => !SKIP_BUILTIN_FILES.has(name))
    .sort();

  const loaded = [];
  const failures = [];

  for (const file of files) {
    const source = `builtin:${file}`;
    try {
      const module = await import(pathToFileURL(path.join(BUILTIN_ADAPTERS_DIR, file)).href);
      const candidates = [
        module.default,
        ...Object.values(module).filter(
          (value) => typeof value === 'function' && value.prototype instanceof BaseAdapter,
        ),
      ].filter(Boolean);

      if (!candidates.length) {
        failures.push(`${source}: exports no class extending BaseAdapter`);
        continue;
      }
      for (const AdapterClass of new Set(candidates)) {
        validateAdapterClass(AdapterClass, { source });
        registerAdapter(AdapterClass);
        recordManifest(AdapterClass, manifestFromClass(AdapterClass, { source: 'builtin' }));
        loaded.push(AdapterClass.type);
      }
    } catch (error) {
      failures.push(`${source}: ${error.message}`);
    }
  }

  return { loaded, failures };
}

// --------------------------------------------------------------- third-party

/**
 * A third-party plugin folder is valid when it contains index.js (the module)
 * and optionally manifest.json (the metadata). Both are described by
 * `validateManifest` / `validateAdapterClass`.
 */
async function loadThirdPartyPlugins() {
  let entries;
  try {
    entries = await fs.readdir(PLUGINS_DIR, { withFileTypes: true });
  } catch {
    // No plugins folder is the normal case - not an error.
    return { loaded: [], failures: [] };
  }

  const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const loaded = [];
  const failures = [];

  for (const folder of folders) {
    const dir = path.join(PLUGINS_DIR, folder);
    const source = `plugin:${folder}`;

    // index.js is the entrypoint; plugin.js is accepted as an alias.
    let entryFile = null;
    for (const candidate of ['index.js', 'plugin.js']) {
      try {
        await fs.access(path.join(dir, candidate));
        entryFile = candidate;
        break;
      } catch {
        /* try next */
      }
    }
    if (!entryFile) {
      failures.push(`${source}: no index.js or plugin.js entrypoint`);
      continue;
    }

    try {
      const module = await import(pathToFileURL(path.join(dir, entryFile)).href);
      const AdapterClass = module.default ?? module.adapter ?? module.Adapter;
      if (typeof AdapterClass !== 'function') {
        failures.push(`${source}: entrypoint must default-export the adapter class`);
        continue;
      }
      validateAdapterClass(AdapterClass, { source });

      // Prefer a real manifest.json; fall back to class metadata.
      let manifest = null;
      try {
        const raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8');
        manifest = validateManifest(JSON.parse(raw), { source });
      } catch (manifestError) {
        if (manifestError.code === 'ENOENT') {
          log.warn({ source }, 'no manifest.json - using adapter class metadata');
          manifest = manifestFromClass(AdapterClass, { source });
        } else {
          throw manifestError;
        }
      }

      // The manifest type and the class type must agree, otherwise the row in
      // the DB (which stores the manifest type) would not resolve at runtime.
      if (manifest.type !== AdapterClass.type) {
        throw new Error(
          `manifest type "${manifest.type}" does not match adapter static type "${AdapterClass.type}"`,
        );
      }

      registerAdapter(AdapterClass);
      recordManifest(AdapterClass, manifest);
      loaded.push(manifest.type);
    } catch (error) {
      failures.push(`${source}: ${error.message}`);
    }
  }

  return { loaded, failures };
}

// --------------------------------------------------------------------- boot

let loaded = false;

/**
 * Discovers and registers every channel plugin (built-in + third-party).
 * Idempotent. A broken plugin fails the boot loudly with its folder name.
 */
export async function loadChannelPlugins() {
  if (loaded) return;

  // Let the adapter catalogue enrich itself with plugin metadata.
  setPluginManifestLookup(getPluginManifest);

  const builtin = await loadBuiltinPlugins();
  const thirdParty = await loadThirdPartyPlugins();

  const failures = [...builtin.failures, ...thirdParty.failures];
  if (failures.length) {
    log.error({ failures }, 'Channel plugin discovery failed');
    throw new Error(`Channel plugin discovery failed:\n  - ${failures.join('\n  - ')}`);
  }

  const all = [...new Set([...builtin.loaded, ...thirdParty.loaded])].sort();
  log.info(
    { builtins: builtin.loaded.length, thirdParty: thirdParty.loaded.length, types: all },
    'Channel plugins ready',
  );
  loaded = true;
}

/** Test helper: forget everything (registry + manifests). */
export function resetPluginLoader() {
  loaded = false;
  manifests.clear();
}
