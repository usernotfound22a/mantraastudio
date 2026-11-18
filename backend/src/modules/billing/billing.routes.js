/**
 * Billing routes (Part 12).
 *
 * Read paths work without Stripe configured (the pricing page still renders);
 * anything that would move money fails closed with a 503.
 */
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, loadWorkspace, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/error.js';
import { getSubscription } from '../../services/subscription.service.js';
import {
  listPlans,
  billingSummary,
  createCheckoutSession,
  createPortalSession,
  isBillingEnabled,
  refundKhaltiTransaction,
} from '../../services/billing.service.js';

const router = Router();

/**
 * GET /api/billing/plans - the pricing table.
 *
 * Workspace-scoped so the response can mark the plan the caller is already on,
 * which is what lets the pricing page highlight it.
 */
router.get(
  '/plans',
  authenticate,
  loadWorkspace,
  asyncHandler(async (req, res) => {
    const subscription = await getSubscription(req.workspace.id);
    res.json({
      plans: listPlans(),
      currentPlanId: subscription?.plan ?? 'free',
      billingEnabled: isBillingEnabled(),
    });
  }),
);

/** GET /api/billing/subscription - current plan, usage and renewal state. */
router.get(
  '/subscription',
  authenticate,
  loadWorkspace,
  asyncHandler(async (req, res) => {
    res.json(await billingSummary(req.workspace.id));
  }),
);

/**
 * POST /api/billing/checkout
 *
 * Owner only: a workspace pays its own bill, so an agent must not be able to
 * start a purchase.
 */
router.post(
  '/checkout',
  authenticate,
  loadWorkspace,
  requireRole('owner'),
  validate({
    body: z.object({
      planId: z.enum(['starter', 'pro']),
      billingPeriod: z.enum(['monthly', 'yearly']).default('monthly'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { planId, billingPeriod } = req.body;
    const session = await createCheckoutSession({
      workspace: req.workspace,
      planId,
      billingPeriod,
    });
    res.status(201).json(session);
  }),
);

/**
 * POST /api/billing/portal - update card, download invoices, cancel.
 *
 * Takes no input on purpose: the return URL is server-controlled, so a client
 * cannot use this as an open redirect. The strict empty body catches a caller
 * that assumes it may pass a workspace or a plan.
 */
router.post(
  '/portal',
  authenticate,
  loadWorkspace,
  requireRole('owner'),
  validate({ body: z.object({}).strict() }),
  asyncHandler(async (req, res) => {
    const subscription = await getSubscription(req.workspace.id);
    res.json(await createPortalSession({ workspace: req.workspace, subscription }));
  }),
);

/** POST /api/billing/khalti/transactions/:transactionId/refund */
router.post(
  '/khalti/transactions/:transactionId/refund',
  authenticate,
  loadWorkspace,
  requireRole('owner'),
  validate({
    params: z.object({
      transactionId: z.string().trim().min(1).max(191).regex(/^[A-Za-z0-9_-]+$/),
    }),
    body: z.object({
      amount: z.number().int().positive().optional(),
      mobile: z.string().trim().regex(/^\+?\d{7,15}$/).optional(),
    }).strict(),
  }),
  asyncHandler(async (req, res) => {
    const result = await refundKhaltiTransaction({
      transactionId: req.params.transactionId,
      amount: req.body.amount,
      mobile: req.body.mobile,
    });
    res.json(result);
  }),
);

export default router;
