/**
 * Workspace membership lookups.
 *
 * Shared by the auth middleware and the workspaces module so the
 * "is this user allowed to touch this tenant?" question has exactly one
 * implementation.
 */
import { query, queryOne } from '../db/pool.js';

/** Every workspace the user belongs to, with their role. */
export const listMembershipsForUser = (userId) =>
  query(
    `SELECT w.id, w.name, w.slug, w.logo_url, w.timezone, w.ai_enabled,
            m.role, m.status, m.joined_at
       FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = ?
      ORDER BY FIELD(m.role, 'owner', 'admin', 'agent'), w.name ASC`,
    [userId],
  );

/**
 * Finds a membership row or null.
 * @returns {Promise<{id:number, workspace_id:number, user_id:number, role:string, status:string}|null>}
 */
export const findMembership = (userId, workspaceId) =>
  queryOne(
    `SELECT id, workspace_id, user_id, role, status, joined_at
       FROM workspace_members
      WHERE user_id = ? AND workspace_id = ?
      LIMIT 1`,
    [userId, workspaceId],
  );

/** Memberships for a workspace, joined with the user profile. */
export const listMembersOfWorkspace = (workspaceId) =>
  query(
    `SELECT m.id, m.role, m.status, m.invited_at, m.joined_at,
            u.id AS user_id, u.email, u.full_name, u.avatar_url, u.job_title, u.last_login_at
       FROM workspace_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ?
      ORDER BY FIELD(m.role, 'owner', 'admin', 'agent'), u.full_name ASC`,
    [workspaceId],
  );

/** How many owners a workspace has (protects against removing the last one). */
export const countOwners = (workspaceId) =>
  queryOne(
    `SELECT COUNT(*) AS total FROM workspace_members
      WHERE workspace_id = ? AND role = 'owner' AND status = 'active'`,
    [workspaceId],
  );

/** Agents that can be assigned to a conversation. */
export const listAssignableAgents = (workspaceId) =>
  query(
    `SELECT u.id, u.full_name, u.email, u.avatar_url, m.role
       FROM workspace_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ? AND m.status = 'active'
      ORDER BY u.full_name ASC`,
    [workspaceId],
  );
