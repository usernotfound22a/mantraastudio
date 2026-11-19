import { createUserClient, withSupabaseClient, selectOne } from '../db/supabase.js';
import { findMembership } from '../services/membership.service.js';
import { AppError, asyncHandler } from './error.js';

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return req.query?.access_token || null;
}

async function resolveUser(token) {
  const client = createUserClient(token);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw AppError.unauthorized('Invalid or expired access token');
  const profile = await withSupabaseClient(client, () =>
    selectOne('users', 'id,email,full_name,avatar_url,job_title,status,auth_user_id', {
      auth_user_id: data.user.id,
    }),
  );
  if (!profile) throw AppError.unauthorized('Account profile is not ready');
  if (profile.status === 'disabled') throw AppError.forbidden('Account is disabled');
  return { client, profile, authUser: data.user };
}

export const authenticate = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) throw AppError.unauthorized('Missing access token');
  const { client, profile, authUser } = await resolveUser(token);
  req.user = profile;
  req.authUser = authUser;
  req.accessToken = token;
  withSupabaseClient(client, next);
});

export const optionalAuthenticate = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) return next();
  try {
    const { client, profile, authUser } = await resolveUser(token);
    if (profile.status === 'active') {
      req.user = profile;
      req.authUser = authUser;
      req.accessToken = token;
      return withSupabaseClient(client, next);
    }
  } catch {
    // Invalid tokens are anonymous on routes that support guest access.
  }
  return next();
});

export const loadWorkspace = asyncHandler(async (req, res, next) => {
  const workspaceId =
    req.params.workspaceId ?? req.query.workspaceId ?? req.headers['x-workspace-id'];
  if (!workspaceId) throw AppError.badRequest('X-Workspace-Id header is required');

  const workspace = await selectOne(
    'workspaces',
    'id,name,slug,logo_url,timezone,locale,ai_enabled,ai_auto_send,settings',
    { id: workspaceId },
  );
  if (!workspace) throw AppError.notFound('Workspace not found');
  const membership = await findMembership(req.user.id, workspace.id);
  if (!membership) throw AppError.forbidden('You are not a member of this workspace');
  if (membership.status !== 'active') {
    throw AppError.forbidden('Your membership is not active yet');
  }

  req.workspace = workspace;
  req.member = membership;
  next();
});

export const requireRole = (...roles) => {
  const guard = (req, res, next) => {
    if (!req.member) return next(AppError.forbidden('Workspace context missing'));
    if (!roles.includes(req.member.role)) {
      return next(AppError.forbidden(`This action requires one of: ${roles.join(', ')}`));
    }
    return next();
  };
  guard.requiresRoles = roles;
  return guard;
};

export const requireAdmin = requireRole('owner', 'admin');
export const requireOwner = requireRole('owner');
