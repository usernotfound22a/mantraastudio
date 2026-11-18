/**
 * Public entry point for the adapter system.
 *
 * Everything outside `src/adapters/` imports from HERE, never from a concrete
 * adapter file. That is what keeps the rest of the codebase channel-agnostic.
 *
 *   import { createAdapterForChannel, ensureAdaptersLoaded } from '../adapters/index.js';
 */
export { BaseAdapter } from './BaseAdapter.js';
export {
  createAdapterForChannel,
  createAdapterForType,
  ensureAdaptersLoaded,
  listAdapterTypes,
  listAdapterCatalogue,
  getAdapterClass,
} from './factory.js';
export { registerAdapter, loadAdaptersFromDisk, ADAPTERS_DIR } from './registry.js';

/**
 * Concrete adapters are exported for tests and for the settings screen, but
 * note: importing them here does NOT register them - `loadAdaptersFromDisk()`
 * does that, and it skips this file to avoid a circular import.
 */
export { default as WebsiteAdapter } from './WebsiteAdapter.js';
export { default as MessengerAdapter } from './MessengerAdapter.js';
export { default as InstagramAdapter } from './InstagramAdapter.js';
