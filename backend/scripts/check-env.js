/**
 * Environment doctor: `npm run check`
 * Verifies that .env parses and the Supabase project is reachable.
 * Run this whenever something is not working - it prints the exact fix.
 */
import { env, logConfigWarnings, BACKEND_ROOT } from '../src/config/env.js';
import { getAdminClient, pingSupabase, withSupabaseClient } from '../src/db/supabase.js';
import { isMetaConfigured, loadMetaSettings } from '../src/services/meta-settings.service.js';

const REQUIRED_TABLES = [
  'users',
  'workspaces',
  'workspace_members',
  'channels',
  'conversations',
  'messages',
  'notes',
  'faqs',
  'subscriptions',
  'system_settings',
  'api_keys',
  'webhook_endpoints',
  'webhook_deliveries',
];

const ok = (message) => console.log(`  [ok]   ${message}`);
const bad = (message) => console.log(`  [FAIL] ${message}`);
const warn = (message) => console.log(`  [warn] ${message}`);

async function main() {
  console.log(`\nSocialHub backend check (${BACKEND_ROOT})\n`);

  ok(`Node ${process.version}`);
  ok(`NODE_ENV=${env.NODE_ENV}, PORT=${env.PORT}`);
  ok(`CORS origins: ${env.CORS_ORIGINS.join(', ')}`);

  try {
    const latency = await pingSupabase();
    ok(`Supabase reachable (${latency}ms)`);
  } catch (error) {
    bad(`Supabase not reachable: ${error.message}`);
    console.log('         -> set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and SUPABASE_SECRET_KEY.');
    process.exit(1);
  }

  await withSupabaseClient(getAdminClient(), async () => {
    await loadMetaSettings();
    for (const warning of logConfigWarnings({ metaConfigured: isMetaConfigured() })) warn(warning);
    const client = getAdminClient();
    const missing = [];
    for (const table of REQUIRED_TABLES) {
      const { error } = await client.from(table).select('*', { head: true, count: 'exact' }).limit(0);
      if (error) missing.push(table);
    }
    if (missing.length) {
      bad(`Missing or inaccessible tables: ${missing.join(', ')}`);
      console.log('         -> apply the SQL migrations in supabase/migrations.');
    } else {
      ok(`All ${REQUIRED_TABLES.length} required tables present`);
    }
  });
  console.log('\nDone.\n');
}

main().catch((error) => {
  console.error(`\nUnexpected error: ${error.message}\n`);
  process.exit(1);
});
