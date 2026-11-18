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
import { query, queryOne, withTransaction, txExecute, txQuery } from '../../db/pool.js';
import { childLogger } from '../../config/logger.js';
import { AppError, asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { authenticate, loadWorkspace, requireAdmin, requireOwner } from '../../middleware/auth.js';
import {
  countOwners,
  listAssignableAgents,
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
    const rows = await query(
      `SELECT w.id, w.name, w.slug, w.logo_url, w.timezone, w.ai_enabled, m.role, m.joined_at
         FROM workspace_members m
         JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = ?`,
      [req.user.id],
    );
    res.json({ workspaces: rows.map(mapMembership) });
  }),
);

/** POST /api/workspaces - a user may own several workspaces. */
router.post(
  '/',
  validate(createWorkspaceSchema),
  asyncHandler(async (req, res) => {
    const { name } = req.body;
    const workspace = await withTransaction(async (client) => {
      const slug = await uniqueSlug(name, client);
      const result = await txExecute(
        client,
        'INSERT INTO workspaces (name, slug, created_by, support_name) VALUES (?, ?, ?, ?)',
        [name, slug, req.user.id, name],
      );
      await txExecute(
        client,
        `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
         VALUES (?, ?, 'owner', 'active', NOW())`,
        [result.insertId, req.user.id],
      );
      await txExecute(
        client,
        `INSERT INTO subscriptions (workspace_id, plan, status) VALUES (?, 'free', 'active')`,
        [result.insertId],
      );
      const [row] = await txQuery(client, 'SELECT * FROM workspaces WHERE id = ?', [result.insertId]);
      return row;
    });

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
    const workspace = await queryOne('SELECT * FROM workspaces WHERE slug = ?', [slug]);
    if (!workspace) throw AppError.notFound('No workspace with that link');

    const existing = await queryOne(
      'SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      [workspace.id, req.user.id],
    );

    if (existing) {
      if (existing.status === 'active') {
        throw AppError.conflict('You are already a member of this workspace');
      }
      // Pending invite -> accept it.
      await query(
        `UPDATE workspace_members SET status = 'active', joined_at = NOW() WHERE id = ?`,
        [existing.id],
      );
    } else {
      if (!ALLOW_ANYONE_TO_JOIN && !inviteCode) {
        throw AppError.forbidden('This workspace requires an invite code');
      }
      await query(
        `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
         VALUES (?, ?, 'agent', 'active', NOW())`,
        [workspace.id, req.user.id],
      );
    }

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
      await query(
        `UPDATE workspaces SET
            name           = COALESCE(?, name),
            logo_url       = COALESCE(?, logo_url),
            timezone       = COALESCE(?, timezone),
            support_name   = COALESCE(?, support_name),
            ai_enabled     = COALESCE(?, ai_enabled),
            ai_auto_send   = COALESCE(?, ai_auto_send),
            business_hours = COALESCE(?, business_hours)
          WHERE id = ?`,
        [
          body.name ?? null,
          body.logoUrl ?? null,
          body.timezone ?? null,
          body.supportName ?? null,
          body.aiEnabled === undefined ? null : body.aiEnabled ? 1 : 0,
          body.aiAutoSend === undefined ? null : body.aiAutoSend ? 1 : 0,
          body.businessHours ? JSON.stringify(body.businessHours) : null,
          req.workspace.id,
        ],
      );
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
      const user = await queryOne('SELECT id, email FROM users WHERE email = ?', [email]);
      if (!user) throw AppError.notFound(`No SocialHub account found for ${email}`);

      const existing = await queryOne(
        'SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
        [req.workspace.id, user.id],
      );
      if (existing) throw AppError.conflict(`${email} is already a member of this workspace`);
      if (role === 'owner' && req.member.role !== 'owner') {
        throw AppError.forbidden('Only an owner can add another owner');
      }

      await query(
        `INSERT INTO workspace_members (workspace_id, user_id, role, status, invited_by, joined_at)
         VALUES (?, ?, ?, 'active', ?, NOW())`,
        [req.workspace.id, user.id, role, req.user.id],
      );
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

      const member = await queryOne(
        'SELECT * FROM workspace_members WHERE id = ? AND workspace_id = ?',
        [memberId, req.workspace.id],
      );
      if (!member) throw AppError.notFound('Member not found');
      if (member.user_id === req.user.id) throw AppError.forbidden('You cannot change your own role');
      if (member.role === 'owner' && role !== 'owner') await assertNotLastOwner(req.workspace.id);

      await query('UPDATE workspace_members SET role = ? WHERE id = ?', [role, memberId]);
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
      const member = await queryOne(
        'SELECT * FROM workspace_members WHERE id = ? AND workspace_id = ?',
        [memberId, req.workspace.id],
      );
      if (!member) throw AppError.notFound('Member not found');
      if (member.user_id === req.user.id) {
        throw AppError.badRequest('Use the leave endpoint to remove yourself');
      }
      if (member.role === 'owner' && req.member.role !== 'owner') {
        throw AppError.forbidden('Only an owner can remove an owner');
      }
      if (member.role === 'owner') await assertNotLastOwner(req.workspace.id);

      await query('DELETE FROM workspace_members WHERE id = ?', [memberId]);
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
      await query('DELETE FROM workspace_members WHERE id = ?', [req.member.id]);
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
      const counts = await queryOne(
        `SELECT (SELECT COUNT(*) FROM conversations WHERE workspace_id = ?) AS conversations,
                (SELECT COUNT(*) FROM messages WHERE workspace_id = ?)     AS messages`,
        [req.workspace.id, req.workspace.id],
      );
      if (counts.conversations > 0 || counts.messages > 0) {
        throw AppError.conflict(
          'This workspace already has conversations. Archive it instead of deleting it.',
        );
      }
      await query('DELETE FROM workspaces WHERE id = ?', [req.workspace.id]);
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
  const workspace = await queryOne('SELECT * FROM workspaces WHERE id = ?', [req.workspace.id]);
  const [members, subscription] = await Promise.all([
    listMembersOfWorkspace(req.workspace.id),
    queryOne('SELECT * FROM subscriptions WHERE workspace_id = ?', [req.workspace.id]),
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
async function uniqueSlug(name, client) {
  const base =
    name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workspace';
  const rows = await txQuery(
    client,
    'SELECT slug FROM workspaces WHERE slug = ? OR slug LIKE ?',
    [base, `${base}-%`],
  );
  return rows.length === 0 ? base : `${base}-${rows.length + 1}`;
}

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
