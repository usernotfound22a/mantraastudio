/** Encrypted, server-wide Meta credentials configured from the admin panel. */
import { getAdminClient, callRpc } from '../db/supabase.js';
import { env } from '../config/env.js';
import { childLogger } from '../config/logger.js';
import { AppError } from '../middleware/error.js';
import { decryptSecret, encryptSecret } from './crypto.service.js';

const log = childLogger('meta-settings');
const APP_ID_KEY = 'meta_app_id';
const APP_SECRET_KEY = 'meta_app_secret';

let current = {
  appId: env.META_APP_ID ?? '',
  appSecret: env.META_APP_SECRET ?? '',
};

/** Returns a copy; callers must never mutate the process-wide settings. */
export const getMetaSettings = () => ({ ...current });

export const isMetaConfigured = () => Boolean(current.appId && current.appSecret);

/** Loads encrypted DB values at boot, falling back to environment configuration. */
export async function loadMetaSettings() {
  try {
    const { data: rows, error } = await getAdminClient()
      .from('system_settings')
      .select('setting_key,setting_value')
      .in('setting_key', [APP_ID_KEY, APP_SECRET_KEY]);
    if (error) throw error;
    const stored = Object.fromEntries(rows.map((row) => [row.setting_key, decryptSecret(row.setting_value)]));
    current = {
      appId: stored[APP_ID_KEY] ?? current.appId,
      appSecret: stored[APP_SECRET_KEY] ?? current.appSecret,
    };
  } catch (error) {
    log.warn({ code: error.code, message: error.message }, 'Could not load saved Meta credentials; using environment settings');
  }

  log.info({ configured: isMetaConfigured(), source: current.appId && current.appSecret ? 'database-or-environment' : 'missing' }, 'Meta settings loaded');
  return getMetaSettings();
}

/** Stores both values encrypted and atomically, never returning the secret. */
export async function saveMetaSettings({ appId, appSecret, updatedBy, workspaceId }) {
  const normalizedAppId = String(appId ?? '').trim();
  const normalizedSecret = String(appSecret ?? '').trim();
  const nextSecret = normalizedSecret || current.appSecret;
  if (!normalizedAppId || !nextSecret) {
    throw AppError.badRequest('Meta App ID and App Secret are required for initial setup');
  }
  if (normalizedAppId.length > 100 || normalizedSecret.length > 500) {
    throw AppError.badRequest('Meta credentials exceed the maximum allowed length');
  }

  await callRpc('save_meta_settings', {
    p_workspace_id: workspaceId,
    p_app_id_encrypted: encryptSecret(normalizedAppId),
    p_app_secret_encrypted: encryptSecret(normalizedSecret || current.appSecret),
  });

  current = { appId: normalizedAppId, appSecret: nextSecret };
  log.info({ updatedBy: updatedBy ?? null }, 'Meta credentials saved encrypted');
  return { configured: true, appId: normalizedAppId };
}
