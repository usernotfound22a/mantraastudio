/**
 * Environment doctor: `npm run check`
 * Verifies that .env parses, MySQL is reachable and the required tables exist.
 * Run this whenever something is not working - it prints the exact fix.
 */
import { env, logConfigWarnings, BACKEND_ROOT } from '../src/config/env.js';
import { pingDatabase, query, closePool } from '../src/db/pool.js';
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
  // Plugin system 3. If these are missing, the API returns 500s on the
  // developer pages instead of a clear "run db:migrate".
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
    const latency = await pingDatabase();
    ok(`MySQL reachable at ${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME} (${latency}ms)`);
  } catch (error) {
    bad(`MySQL not reachable: ${error.message}`);
    console.log('         -> start MySQL, then run: npm run db:migrate');
    await closePool();
    process.exit(1);
  }

  await loadMetaSettings();
  for (const warning of logConfigWarnings({ metaConfigured: isMetaConfigured() })) warn(warning);

  const rows = await query('SHOW TABLES');
  const existing = new Set(rows.map((row) => Object.values(row)[0]));
  const missing = REQUIRED_TABLES.filter((table) => !existing.has(table));
  if (missing.length) {
    bad(`Missing tables: ${missing.join(', ')}`);
    console.log('         -> run: npm run db:migrate');
  } else {
    ok(`All ${REQUIRED_TABLES.length} tables present`);
  }

  await closePool();
  console.log('\nDone.\n');
}

main().catch((error) => {
  console.error(`\nUnexpected error: ${error.message}\n`);
  process.exit(1);
});
