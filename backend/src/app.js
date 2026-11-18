/**
 * Express application.
 *
 * Kept separate from server.js on purpose: app.js builds the middleware stack
 * and can be imported by tests (supertest) without opening a port.
 *
 * Middleware order matters:
 *   security -> cors -> logging -> body parsers -> rate limit -> routes -> 404 -> errors
 */
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'node:url';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import pinoHttp from 'pino-http';
import { env, logConfigWarnings } from './config/env.js';
import { logger } from './config/logger.js';
import { apiLimiter, publicLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler, asyncHandler, AppError } from './middleware/error.js';
import { handleWebhook } from './services/billing.service.js';
import apiRoutes from './routes/index.js';
import v1Routes from './modules/apikeys/v1.routes.js';
import webhookRoutes from './modules/webhooks/webhooks.routes.js';
import widgetRoutes from './modules/widget/widget.routes.js';
import { UPLOAD_DIR } from './modules/messages/uploads.routes.js';
import { isMetaConfigured } from './services/meta-settings.service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** The widget script lives with the other front-end code, not in the API. */
// backend/src -> backend -> socialhub -> frontend/widget
// Three ".." would escape the project entirely and silently 404 the widget.
const WIDGET_DIR = path.resolve(here, '../../frontend/widget');

/**
 * Builds the Express app.
 *
 * IMPORTANT: call `await ensureAdaptersLoaded()` BEFORE this (server.js does).
 * Adapter discovery is async because it imports files from disk, and a
 * half-loaded registry would reject valid channel types.
 */
export function createApp() {
  const app = express();

  // Behind a tunnel/proxy (ngrok, Cloudflare) so rate limiting and logs see
  // the real client IP.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // --- Security headers -------------------------------------------------
  app.use(
    helmet({
      // The API serves JSON only; CSP is the frontend's job.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // --- CORS -------------------------------------------------------------
  app.use((req, res, next) => {
    const isPublicWidgetRoute = req.path.startsWith('/api/widget/');
    cors({
      origin(origin, callback) {
        // Widget routes need to run on customer sites; their widget key and
        // WebsiteAdapter domain allow-list authorize requests at the handler.
        if (isPublicWidgetRoute && origin) return callback(null, true);
        // Allow same-origin/non-browser callers (curl, server-to-server).
        if (!origin) return callback(null, true);
        if (env.CORS_ORIGINS.includes(origin)) return callback(null, true);
        return callback(new Error(`Origin ${origin} is not allowed by CORS`));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Workspace-Id', 'X-Requested-With'],
      exposedHeaders: ['X-Total-Count', 'X-Page'],
      maxAge: 86400,
    })(req, res, next);
  });

  // --- Request logging --------------------------------------------------
  app.use(
    pinoHttp({
      logger,
      // Health checks would otherwise flood the log during the demo.
      autoLogging: { ignore: (req) => req.url === '/api/health' },
      customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'debug';
      },
    }),
  );

  // --- Webhooks (mounted BEFORE the JSON parser) ------------------------
  // Stripe first, and this ordering is load-bearing. `webhookRoutes` ends in a
  // catch-all `/:channelType` POST, so mounting it first would swallow
  // /api/webhooks/stripe and answer 404 "unknown channel" before the Stripe
  // handler ever ran. Stripe also signs the raw bytes (`constructEvent` needs
  // the exact buffer), hence the local express.raw() ahead of express.json().
  app.post(
    '/api/webhooks/stripe',
    express.raw({ type: 'application/json', limit: '1mb' }),
    asyncHandler(async (req, res) => {
      const signature = req.get('stripe-signature');
      if (!signature) throw AppError.badRequest('Missing stripe-signature header');
      // Any throw here becomes a 4xx/5xx, which is exactly what Stripe needs to
      // decide whether to retry the event.
      const result = await handleWebhook(req.body, signature);
      res.json(result);
    }),
  );

  // Meta signs the raw request body with an HMAC. Re-serialising a parsed
  // object changes the bytes and breaks verification, so this router uses its
  // own express.raw() parser and must run before express.json() below.
  app.use('/api/webhooks', webhookRoutes);

  // --- Body parsing -----------------------------------------------------
  // Webhook routes get a bigger limit (Meta sends base64 attachments) and
  // override this locally with their own parser.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Widget routes validate JSON request bodies, so they must follow the body
  // parsers. Their own public limiter runs before the general API limiter.
  app.use('/api/widget', widgetRoutes);

  // --- Compression ------------------------------------------------------
  app.use(compression());

  // --- Rate limiting ----------------------------------------------------
  app.use('/api', apiLimiter);

  // --- Static uploads ----------------------------------------------------
  // Agent attachments live in backend/uploads and are served read-only. The
  // filenames are uuids (see uploads.routes.js), and `nosniff` stops a browser
  // from re-interpreting an uploaded .txt as HTML.
  app.use(
    '/uploads',
    express.static(UPLOAD_DIR, {
      maxAge: '7d',
      index: false,
      dotfiles: 'deny',
      setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      },
    }),
  );

  // --- The embeddable widget script --------------------------------------
  // Served from the API so the embed snippet a customer pastes into their own
  // site is one stable URL with no build step and no bundler. It lives in
  // frontend/widget because it is a front-end asset, but the API serves it so
  // the whole system still runs from one origin.
  app.use(
    '/widget',
    express.static(WIDGET_DIR, {
      index: 'index.html',
      // These tiny assets change with app releases; clients should revalidate.
      maxAge: 0,
      setHeaders: (res, filePath) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (filePath.toLowerCase().endsWith('.html')) {
          // The public widget harness is intentionally embedded by the dashboard
          // and customer sites; allow framing only for these widget documents.
          res.removeHeader('X-Frame-Options');
          res.setHeader('Content-Security-Policy', 'frame-ancestors *');
        }
      },
    }),
  );

  // --- Routes -----------------------------------------------------------
  app.get('/', (req, res) => {
    res.json({
      name: 'SocialHub API',
      version: '1.0.0',
      docs: 'See /api/health and backend/README.md',
      workspaceHint: 'Tenant routes require the X-Workspace-Id header.',
    });
  });

  // --- Public API v1 ------------------------------------------------------
  // Mounted outside the dashboard router on purpose: it authenticates with an
  // API key + scopes, not a user JWT, and there is no X-Workspace header - the
  // workspace comes from the key, so an integration cannot reach another tenant.
  app.use('/api/v1', publicLimiter, v1Routes);

  // Keep the broader dashboard router after /api/v1. Its API-key settings
  // module applies JWT auth at the router root and would otherwise intercept
  // public API requests before their API-key middleware runs.
  app.use('/api', apiRoutes);

  // --- Fallbacks (must be last) -----------------------------------------
  app.use(notFoundHandler);
  app.use(errorHandler);

  // Non-fatal config warnings at boot.
  const warnings = logConfigWarnings({ metaConfigured: isMetaConfigured() });
  if (warnings.length) warnings.forEach((warning) => logger.warn(warning));

  return app;
}

export default createApp;
