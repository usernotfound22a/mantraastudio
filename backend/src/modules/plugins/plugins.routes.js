/**
 * GET /api/plugins
 *
 * Read-only inventory of every plugin loaded in this process, across all three
 * plugin systems. There is deliberately no "install" endpoint: plugins are code,
 * so they are added by dropping a folder in `backend/plugins` (or a file in
 * `src/adapters` / `src/plugins/ai.providers`) and restarting. What this route
 * gives the dashboard is visibility - which plugins the running server actually
 * loaded, which one is active, and what each one needs.
 */
import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { authenticate, loadWorkspace } from '../../middleware/auth.js';
import { env } from '../../config/env.js';
import { listAdapterCatalogue } from '../../adapters/registry.js';
import { listAiProviderManifests, listAiBehaviour, getAiProviderManifest } from '../../plugins/ai.loader.js';

const router = Router();

/** Credentials an AI provider needs, as NAMES only (never values). */
function providerAvailability(provider) {
  if (!provider.requiresKey || !provider.envKey) {
    return { available: true, missing: [], reason: 'Needs no credentials.' };
  }
  const missing = env[provider.envKey] ? [] : [provider.envKey];
  return {
    available: missing.length === 0,
    missing,
    reason: missing.length ? `Set ${missing.join(', ')} in backend/.env to activate this provider.` : 'Credentials present.',
  };
}

router.get(
  '/',
  authenticate,
  loadWorkspace,
  asyncHandler(async (_req, res) => {
    const providers = listAiProviderManifests().map((provider) => ({
      ...provider,
      active: provider.id === env.AI_PROVIDER,
      availability: providerAvailability(provider),
    }));

    res.json({
      channels: listAdapterCatalogue(),
      ai: {
        activeProvider: env.AI_PROVIDER,
        activeProviderLabel: getAiProviderManifest(env.AI_PROVIDER)?.label ?? env.AI_PROVIDER,
        providers,
        // Ordered exactly as the pipeline runs them, so the UI can show the
        // real stage order rather than a guess.
        behaviours: listAiBehaviour().map((behaviour) => ({
          id: behaviour.id,
          label: behaviour.label ?? behaviour.id,
          description: behaviour.description ?? '',
          order: behaviour.order ?? 100,
        })),
      },
      externalDir: env.CHANNEL_PLUGINS_DIR ?? null,
    });
  }),
);

export default router;
