/**
 * Auth routes. Every handler is a one-liner: validate -> call service -> json.
 *
 * Mounted at /api/auth
 */
import { Router } from 'express';
import { asyncHandler, AppError } from '../../middleware/error.js';
import { authenticate } from '../../middleware/auth.js';
import { authLimiter } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import * as authService from './auth.service.js';
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  changePasswordSchema,
  updateProfileSchema,
} from './auth.schemas.js';

const router = Router();

/** POST /api/auth/register -> create account + first workspace */
router.post(
  '/register',
  authLimiter,
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.register(req.body);
    res.status(201).json(result);
  }),
);

/** POST /api/auth/oauth -> complete a Supabase OAuth sign-in with a bearer token */
router.post(
  '/oauth',
  authLimiter,
  asyncHandler(async (req, res) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) throw AppError.unauthorized('Missing access token');
    res.json(await authService.completeOAuth(token));
  }),
);

/** POST /api/auth/login */
router.post(
  '/login',
  authLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.login(req.body);
    res.json(result);
  }),
);

/** POST /api/auth/refresh -> new access token from a refresh token */
router.post(
  '/refresh',
  validate(refreshSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.refresh(req.body.refreshToken);
    res.json(result);
  }),
);

/** GET /api/auth/me -> profile + workspaces (used on app boot) */
router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await authService.getProfile(req.user.id));
  }),
);

/** PATCH /api/auth/me -> update own profile */
router.patch(
  '/me',
  authenticate,
  validate(updateProfileSchema),
  asyncHandler(async (req, res) => {
    res.json(await authService.updateProfile(req.user.id, req.body));
  }),
);

/** POST /api/auth/change-password */
router.post(
  '/change-password',
  authenticate,
  validate(changePasswordSchema),
  asyncHandler(async (req, res) => {
    res.json(await authService.changePassword(req.user.id, req.body));
  }),
);

/**
 * POST /api/auth/logout
 * Tokens are stateless, so the client discards them. The endpoint exists so
 * the frontend has a single place to call and we can log the event.
 */
router.post(
  '/logout',
  authenticate,
  asyncHandler(async (req, res) => {
    await authService.logout();
    req.log.info({ userId: req.user.id }, 'User logged out');
    res.json({ success: true });
  }),
);

export default router;
