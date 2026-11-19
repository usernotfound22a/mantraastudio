/**
 * Validate the checked-in Supabase schema and migration. Applying migrations
 * is delegated to the Supabase CLI so the local source is never treated as a
 * SQL execution interface.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { BACKEND_ROOT } from '../src/config/env.js';

const root = path.resolve(BACKEND_ROOT, '..');
const schemaPath = path.join(BACKEND_ROOT, 'src', 'db', 'schema.sql');
const rlsPath = path.join(BACKEND_ROOT, 'src', 'db', 'rls.sql');
const migrationDir = path.join(root, 'supabase', 'migrations');

const schema = (await fs.readFile(schemaPath, 'utf8')) + '\n' + (await fs.readFile(rlsPath, 'utf8').catch(() => ''));
const migrations = (await fs.readdir(migrationDir))
  .filter((name) => name.endsWith('.sql'))
  .sort();
if (!migrations.length) throw new Error('No Supabase migrations found.');

const migration = (await Promise.all(
  migrations.map((name) => fs.readFile(path.join(migrationDir, name), 'utf8')),
)).join('\n');
const tables = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS\s+"?([a-z_]+)"?/gi)].map((match) => match[1]);
const required = ['users', 'workspaces', 'workspace_members', 'conversations', 'messages'];
const missing = required.filter((table) => !tables.includes(table));
const policyTables = [...schema.matchAll(/ALTER TABLE\s+public\.([a-z_]+)\s+ENABLE ROW LEVEL SECURITY/gi)]
  .map((match) => match[1]);
const tablesWithoutRls = tables.filter((table) => !policyTables.includes(table));
const tablesWithPolicies = [...schema.matchAll(/CREATE POLICY\s+\S+\s+ON\s+public\.([a-z_]+)/gi)]
  .map((match) => match[1]);
const tablesWithoutPolicies = tables.filter((table) => table !== 'system_settings' && !tablesWithPolicies.includes(table));
if (missing.length || tablesWithoutRls.length || tablesWithoutPolicies.length) {
  throw new Error(
    `Schema validation failed; missing tables: ${missing.join(', ') || 'none'}; tables without RLS: ${tablesWithoutRls.join(', ') || 'none'}; tables without policies: ${tablesWithoutPolicies.join(', ') || 'none'}.`,
  );
}
for (const table of required) {
  if (!migration.includes(`"${table}"`)) {
    throw new Error(`Migration is missing required table ${table}.`);
  }
}
if (/CREATE\s+FUNCTION\s+.*(?:execute_sql|raw_sql|dynamic_sql)/is.test(migration)) {
  throw new Error('Migration contains a prohibited arbitrary SQL execution function.');
}

console.log(`Supabase schema validated: ${tables.length} tables with RLS; ${migrations.length} migration(s) found.`);
console.log('Apply locally with `npx supabase migration up --local`; link the project before any remote migration.');
