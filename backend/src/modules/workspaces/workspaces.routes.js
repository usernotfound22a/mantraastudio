/**
 * Workspace (tenant) management.
 *
 * This module is where multi-tenancy becomes real: every row is scoped by
 * workspace_id, and the role guard is the only thing between an agent and the
 * billing page.
 *
 * Handlers and routes live together here because the module is small; larger
 * modules (conversations, messages) split into *.service.js / *.routes.js.
 *
 * Mounted at /api/workspaces
 */
import { Router } from 'express';
import { z } from 'zod';
import { selectRows, selectOne, updateRows, insertRow, deleteRows, callRpc } from '../../db/supabase.js';
import { childLogger } from '../../config/logger.js';
import { AppError, asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { authenticate, loadWorkspace, requireAdmin, requireOwner } from '../../middleware/auth.js';
import {
  countOwners,
  listAssignableAgents,
  listMembershipsForUser,
  listMembersOfWorkspace,
} from '../../services/membership.service.js';
import { mapMembership } from '../auth/auth.service.js';
import { emitToWorkspace, emitToUser } from '../../services/socket.service.js';
import { EVENTS } from '../../services/events.js';

const log = childLogger('workspaces');
const router = Router();

// Every route below needs a signed-in user.
router.use(authenticate);

// ---------------------------------------------------------------------------
// Schemas
// Plain `{ body?, query?, params? }` objects - see validate().
// ---------------------------------------------------------------------------
const ROLES = ['owner', 'admin', 'agent'];

const workspaceIdParam = z.object({ workspaceId: z.coerce.number().int().positive() });
const memberParams = z.object({
  workspaceId: z.coerce.number().int().positive(),
  memberId: z.coerce.number().int().positive(),
});

const createWorkspaceSchema = {
  body: z.object({
    name: z.string({ required_error: 'Workspace name is required' })
      .trim()
      .min(2, 'Enter a workspace name')
      .max(150, 'Workspace name is too long'),
  }),
};

const updateWorkspaceSchema = {
  body: z
    .object({
      name: z.string().trim().min(2).max(150).optional(),
      logoUrl: z.string().url('Enter a valid image URL').max(500).nullish(),
      timezone: z.string().max(64).optional(),
      supportName: z.string().trim().max(120).nullish(),
      aiEnabled: z.boolean().optional(),
      aiAutoSend: z.boolean().optional(),
      // { monday: ['09:00','17:00'], ... } - used by the AI for "are you open?".
      businessHours: z.record(z.string(), z.tuple([z.string(), z.string()])).nullish(),
    })
    .partial(),
};

const addMemberSchema = {
  body: z.object({
    email: z.string().trim().toLowerCase().email('Enter a valid email address'),
    role: z.enum(ROLES).default('agent'),
  }),
};

const updateMemberRoleSchema = {
  params: memberParams,
  body: z.object({ role: z.enum(ROLES) }),
};

const joinSchema = {
  body: z.object({
    slug: z.string().trim().min(2).max(150),
    inviteCode: z.string().trim().max(64).optional(),
  }),
};

/** Applies the auth + validate + role chain to one route. */
const workspaceRoute = (handler, ...middlewares) =>
  [loadWorkspace, ...middlewares, handler];

// ---------------------------------------------------------------------------
// Routes that do NOT need an active workspace context
// ---------------------------------------------------------------------------

/** GET /api/workspaces - every workspace the caller belongs to. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await listMembershipsForUser(req.user.id);
    res.json({ workspaces: rows.map(mapMembership) });
  }),
);

/** POST /api/workspaces - a user may own several workspaces. */
router.post(
  '/',
  validate(createWorkspaceSchema),
  asyncHandler(async (req, res) => {
    const { name } = req.body;
    const result = await callRpc('bootstrap_workspace', {
      p_full_name: req.user.full_name,
      p_workspace_name: name,
    });
    const workspace = await selectOne('workspaces', '*', { slug: result.workspace.slug });

    log.info({ workspaceId: workspace.id, userId: req.user.id }, 'Workspace created');
    res.status(201).json({ workspace: { ...mapMembership({ ...workspace, role: 'owner' }) } });
  }),
);

/**
 * POST /api/workspaces/join - join by slug.
 * `allowAnyoneToJoin` is the switch between an open demo and a closed beta with
 * invite codes. In production this must be `false`.
 */
const ALLOW_ANYONE_TO_JOIN = true;
router.post(
  '/join',
  validate(joinSchema),
  asyncHandler(async (req, res) => {
    const { slug, inviteCode } = req.body;
    if (!ALLOW_ANYONE_TO_JOIN && !inviteCode) {
      throw AppError.forbidden('This workspace requires an invite code');
    }
    const workspace = await callRpc('join_workspace', { p_slug: slug, p_invite_code: inviteCode ?? null });

    log.info({ workspaceId: workspace.id, userId: req.user.id }, 'User joined workspace');
    res.json({ workspace: mapMembership({ ...workspace, role: 'agent' }) });
  }),
);

// ---------------------------------------------------------------------------
// Routes scoped to a single workspace
// ---------------------------------------------------------------------------

/** GET /api/workspaces/:workspaceId - full workspace + team + subscription. */
router.get(
  '/:workspaceId',
  validate({ params: workspaceIdParam }),
  workspaceRoute(
    asyncHandler(async (req, res) => {
      res.json(await workspacePayload(req));
    }),
  ),
);

/** PATCH /api/workspaces/:workspaceId - owner/admin only. */
router.patch(
  '/:workspaceId',
  validate({ params: workspaceIdParam, ...updateWorkspaceSchema }),
  workspaceRoute(
    asyncHandler(async (req, res) => {
      const body = req.body;
      const changes = {};
      if (body.name !== undefined) changes.name = body.name;
      if (body.logoUrl != null) changes.logo_url = body.logoUrl;
      if (body.timezone !== undefined) changes.timezone = body.timezone;
      if (body.supportName != null) changes.support_name = body.supportName;
      if (body.aiEnabled !== undefined) changes.ai_enabled = body.aiEnabled ? 1 : 0;
      if (body.aiAutoSend !== undefined) changes.ai_auto_send = body.aiAutoSend ? 1 : 0;
      if (body.businessHours != null) changes.business_hours = body.businessHours;
      if (Object.keys(changes).length) await updateRows('workspaces', changes, { id: req.workspace.id });
      res.json(await workspacePayload(req));
    }),
    requireAdmin,
  ),
);

/** GET /api/workspaces/:workspaceId/members */
router.get(
  '/:workspaceId/members',
  validate({ params: workspaceIdParam }),
  workspaceRoute(
    asyncHandler(async (req, res) => {
      res.json({ members: (await listMembersOfWorkspace(req.workspace.id)).map(mapMemberRow) });
    }),
  ),
);

/** GET /api/workspaces/:workspaceId/agents - powers the "assign to" picker. */
router.get(
  '/:workspaceId/agents',
  validate({ params: workspaceIdParam }),
  workspaceRoute(
    asyncHandler(async (req, res) => {
      const agents = await listAssignableAgents(req.workspace.id);
      res.json({
        agents: agents.map((agent) => ({
          id: agent.id,
          name: agent.full_name,
          email: agent.email,
          avatarUrl: agent.avatar_url,
          role: agent.role,
        })),
      });
    }),
  ),
);

/** POST /api/workspaces/:workspaceId/members - add an existing user by email. */
router.post(
  '/:workspaceId/members',
  validate({ params: workspaceIdParam, ...addMemberSchema }),
  workspaceRoute(
    asyncHandler(async (req, res) => {
      const { email, role } = req.body;
      const user = await selectOne('users', 'id,email', { email });
      if (!user) throw AppError.notFound(`No SocialHub account found for ${email}`);

      const existing = await selectOne('workspace_members', 'id', {
        workspace_id: req.workspace.id,
        user_id: user.id,
      });
      if (existing) throw AppError.conflict(`${email} is already a member of this workspace`);
      if (role === 'owner' && req.member.role !== 'owner') {
        throw AppError.forbidden('Only an owner can add another owner');
      }

      await insertRow('workspace_members', {
        workspace_id: req.workspace.id,
        user_id: user.id,
        role,
        status: 'active',
        invited_by: req.user.id,
        joined_at: new Date().toISOString(),
      });
      log.info({ workspaceId: req.workspace.id, addedUserId: user.id, role }, 'Member added');

      // The new member's open tabs should switch to this workspace rather than
      // waiting for a manual reload, and the team list refreshes everywhere.
      emitToUser(user.id, EVENTS.MEMBER_ADDED, {
        workspaceId: req.workspace.id,
        workspaceName: req.workspace.name,
        role,
      });
      emitToWorkspace(req.workspace.id, EVENTS.MEMBER_ADDED, { userId: user.id, role });

      res.status(201).json({ members: (await listMembersOfWorkspace(req.workspace.id)).map(mapMemberRow) });
    }),
    requireAdmin,
  ),
);
/** PATCH /api/workspaces/:workspaceId/members/:memberId - change a role. */
router.patch(
  '/:workspaceId/members/:memberId',
  validate(updateMemberRoleSchema),
  workspaceRoute(
    asyncHandler(async (req, res) => {
      const { memberId } = req.params;
      const { role } = req.body;

      const member = await selectOne('workspace_members', '*', { id: memberId, workspace_id: req.workspace.id });
      if (!member) throw AppError.notFound('Member not found');
      if (member.user_id === req.user.id) throw AppError.forbidden('You cannot change your own role');
      if (member.role === 'owner' && role !== 'owner') await assertNotLastOwner(req.workspace.id);

      await updateRows('workspace_members', { role }, { id: memberId, workspace_id: req.workspace.id });
      log.info({ workspaceId: req.workspace.id, memberId, role }, 'Member role updated');

      // The team list is shared, and a role change can lock someone out of the
      // settings pages, so other tabs refresh immediately.
      emitToWorkspace(req.workspace.id, EVENTS.MEMBER_UPDATED, {
        memberId: Number(memberId),
        role,
      });

      res.json(await workspacePayload(req));
    }),
    requireAdmin,
  ),
);

/** DELETE /api/workspaces/:workspaceId/members/:memberId - remove someone. */
router.delete(
  '/:workspaceId/members/:memberId',
  validate({ params: memberParams }),
  workspaceRoute(
    asyncHandler(async (req, res) => {
      const { memberId } = req.params;
      const member = await selectOne('workspace_members', '*', { id: memberId, workspace_id: req.workspace.id });
      if (!member) throw AppError.notFound('Member not found');
      if (member.user_id === req.user.id) {
        throw AppError.badRequest('Use the leave endpoint to remove yourself');
      }
      if (member.role === 'owner' && req.member.role !== 'owner') {
        throw AppError.forbidden('Only an owner can remove an owner');
      }
      if (member.role === 'owner') await assertNotLastOwner(req.workspace.id);

      await deleteRows('workspace_members', { id: memberId, workspace_id: req.workspace.id });
      // The removed user's own tabs must drop this workspace, so the event also
      // goes to their personal room.
      emitToUser(member.user_id, EVENTS.MEMBER_REMOVED, {
        workspaceId: req.workspace.id,
      });
      emitToWorkspace(req.workspace.id, EVENTS.MEMBER_REMOVED, {
        memberId: Number(memberId),
        userId: member.user_id,
      });

      res.json(await workspacePayload(req));
    }),
    requireAdmin,
  ),
);

/** POST /api/workspaces/:workspaceId/leave - remove yourself from the team. */
router.post(
  '/:workspaceId/leave',
  validate({ params: workspaceIdParam }),
  workspaceRoute(
    asyncHandler(async (req, res) => {
      if (req.member.role === 'owner') await assertNotLastOwner(req.workspace.id);
      await deleteRows('workspace_members', { id: req.member.id, workspace_id: req.workspace.id });
      res.json({ success: true });
    }),
  ),
);

/** DELETE /api/workspaces/:workspaceId - owner only, blocked if it has data. */
router.delete(
  '/:workspaceId',
  validate({ params: workspaceIdParam }),
  workspaceRoute(
    asyncHandler(async (req, res) => {
      const [conversations, messages] = await Promise.all([
        selectRows('conversations', 'id', { workspace_id: req.workspace.id }, { limit: 1 }),
        selectRows('messages', 'id', { workspace_id: req.workspace.id }, { limit: 1 }),
      ]);
      if (conversations.length > 0 || messages.length > 0) {
        throw AppError.conflict(
          'This workspace already has conversations. Archive it instead of deleting it.',
        );
      }
      await deleteRows('workspaces', { id: req.workspace.id });
      log.info({ workspaceId: req.workspace.id }, 'Workspace deleted');
      res.json({ success: true });
    }),
    requireOwner,
  ),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Guards the "at least one owner" invariant. */
async function assertNotLastOwner(workspaceId) {
  const owners = await countOwners(workspaceId);
  if (owners.total <= 1) {
    throw AppError.badRequest('A workspace must keep at least one owner');
  }
}

/** Single response shape for the workspace + team + plan. */
async function workspacePayload(req) {
  const workspace = await selectOne('workspaces', '*', { id: req.workspace.id });
  const [members, subscription] = await Promise.all([
    listMembersOfWorkspace(req.workspace.id),
    selectOne('subscriptions', '*', { workspace_id: req.workspace.id }),
  ]);

  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      logoUrl: workspace.logo_url,
      timezone: workspace.timezone,
      locale: workspace.locale,
      supportName: workspace.support_name,
      aiEnabled: Boolean(workspace.ai_enabled),
      aiAutoSend: Boolean(workspace.ai_auto_send),
      businessHours: workspace.business_hours,
      settings: workspace.settings,
      createdAt: workspace.created_at,
    },
    myRole: req.member.role,
    members: members.map(mapMemberRow),
    subscription,
  };
}

/** "My Shop" -> "my-shop", adding -2, -3 ... when the slug is taken. */
/** DB membership+user row -> API shape. */
export function mapMemberRow(row) {
  return {
    membershipId: row.id,
    userId: row.user_id,
    name: row.full_name,
    email: row.email,
    avatarUrl: row.avatar_url,
    jobTitle: row.job_title,
    role: row.role,
    status: row.status,
    lastLoginAt: row.last_login_at,
    invitedAt: row.invited_at,
    joinedAt: row.joined_at,
  };
}

export default router;
