/**
 * Auth business logic. Routes stay thin; everything that touches the database
 * or hashes a password lives here.
 */
import bcrypt from 'bcryptjs';
import { env } from '../../config/env.js';
import { childLogger } from '../../config/logger.js';
import { query, queryOne, withTransaction, txQuery, txExecute } from '../../db/pool.js';
import { AppError } from '../../middleware/error.js';
import { issueTokenPair, signAccessToken, verifyToken } from '../../services/token.service.js';
import { listMembershipsForUser } from '../../services/membership.service.js';

const log = childLogger('auth');

/** Never leak the password hash to a client. */
export const publicUser = (user) => ({
  id: user.id,
  email: user.email,
  fullName: user.full_name,
  avatarUrl: user.avatar_url,
  jobTitle: user.job_title,
  createdAt: user.created_at,
});

/** Turns "My Shop" into "my-shop" (+ "-2" if taken). */
async function buildSlug(workspaceName, client) {
  const base =
    workspaceName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'workspace';
  const rows = await txQuery(
    client,
    'SELECT slug FROM workspaces WHERE slug = ? OR slug LIKE ?',
    [base, `${base}-%`],
  );
  return rows.length === 0 ? base : `${base}-${rows.length + 1}`;
}

/**
 * POST /api/auth/register
 * Creates the user, their first workspace (as owner) and a free subscription
 * in ONE transaction - so we never end up with a user who owns nothing.
 */
export async function register({ email, password, fullName, workspaceName }) {
  const existing = await queryOne('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) throw AppError.conflict('An account with that email already exists');

  const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);

  const { user, workspace } = await withTransaction(async (client) => {
    const userResult = await txExecute(
      client,
      `INSERT INTO users (email, password_hash, full_name)
       VALUES (?, ?, ?)`,
      [email, passwordHash, fullName],
    );
    const userId = userResult.insertId;

    const slug = await buildSlug(workspaceName, client);
    const workspaceResult = await txExecute(
      client,
      `INSERT INTO workspaces (name, slug, created_by, support_name)
       VALUES (?, ?, ?, ?)`,
      [workspaceName, slug, userId, workspaceName],
    );
    const workspaceId = workspaceResult.insertId;

    await txExecute(
      client,
      `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
       VALUES (?, ?, 'owner', 'active', NOW())`,
      [workspaceId, userId],
    );

    // Every workspace starts on the free plan; billing upgrades it later.
    await txExecute(
      client,
      `INSERT INTO subscriptions (workspace_id, plan, status, seats, messages_limit, ai_replies_limit)
       VALUES (?, 'free', 'active', 3, 100, 50)`,
      [workspaceId],
    );

    const [createdUser] = await txQuery(client, 'SELECT * FROM users WHERE id = ?', [userId]);
    return {
      user: createdUser,
      workspace: { id: workspaceId, name: workspaceName, slug, role: 'owner' },
    };
  });

  log.info({ userId: user.id, workspaceId: workspace.id }, 'New account registered');

  return {
    user: publicUser(user),
    workspace,
    tokens: issueTokenPair(user),
  };
}

/**
 * POST /api/auth/login
 * Returns 401 with a deliberately vague message: we must not reveal whether an
 * email exists (that would leak the customer list).
 */
export async function login({ email, password }) {
  const user = await queryOne('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);

  if (!user) {
    // Burn a little CPU so timing does not reveal that the user is missing.
    await bcrypt.compare(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvaliduO');
    throw AppError.unauthorized('Incorrect email or password');
  }
  if (user.status === 'disabled') throw AppError.forbidden('This account is disabled');

  const passwordMatches = user.password_hash
    ? await bcrypt.compare(password, user.password_hash)
    : false;
  if (!passwordMatches) throw AppError.unauthorized('Incorrect email or password');

  await query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);

  const memberships = await listMembershipsForUser(user.id);
  return {
    user: publicUser(user),
    workspaces: memberships.map(mapMembership),
    tokens: issueTokenPair(user),
  };
}

/** POST /api/auth/refresh - exchange a valid refresh token for a new pair. */
export async function refresh(refreshToken) {
  const payload = verifyToken(refreshToken, 'refresh');

  const user = await queryOne(
    `SELECT id, email, full_name, avatar_url, job_title, status, password_hash
       FROM users WHERE id = ? LIMIT 1`,
    [payload.sub],
  );
  if (!user || user.status !== 'active') throw AppError.unauthorized('Account is not active');

  const memberships = await listMembershipsForUser(user.id);
  return {
    user: publicUser(user),
    workspaces: memberships.map(mapMembership),
    // Only the access token is rotated; the refresh token stays valid until it
    // expires. (Add a refresh_tokens table if you need server-side revocation.)
    accessToken: signAccessToken(user),
  };
}

/** GET /api/auth/me - profile + every workspace the caller belongs to. */
export async function getProfile(userId) {
  const user = await queryOne(
    'SELECT * FROM users WHERE id = ? LIMIT 1',
    [userId],
  );
  if (!user) throw AppError.notFound('User not found');
  return { user: publicUser(user), workspaces: (await listMembershipsForUser(userId)).map(mapMembership) };
}

/** PATCH /api/auth/me - edit own profile fields. */
export async function updateProfile(userId, { fullName, avatarUrl, jobTitle, phone }) {
  await query(
    `UPDATE users
        SET full_name  = COALESCE(?, full_name),
            avatar_url = COALESCE(?, avatar_url),
            job_title  = COALESCE(?, job_title),
            phone      = COALESCE(?, phone)
      WHERE id = ?`,
    [fullName ?? null, avatarUrl ?? null, jobTitle ?? null, phone ?? null, userId],
  );
  return getProfile(userId);
}

/** POST /api/auth/change-password - requires the current password. */
export async function changePassword(userId, { currentPassword, newPassword }) {
  const user = await queryOne('SELECT * FROM users WHERE id = ? LIMIT 1', [userId]);
  if (!user) throw AppError.notFound('User not found');
  if (!user.password_hash) {
    throw AppError.badRequest('This account signs in with an external provider');
  }

  const matches = await bcrypt.compare(currentPassword, user.password_hash);
  if (!matches) throw AppError.unauthorized('Current password is incorrect');

  const hash = await bcrypt.hash(newPassword, env.BCRYPT_ROUNDS);
  await query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);
  return { changed: true };
}

/** DB row -> API shape for a workspace membership. */
export function mapMembership(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    logoUrl: row.logo_url,
    timezone: row.timezone,
    role: row.role,
    aiEnabled: row.ai_enabled === 1 || row.ai_enabled === true,
    joinedAt: row.joined_at,
  };
}
