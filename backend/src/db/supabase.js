import { AsyncLocalStorage } from 'node:async_hooks';
import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

const requestClient = new AsyncLocalStorage();

function assertPublicConfig() {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required. Set them in backend/.env.',
    );
  }
}

export function createUserClient(accessToken) {
  assertPublicConfig();
  return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined,
  });
}

/** Anon-role client whose API-key hash is consumed only by narrow RLS policies. */
export function createApiKeyClient(apiKeyHash) {
  assertPublicConfig();
  return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: {
      headers: { 'X-SocialHub-Api-Key-Hash': apiKeyHash },
    },
  });
}

let adminClient;

/** Service-only client for trusted webhooks and background workers. */
export function getAdminClient() {
  if (!env.SUPABASE_SECRET_KEY) {
    return createUserClient();
  }
  if (!adminClient) {
    if (!env.SUPABASE_URL) {
      throw new Error('SUPABASE_URL is required for server-side operations.');
    }
    adminClient = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
  }
  return adminClient;
}

export const getSupabaseClient = () =>
  requestClient.getStore() ?? createUserClient();

export const withSupabaseClient = (client, callback) =>
  requestClient.run(client, callback);

function throwOnError({ data, error }) {
  if (error) {
    if (!error.code && error.status) error.code = `SUPABASE_${error.status}`;
    throw error;
  }
  return data;
}

export async function selectRows(table, columns = '*', filters = {}, options = {}) {
  let request = getSupabaseClient().from(table).select(columns, options.count ? { count: options.count } : undefined);
  for (const [column, value] of Object.entries(filters)) {
    if (value === null) request = request.is(column, null);
    else if (Array.isArray(value)) request = request.in(column, value);
    else request = request.eq(column, value);
  }
  for (const [column, values] of Object.entries(options.in ?? {})) {
    request = request.in(column, values);
  }
  for (const [column, value] of Object.entries(options.ilike ?? {})) {
    request = request.ilike(column, value);
  }
  for (const [column, value] of Object.entries(options.gt ?? {})) request = request.gt(column, value);
  for (const [column, value] of Object.entries(options.gte ?? {})) request = request.gte(column, value);
  for (const [column, value] of Object.entries(options.lt ?? {})) request = request.lt(column, value);
  for (const [column, value] of Object.entries(options.lte ?? {})) request = request.lte(column, value);
  if (options.or) request = request.or(options.or);
  for (const [column, operator, value] of options.not ?? []) {
    request = request.not(column, operator, value);
  }
  if (options.order) {
    for (const item of options.order) {
      request = request.order(item.column, { ascending: item.ascending ?? true, nullsFirst: item.nullsFirst });
    }
  }
  if (options.limit != null) request = request.limit(options.limit);
  if (options.offset != null) request = request.range(options.offset, options.offset + options.limit - 1);
  return throwOnError(await request);
}

export async function selectAllRows(table, columns = '*', filters = {}, options = {}) {
  const pageSize = 500;
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await selectRows(table, columns, filters, {
      ...options,
      limit: pageSize,
      offset,
    });
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

export async function selectOne(table, columns = '*', filters = {}) {
  let request = getSupabaseClient().from(table).select(columns);
  for (const [column, value] of Object.entries(filters)) {
    request = value === null ? request.is(column, null) : request.eq(column, value);
  }
  return throwOnError(await request.maybeSingle());
}

export async function insertRow(table, values, columns = '*') {
  return throwOnError(await getSupabaseClient().from(table).insert(values).select(columns).single());
}

export async function updateRows(table, values, filters = {}, columns = '*') {
  let request = getSupabaseClient().from(table).update(values);
  for (const [column, value] of Object.entries(filters)) {
    request = value === null ? request.is(column, null) : request.eq(column, value);
  }
  return throwOnError(await request.select(columns));
}

export async function deleteRows(table, filters = {}) {
  let request = getSupabaseClient().from(table).delete();
  for (const [column, value] of Object.entries(filters)) {
    request = value === null ? request.is(column, null) : request.eq(column, value);
  }
  return throwOnError(await request.select());
}

export async function upsertRow(table, values, onConflict, columns = '*') {
  return throwOnError(
    await getSupabaseClient()
      .from(table)
      .upsert(values, { onConflict })
      .select(columns)
      .single(),
  );
}

export async function callRpc(name, parameters = {}) {
  return throwOnError(await getSupabaseClient().rpc(name, parameters));
}

export async function pingSupabase() {
  const startedAt = Date.now();
  await fetch(`${env.SUPABASE_URL}/auth/v1/health`, { headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY } });
  return Date.now() - startedAt;
}
