import {
  createUserClient,
  getSupabaseClient,
  getAdminClient,
  withSupabaseClient,
  callRpc,
  selectOne,
  updateRows,
} from '../../db/supabase.js';
import { AppError } from '../../middleware/error.js';
import { childLogger } from '../../config/logger.js';
import { listMembershipsForUser } from '../../services/membership.service.js';

const log = childLogger('auth');

export const publicUser = (user) => ({
  id: user.id,
  email: user.email,
  fullName: user.full_name,
  avatarUrl: user.avatar_url,
  jobTitle: user.job_title,
  createdAt: user.created_at,
});

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

async function profileForAuthUser(authUser) {
  let profile = await selectOne('users', '*', { auth_user_id: authUser.id });
  if (!profile) {
    const fullName = authUser.user_metadata?.full_name?.trim()
      || authUser.email?.split('@')[0]
      || 'SocialHub user';
    const workspaceName = authUser.user_metadata?.workspace_name?.trim()
      || `${fullName}'s workspace`;
    await callRpc('bootstrap_workspace', {
      p_full_name: fullName,
      p_workspace_name: workspaceName,
    });
    profile = await selectOne('users', '*', { auth_user_id: authUser.id });
  }
  if (!profile) throw AppError.unauthorized('Account profile is not ready');
  if (profile.status === 'disabled') throw AppError.forbidden('This account is disabled');
  return profile;
}

function sessionTokens(session) {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
  };
}

function authError(error, fallback) {
  if (error?.status === 400 || error?.status === 401) {
    return AppError.unauthorized(fallback);
  }
  if (error?.status === 422) return AppError.conflict(error.message);
  if (error?.status === 429) return AppError.tooManyRequests('Too many attempts. Please try again shortly.');
  if (error?.status >= 500) {
    return AppError.serviceUnavailable('Authentication service is unavailable. Please try again.');
  }
  return error ?? AppError.unauthorized(fallback);
}

/** Create a Supabase Auth account and atomically bootstrap its first workspace. */
export async function register({ email, password, fullName, workspaceName }) {
  const adminClient = getAdminClient();
  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, workspace_name: workspaceName },
  });
  if (error) throw authError(error, 'Could not create an account');
  if (!data.user) throw AppError.badRequest('Could not create an account');

  const { data: signInData, error: signInError } = await createUserClient().auth.signInWithPassword({
    email,
    password,
  });
  if (signInError || !signInData?.session || !signInData?.user) {
    throw authError(signInError, 'Could not create an account');
  }

  const sessionClient = createUserClient(signInData.session.access_token);
  const profile = await withSupabaseClient(sessionClient, () =>
    profileForAuthUser(signInData.user),
  );
  const memberships = await withSupabaseClient(sessionClient, () =>
    listMembershipsForUser(profile.id),
  );

  log.info({ userId: profile.id }, 'New account registered');
  return {
    user: publicUser(profile),
    workspaces: memberships.map(mapMembership),
    tokens: sessionTokens(signInData.session),
  };
}

/** Authenticate with Supabase Auth; the API never handles password hashes. */
/** Complete a Supabase OAuth (e.g. Google) sign-in using the caller's access token. */
export async function completeOAuth(accessToken) {
  const client = createUserClient(accessToken);
  const { data, error } = await client.auth.getUser(accessToken);
  if (error || !data?.user) throw AppError.unauthorized('Invalid or expired access token');
  const scopedClient = createUserClient(accessToken);
  const profile = await withSupabaseClient(scopedClient, () => profileForAuthUser(data.user));
  const memberships = await withSupabaseClient(scopedClient, () =>
    listMembershipsForUser(profile.id),
  );
  return {
    user: publicUser(profile),
    workspaces: memberships.map(mapMembership),
    tokens: { accessToken, refreshToken: null },
  };
}

export async function login({ email, password }) {
  const client = createUserClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session || !data.user) {
    throw authError(error, 'Incorrect email or password');
  }
  const scopedClient = createUserClient(data.session.access_token);
  const profile = await withSupabaseClient(scopedClient, () => profileForAuthUser(data.user));
  await withSupabaseClient(scopedClient, () =>
    updateRows('users', { last_login_at: new Date().toISOString() }, { id: profile.id }),
  );
  const memberships = await withSupabaseClient(scopedClient, () =>
    listMembershipsForUser(profile.id),
  );
  return {
    user: publicUser(profile),
    workspaces: memberships.map(mapMembership),
    tokens: sessionTokens(data.session),
  };
}

export async function refresh(refreshToken) {
  const client = createUserClient();
  const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session || !data.user) {
    throw AppError.unauthorized('Session has expired. Please sign in again.');
  }
  const scopedClient = createUserClient(data.session.access_token);
  const profile = await withSupabaseClient(scopedClient, () => profileForAuthUser(data.user));
  const memberships = await withSupabaseClient(scopedClient, () =>
    listMembershipsForUser(profile.id),
  );
  return {
    user: publicUser(profile),
    workspaces: memberships.map(mapMembership),
    ...sessionTokens(data.session),
  };
}

export async function getProfile(userId) {
  const user = await selectOne('users', '*', { id: userId });
  if (!user) throw AppError.notFound('User not found');
  return { user: publicUser(user), workspaces: (await listMembershipsForUser(userId)).map(mapMembership) };
}

export async function updateProfile(userId, { fullName, avatarUrl, jobTitle, phone }) {
  const changes = {};
  if (fullName !== undefined) changes.full_name = fullName;
  if (avatarUrl !== undefined) changes.avatar_url = avatarUrl;
  if (jobTitle !== undefined) changes.job_title = jobTitle;
  if (phone !== undefined) changes.phone = phone;
  if (Object.keys(changes).length) await updateRows('users', changes, { id: userId });
  return getProfile(userId);
}

export async function changePassword(userId, { currentPassword, newPassword }) {
  const user = await selectOne('users', 'id,email', { id: userId });
  if (!user) throw AppError.notFound('User not found');
  const client = getSupabaseClient();
  const { error: verifyError } = await createUserClient().auth.signInWithPassword({
    email: user.email,
    password: currentPassword,
  });
  if (verifyError) throw AppError.unauthorized('Current password is incorrect');
  const { error } = await client.auth.updateUser({ password: newPassword });
  if (error) throw error;
  return { changed: true };
}

export async function logout() {
  const { error } = await getSupabaseClient().auth.signOut();
  if (error) throw error;
  return { success: true };
}
