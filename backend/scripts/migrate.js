/**
 * Database migration runner.
 *
 *   npm run db:migrate          create the database (if missing) + apply schema safely
 *   npm run db:migrate -- --fresh   DROP every table first, then re-apply
 *
 * SocialHub is small enough that a single versioned schema.sql is the right
 * trade-off: no migration tool, no config, and the whole data model stays
 * readable in one file for your FYP report. (Swap in Knex/Umzug if you ever
 * need multi-version migrations - nothing else in the app depends on this.)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { env, BACKEND_ROOT } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';

const SCHEMA_PATH = path.join(BACKEND_ROOT, 'src', 'db', 'schema.sql');
const shouldDrop = process.argv.includes('--fresh');

/**
 * Teardown order: children before parents, or MySQL refuses the DROP because of
 * a foreign key. Keep this in sync when adding a table.
 *
 * Only used with `--fresh`. schema.sql itself never drops anything, so a routine
 * `npm run db:migrate` can never destroy a connected channel.
 */
const DROP_ORDER = [
  'webhook_deliveries',
  'webhook_endpoints',
  'api_keys',
  'message_feedback',
  'notes',
  'messages',
  'unanswered_questions',
  'conversations',
  'faqs',
  'channels',
  'social_accounts',
  'workspace_members',
  'subscriptions',
  'system_settings',
  'workspaces',
  'users',
];

/**
 * Splits a .sql file into individual statements.
 * Good enough for DDL: strips full-line `--` comments, then splits on `;`.
 * (Our schema contains no semicolons inside string literals.)
 */
function splitStatements(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function main() {
  // 1. Connect WITHOUT selecting a database so we can CREATE DATABASE.
  const root = await mysql.createConnection({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    multipleStatements: false,
  });

  logger.info(
    { database: env.DB_NAME, user: env.DB_USER, host: env.DB_HOST },
    'Connecting to MySQL server',
  );

  // `IF NOT EXISTS` means this is safe on a fresh server and an existing one.
  await root.query(
    `CREATE DATABASE IF NOT EXISTS \`${env.DB_NAME}\`
     CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await root.end();
  logger.info({ database: env.DB_NAME }, 'Database is ready');

  // 2. Apply the schema statement by statement.
  const connection = await mysql.createConnection({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
  });

  const sql = await fs.readFile(SCHEMA_PATH, 'utf8');
  const schemaStatements = splitStatements(sql);
  const statements = shouldDrop
    ? schemaStatements
    : schemaStatements
        .filter((statement) => !/^DROP TABLE IF EXISTS\b/i.test(statement))
        .map((statement) =>
          statement.replace(/^CREATE TABLE (?!IF NOT EXISTS\b)/i, 'CREATE TABLE IF NOT EXISTS '),
        );

  if (shouldDrop) {
    logger.warn({ tables: DROP_ORDER.length }, 'Running with --fresh: dropping every table first');
    for (const table of DROP_ORDER) {
      await connection.query(`DROP TABLE IF EXISTS \`${table}\``);
    }
    logger.info({ tables: DROP_ORDER.length }, 'Existing tables dropped');
  }

  for (const [index, statement] of statements.entries()) {
    const label = statement.split('\n')[0].slice(0, 80);
    try {
      await connection.query(statement);
      logger.info({ step: `${index + 1}/${statements.length}` }, `OK  ${label}`);
    } catch (error) {
      // Duplicate index/constraint names mean the table already exists; the
      // schema uses IF NOT EXISTS-style guards everywhere else, so surface it.
      logger.error(
        { step: `${index + 1}/${statements.length}`, code: error.code, sql: label },
        `FAILED: ${error.message}`,
      );
      await connection.end();
      process.exit(1);
    }
  }

  // Older databases have this table already but predate worker-claim leases.
  // Add only the missing nullable column; never rebuild or drop user tables.
  const [claimedAtColumn] = await connection.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'webhook_deliveries'
        AND column_name = 'claimed_at'
      LIMIT 1`,
  );
  if (claimedAtColumn.length === 0) {
    await connection.query('ALTER TABLE `webhook_deliveries` ADD COLUMN `claimed_at` DATETIME NULL');
    logger.info('Applied migration: webhook_deliveries.claimed_at');
  }

  const [statusColumn] = await connection.query(
    `SELECT column_type FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'webhook_deliveries'
        AND column_name = 'status'
      LIMIT 1`,
  );
  if (statusColumn.length && !statusColumn[0].column_type.includes("'processing'")) {
    await connection.query(
      `ALTER TABLE \`webhook_deliveries\`
       MODIFY COLUMN \`status\` ENUM('pending','processing','delivered','failed','exhausted')
       NOT NULL DEFAULT 'pending'`,
    );
    logger.info("Applied migration: webhook_deliveries.status supports 'processing'");
  }

  await connection.end();
  logger.info({ statements: statements.length }, 'Schema applied successfully');
  logger.info('Next step:  npm run db:seed   (creates the demo workspace)');
}

main().catch((error) => {
  logger.error({ code: error.code, message: error.message }, 'Migration failed');
  if (error.code === 'ECONNREFUSED') {
    logger.error('Is MySQL running? Check DB_HOST / DB_PORT in backend/.env');
  }
  if (error.code === 'ER_ACCESS_DENIED_ERROR') {
    logger.error('Wrong DB_USER / DB_PASSWORD in backend/.env');
  }
  process.exit(1);
});
