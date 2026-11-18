/**
 * Public entry point for the plugin systems.
 *
 *   import { loadChannelPlugins, listPluginManifests } from '../plugins/index.js';
 *   import { resolveAiProvider, listAiProviderManifests } from '../plugins/index.js';
 */
export {
  loadChannelPlugins,
  listPluginManifests,
  getPluginManifest,
  resetPluginLoader,
  PLUGINS_DIR,
  BUILTIN_ADAPTERS_DIR,
} from './channel.loader.js';
export { validateManifest, validateAdapterClass, manifestFromClass, CAPABILITY_KEYS } from './contract.js';

export {
  loadAiPlugins,
  listAiProviderManifests,
  getAiProviderManifest,
  resolveAiProvider,
  runAiBehaviour,
  listAiBehaviour,
  resetAiPluginLoader,
} from './ai.loader.js';
export { validateAiProviderClass, validateBehaviourPlugin } from './ai.contract.js';
