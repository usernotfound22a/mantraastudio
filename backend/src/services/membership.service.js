import { selectRows, selectOne } from '../db/supabase.js';

const roleOrder = { owner: 0, admin: 1, agent: 2 };

export async function listMembershipsForUser(userId) {
  const memberships = await selectRows('workspace_members', '*', { user_id: userId });
  const rows = await Promise.all(
    memberships.map(async (membership) => {
      const workspace = await selectOne('workspaces', '*', { id: membership.workspace_id });
      return workspace ? { ...workspace, ...membership } : null;
    }),
  );
  return rows
    .filter(Boolean)
    .sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || a.name.localeCompare(b.name));
}

export const findMembership = async (userId, workspaceId) =>
  selectOne('workspace_members', '*', { user_id: userId, workspace_id: workspaceId });

export async function listMembersOfWorkspace(workspaceId) {
  const memberships = await selectRows(
    'workspace_members',
    '*',
    { workspace_id: workspaceId },
  );
  const rows = await Promise.all(
    memberships.map(async (membership) => {
      const user = await selectOne(
        'users',
        'id,email,full_name,avatar_url,job_title,last_login_at',
        { id: membership.user_id },
      );
      return user ? { ...membership, ...user, user_id: user.id } : null;
    }),
  );
  return rows
    .filter(Boolean)
    .sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || a.full_name.localeCompare(b.full_name));
}

export async function countOwners(workspaceId) {
  const owners = await selectRows('workspace_members', 'id', {
    workspace_id: workspaceId,
    role: 'owner',
    status: 'active',
  });
  return { total: owners.length };
}

export async function listAssignableAgents(workspaceId) {
  const memberships = await selectRows('workspace_members', '*', {
    workspace_id: workspaceId,
    status: 'active',
  });
  const rows = await Promise.all(
    memberships.map(async (membership) => {
      const user = await selectOne('users', 'id,full_name,email,avatar_url', {
        id: membership.user_id,
      });
      return user ? { ...user, role: membership.role } : null;
    }),
  );
  return rows.filter(Boolean).sort((a, b) => a.full_name.localeCompare(b.full_name));
}
