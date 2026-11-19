import { createApp } from '../src/app.js';
import { ensureAdaptersLoaded } from '../src/adapters/factory.js';
import { loadAiPlugins } from '../src/plugins/ai.loader.js';
import { loadMetaSettings } from '../src/services/meta-settings.service.js';
import { pingSupabase } from '../src/db/supabase.js';
import { childLogger } from '../src/config/logger.js';

const log = childLogger('vercel-handler');

let appPromise;

async function initializeApp() {
  await ensureAdaptersLoaded();
  await loadAiPlugins();
  await pingSupabase();
  await loadMetaSettings();
  return createApp();
}

export default async function handler(req, res) {
  appPromise ??= initializeApp();

  try {
    const app = await appPromise;
    app(req, res);
  } catch (error) {
    console.error(
      '[vercel] Backend initialization failed:',
      error?.stack ?? error?.message ?? error,
    );
    log.error(
      { error: { name: error?.name, message: error?.message, stack: error?.stack } },
      'Backend initialization failed',
    );
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message: 'Backend initialization failed', code: 'INIT_FAILED' }));
  }
}
