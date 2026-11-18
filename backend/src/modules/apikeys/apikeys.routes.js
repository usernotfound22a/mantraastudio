/**
 * Dashboard API for managing public API keys and outbound webhooks.
 *
 * These are the routes the SETTINGS screen calls. They are ordinary tenant
 * routes (JWT + workspace + role gated) - the customer-facing consumption of
 * the keys happens on /api/v1, which is entirely separate.
 *
 *   GET    /api/api-keys                    list keys (secrets never returned)
 *   POST   /api/api-keys                    create key -> secret shown ONCE
 *   DELETE /api/api-keys/:id                revoke
 *   GET    /api/webhooks                    list endpoints
 *   POST   /api/webhooks                    create endpoint -> secret ONCE
 *   PATCH  /api/webhooks/:id                update url/events/status
 *   POST   /api/webhooks/:id/rotate-secret   new signing secret
 *   POST   /api/webhooks/:id/enable         re-enable after auto-disable
 *   DELETE /api/webhooks/:id                delete
 *   GET    /api/webhooks/deliveries          recent delivery log
 *   GET    /api/webhooks/events             the subscribable event list
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { queryOf, validate } from '../../middleware/validate.js';
import { authenticate, loadWorkspace, requireAdmin } from '../../middleware/auth.js';import { API_SCOPES, createApiKey, listApiKeys, revokeApiKey } from '../../services/apikey.service.js';
import {
  WEBHOOK_EVENTS,
  createEndpoint,
  deleteEndpoint,
  enableEndpoint,
  listDeliveries,
  listEndpoints,
  rotateSecret,
  updateEndpoint,
} from '../../services/webhook.service.js';

const router = Router();

/** Every route here is a tenant route: JWT, workspace, admin, validated. */
router.use(authenticate, loadWorkspace, requireAdmin);

// ------------------------------------------------------------------ keys

router.get(
  '/api-keys',
  asyncHandler(async (req, res) => {
    res.json({ keys: await listApiKeys(req.workspace.id), scopes: API_SCOPES });
  }),
);

router.post(
  '/api-keys',
  validate({
    body: z.object({
      name: z.string().trim().min(1).max(120),
      scopes: z.array(z.string()).min(1),
      expiresInDays: z.coerce.number().int().positive().max(365).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { name, scopes, expiresInDays } = req.body;
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const { key, secret } = await createApiKey({
      workspaceId: req.workspace.id,
      name,
      scopes,
      createdBy: req.user.id,
      expiresAt,
    });

    // 201 + the secret in the body. This is the ONLY time it is ever sent.
    res.status(201).json({ key, secret });
  }),
);

router.delete(
  '/api-keys/:id',
  validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req, res) => {
    res.json({ key: await revokeApiKey(req.workspace.id, req.params.id) });
  }),
);

// -------------------------------------------------------------- webhooks

router.get(
  '/webhook-endpoints',
  asyncHandler(async (req, res) => {
    res.json({ endpoints: await listEndpoints(req.workspace.id), events: WEBHOOK_EVENTS });
  }),
);

router.get(
  '/webhook-endpoints/events',
  asyncHandler(async (_req, res) => {
    res.json({ events: WEBHOOK_EVENTS });
  }),
);

router.get(
  '/webhook-endpoints/deliveries',
  validate({
    query: z.object({
      endpointId: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(200).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ deliveries: await listDeliveries(req.workspace.id, queryOf(req)) });
  }),
);

router.post(
  '/webhook-endpoints',
  validate({
    body: z.object({
      url: z.string().url(),
      events: z.array(z.string()).min(1),
      description: z.string().trim().max(200).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { endpoint, signingSecret } = await createEndpoint({
      workspaceId: req.workspace.id,
      ...req.body,
    });
    // The signing secret is returned once, at creation.
    res.status(201).json({ endpoint, signingSecret });
  }),
);

router.patch(
  '/webhook-endpoints/:id',
  validate({
    params: z.object({ id: z.coerce.number().int().positive() }),
    body: z.object({
      url: z.string().url().optional(),
      events: z.array(z.string()).min(1).optional(),
      status: z.enum(['active', 'disabled']).optional(),
      description: z.string().trim().max(200).nullable().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ endpoint: await updateEndpoint(req.workspace.id, req.params.id, req.body) });
  }),
);

router.post(
  '/webhook-endpoints/:id/rotate-secret',
  validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req, res) => {
    res.json(await rotateSecret(req.workspace.id, req.params.id));
  }),
);

router.post(
  '/webhook-endpoints/:id/enable',
  validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req, res) => {
    res.json({ endpoint: await enableEndpoint(req.workspace.id, req.params.id) });
  }),
);

router.delete(
  '/webhook-endpoints/:id',
  validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req, res) => {
    res.json(await deleteEndpoint(req.workspace.id, req.params.id));
  }),
);

export default router;
