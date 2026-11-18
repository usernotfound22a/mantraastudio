/**
 * Channel plugin contract.
 *
 * WHAT "PLUGIN" MEANS HERE
 * -----------------------
 * A channel plugin is a folder that exports a class extending BaseAdapter and
 * declares a manifest. It can live in two places:
 *
 *   1. src/adapters/*.js         - built-in, shipped with the app
 *   2. plugins/<name>/index.js   - third-party, dropped in at deploy time
 *
 * A third-party folder looks like this:
 *
 *   plugins/whatsapp/
 *     manifest.json      { name, version, type, label, ... }
 *     index.js           export default class WhatsAppAdapter extends BaseAdapter
 *
 * The point of the manifest is that an operator can SEE what a plugin declares
 * before connecting it, and the registry can reject an invalid one at boot with
 * a clear message instead of failing later on the first webhook.
 */
import { BaseAdapter } from '../adapters/BaseAdapter.js';

/** Capability flags every plugin must declare. */
export const CAPABILITY_KEYS = [
  'attachments',
  'readReceipts',
  'typingIndicator',
  'proactiveMessaging',
  'mediaUpload',
];

/** @typedef {'chat'|'email'|'social'|'voice'} ChannelFamily */

/**
 * Validates a manifest object. Throws with a precise reason on failure.
 * @returns {object} the normalised manifest
 */
export function validateManifest(manifest, { source = 'unknown' } = {}) {
  const errors = [];

  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`${source}: manifest must be an object`);
  }

  const required = ['name', 'version', 'type', 'label'];
  for (const key of required) {
    if (!manifest[key] || typeof manifest[key] !== 'string') {
      errors.push(`"${key}" must be a non-empty string`);
    }
  }

  // The type is what lands in channels.type, so keep it to a safe slug.
  if (manifest.type && !/^[a-z][a-z0-9_-]{1,39}$/.test(manifest.type)) {
    errors.push(
      `"type" must match /^[a-z][a-z0-9_-]{1,39}$/ (got "${manifest.type}") - it is stored in the database`,
    );
  }

  if (manifest.version && !/^\d+\.\d+\.\d+([-+].+)?$/.test(manifest.version)) {
    errors.push(`"version" must be semver like 1.0.0 (got "${manifest.version}")`);
  }

  const capabilities = manifest.capabilities ?? {};
  for (const key of CAPABILITY_KEYS) {
    if (capabilities[key] !== undefined && typeof capabilities[key] !== 'boolean') {
      errors.push(`capabilities.${key} must be a boolean`);
    }
  }

  // Declared config keys are what the UI renders a setup form for, so a typo
  // here would silently drop a field an operator needs to fill in.
  if (manifest.configSchema !== undefined) {
    if (!Array.isArray(manifest.configSchema)) {
      errors.push('"configSchema" must be an array when present');
    } else {
      manifest.configSchema.forEach((field, index) => {
        if (!field || typeof field.key !== 'string') {
          errors.push(`configSchema[${index}].key must be a string`);
        }
        if (field && field.type && !['string', 'number', 'boolean', 'password', 'select'].includes(field.type)) {
          errors.push(`configSchema[${index}].type must be string|number|boolean|password|select`);
        }
      });
    }
  }

  if (errors.length) {
    throw new Error(`${source}: invalid manifest - ${errors.join('; ')}`);
  }

  return {
    name: manifest.name,
    version: manifest.version,
    type: manifest.type,
    label: manifest.label,
    description: manifest.description ?? '',
    family: manifest.family ?? 'chat',
    homepage: manifest.homepage ?? null,
    vendor: manifest.vendor ?? null,
    // Where the plugin came from: 'builtin' or an absolute folder path.
    source,
    requiresSignature: Boolean(manifest.requiresSignature),
    capabilities: Object.fromEntries(
      CAPABILITY_KEYS.map((key) => [key, Boolean(capabilities[key])]),
    ),
    configSchema: manifest.configSchema ?? [],
    // Secrets an operator must supply before the channel can be used.
    requiredConfig: manifest.requiredConfig ?? [],
  };
}

/**
 * Validates that a class actually implements the adapter contract.
 *
 * Catches the common failure mode - an adapter that parses inbound messages but
 * forgot sendMessage() - at boot rather than on the first reply.
 */
export function validateAdapterClass(AdapterClass, { source = 'unknown' } = {}) {
  const problems = [];

  if (typeof AdapterClass !== 'function') {
    throw new Error(`${source}: must export a class, got ${typeof AdapterClass}`);
  }
  if (!AdapterClass.prototype instanceof BaseAdapter) {
    throw new Error(`${source}: ${AdapterClass.name} must extend BaseAdapter`);
  }
  if (!AdapterClass.type || AdapterClass.type === 'base') {
    throw new Error(`${source}: ${AdapterClass.name} must declare a unique static type`);
  }

  for (const method of ['parseInbound', 'normalizeContact', 'sendMessage']) {
    if (typeof AdapterClass.prototype[method] !== 'function') {
      problems.push(`missing ${method}()`);
    } else if (AdapterClass.prototype[method] === BaseAdapter.prototype[method]) {
      // Inherited unchanged = not implemented, which would throw at runtime.
      problems.push(`${method}() is not implemented`);
    }
  }

  if (problems.length) {
    throw new Error(`${source}: ${AdapterClass.name} does not satisfy the adapter contract - ${problems.join(', ')}`);
  }
}

/**
 * Builds the manifest for a class that does not ship a manifest.json.
 * Keeps the built-in adapters working without extra files.
 */
export function manifestFromClass(AdapterClass, { source = 'builtin' } = {}) {
  return validateManifest(
    {
      name: AdapterClass.pluginName ?? AdapterClass.name,
      version: AdapterClass.version ?? '1.0.0',
      type: AdapterClass.type,
      label: AdapterClass.label,
      description: AdapterClass.description ?? '',
      family: AdapterClass.family ?? 'chat',
      homepage: AdapterClass.homepage ?? null,
      vendor: AdapterClass.vendor ?? null,
      requiresSignature: AdapterClass.requiresSignature ?? false,
      capabilities: AdapterClass.capabilities ?? {},
      configSchema: AdapterClass.configSchema ?? [],
      requiredConfig: AdapterClass.requiredConfig ?? [],
    },
    { source },
  );
}
