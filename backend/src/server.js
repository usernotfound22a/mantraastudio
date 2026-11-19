/**
 * Server entry point.
 *
 * Responsibilities, in order:
 *   1. verify Supabase is reachable (fail fast with an actionable message)
 *   2. start the HTTP server
 *   3. attach Socket.IO
 *   4. handle SIGINT/SIGTERM gracefully (stop accepting, close sockets, close DB)
 */
import http from 'node:http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { createApp } from './app.js';
import { pingSupabase } from './db/supabase.js';
import { initSocket, closeSocket } from './services/socket.service.js';
import { startWebhookWorker, stopWebhookWorker } from './services/webhook.service.js';
import { ensureAdaptersLoaded } from './adapters/factory.js';
import { loadAiPlugins } from './plugins/ai.loader.js';
import { loadMetaSettings } from './services/meta-settings.service.js';

async function start() {
  // 0. Discover channel adapters + AI plugins ------------------------------
  // Channel adapters: every .js file in src/adapters/ plus any plugins/<name>/
  // folder is imported and registered, so a new channel needs no wiring.
  // AI: providers (offline/openai/groq + plugins/ai/*) and behaviour stages.
  // A broken channel adapter aborts the boot instead of silently disabling it.
  await ensureAdaptersLoaded();
  await loadAiPlugins();

  // 1. Supabase pre-flight -------------------------------------------------
  try {
    const latency = await pingSupabase();
    logger.info(
      { latencyMs: latency },
      'Supabase connection OK',
    );
  } catch (error) {
    logger.error(
      { code: error.code, message: error.message },
      'Cannot reach Supabase - server not starting',
    );
    logger.error('Fix: set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and SUPABASE_SECRET_KEY, then apply the Supabase migration');
    process.exit(1);
  }

  await loadMetaSettings();

  // 2. HTTP + Socket.IO ---------------------------------------------------
  const app = createApp();
  const server = http.createServer(app);
  initSocket(server);

  // 2b. Outbound webhook worker -------------------------------------------
  // Delivers queued customer webhooks in the background, so the request that
  // triggered the event is never slowed down by a customer's dead URL.
  startWebhookWorker();

  server.listen(env.PORT, () => {
    logger.info(
      {
        port: env.PORT,
        env: env.NODE_ENV,
        cors: env.CORS_ORIGINS,
        health: `http://localhost:${env.PORT}/api/health`,
      },
      `Mantraa Studio API listening on http://localhost:${env.PORT}`,
    );
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      logger.error({ port: env.PORT }, 'Port is already in use - stop the other process or change PORT');
    } else {
      logger.error({ err: error }, 'Server error');
    }
    process.exit(1);
  });

  // 3. Graceful shutdown --------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down gracefully');

    // Stop accepting new connections, then tear down the rest.
    const forceExit = setTimeout(() => {
      logger.error('Shutdown took too long - forcing exit');
      process.exit(1);
    }, 10000);
    forceExit.unref();

    try {
      stopWebhookWorker();
      await closeSocket();
      await new Promise((resolve) => server.close(resolve));
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Never die silently on an unexpected exception - log it and let the
  // supervisor (or the developer) restart.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception - exiting');
    shutdown('uncaughtException');
  });
}

start();
