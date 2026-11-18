/**
 * API route registry.
 *
 * Mounted at /api in app.js. Feature modules are added here as they are built;
 * the list doubles as the project's API map (useful in the FYP report).
 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { pingDatabase, queryOne } from '../db/pool.js';
import authRoutes from '../modules/auth/auth.routes.js';
import workspaceRoutes from '../modules/workspaces/workspaces.routes.js';
import channelRoutes from '../modules/channels/channels.routes.js';
import conversationRoutes from '../modules/conversations/conversations.routes.js';
import faqRoutes from '../modules/faqs/faqs.routes.js';
import uploadRoutes from '../modules/uploads/uploads.routes.js';
import analyticsRoutes from '../modules/analytics/analytics.routes.js';
import billingRoutes from '../modules/billing/billing.routes.js';
import apiKeyRoutes from '../modules/apikeys/apikeys.routes.js';
import pluginRoutes from '../modules/plugins/plugins.routes.js';

const router = Router();

/**
 * GET /api/health
 * Liveness + readiness in one: 200 only when MySQL answers, so a load
 * balancer / demo grader can tell the difference between "up" and "usable".
 */
router.get(
  '/health',
  asyncHandler(async (req, res) => {
    const startedAt = Date.now();
    let database = 'up';
    try {
      await pingDatabase();
    } catch {
      database = 'down';
    }

    const tableCheck = database === 'up'
      ? await queryOne('SELECT COUNT(*) AS total FROM users').catch(() => null)
      : null;

    res.status(database === 'up' ? 200 : 503).json({
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      users: tableCheck ? tableCheck.total : null,
      uptimeSeconds: Math.round(process.uptime()),
      latencyMs: Date.now() - startedAt,
      version: process.env.npm_package_version ?? '1.0.0',
      timestamp: new Date().toISOString(),
    });
  }),
);

// --- Feature routes -------------------------------------------------------
router.use('/auth', authRoutes);
router.use('/workspaces', workspaceRoutes);
router.use('/channels', channelRoutes);
router.use('/conversations', conversationRoutes);
router.use('/faqs', faqRoutes);
router.use('/uploads', uploadRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/billing', billingRoutes);
// Public API management (dashboard-facing). The customer-facing consumption
// side is mounted separately at /api/v1 in app.js.
router.use('/', apiKeyRoutes);
router.use('/plugins', pluginRoutes);

/*
  Public routes are mounted directly in app.js, BEFORE the JSON body parser,
  because their signature checks need the unparsed body:
    /api/webhooks/:channelType   -> modules/webhooks/webhooks.routes.js
    /api/webhooks/stripe         -> Stripe signature check (app.js)
    /api/widget                 -> modules/widget/widget.routes.js
*/

export default router;
