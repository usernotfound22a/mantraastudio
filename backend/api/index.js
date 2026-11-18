import { createApp } from '../src/app.js';
import { ensureAdaptersLoaded } from '../src/adapters/factory.js';
import { loadAiPlugins } from '../src/plugins/ai.loader.js';
import { loadMetaSettings } from '../src/services/meta-settings.service.js';
import { pingDatabase } from '../src/db/pool.js';

let appPromise;

async function initializeApp() {
  await ensureAdaptersLoaded();
  await loadAiPlugins();
  await pingDatabase();
  await loadMetaSettings();
  return createApp();
}

export default async function handler(req, res) {
  appPromise ??= initializeApp();

  try {
    const app = await appPromise;
    app(req, res);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message: 'Backend initialization failed', code: 'INIT_FAILED' }));
  }
}
