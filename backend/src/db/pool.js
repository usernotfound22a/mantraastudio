/**
 * MySQL connection pool + query helpers.
 *
 * Design notes
 * ------------
 * - A single shared pool is created lazily and reused everywhere (mysql2 pools
 *   are cheap and internally multiplex connections).
 * - `query()` uses `pool.query()` rather than `pool.execute()` on purpose:
 *   `query()` escapes values for us and supports `IN (?)` with an array, which we
 *   use a lot for workspace-scoped filtering.
 * - `withTransaction()` gives us `BEGIN / COMMIT / ROLLBACK` with guaranteed
 *   release of the connection, used by anything that writes several rows
 *   (register user + create workspace + create subscription, for example).
 */
import mysql from 'mysql2/promise';
import { env } from '../config/env.js';
import { childLogger } from '../config/logger.js';

const log = childLogger('db');

let pool = null;

/** Lazily creates (or returns) the shared connection pool. */
export function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      waitForConnections: true,
      connectionLimit: env.DB_CONNECTION_LIMIT,
      queueLimit: 0,
      // Return DATE/DATETIME as JS Date, JSON columns as parsed objects.
      dateStrings: false,
      // Keeps money/rating columns as numbers instead of strings.
      decimalNumbers: true,
      charset: 'utf8mb4_unicode_ci',
      timezone: 'Z',
      // Big numbers (e.g. COUNT(*)) as JS numbers, safe up to 2^53.
      supportBigNumbers: true,
      bigNumberStrings: false,
      multipleStatements: false,
    });
    log.info(
      { host: env.DB_HOST, port: env.DB_PORT, database: env.DB_NAME },
      'MySQL connection pool created',
    );
  }
  return pool;
}

/**
 * Runs a SELECT and returns plain rows.
 * @param {string} sql    SQL with `?` placeholders
 * @param {Array}  params Values for the placeholders
 * @returns {Promise<Array<object>>}
 */
export async function query(sql, params = []) {
  const startedAt = process.hrtime.bigint();
  try {
    const [rows] = await getPool().query(sql, params);
    return rows;
  } finally {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (ms > 200) log.warn({ ms: Math.round(ms), sql: sql.trim().slice(0, 120) }, 'Slow query');
  }
}

/** Runs a SELECT and returns the first row (or `null`). */
export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

/**
 * Runs an INSERT/UPDATE/DELETE and returns the driver result
 * ({ insertId, affectedRows, ... }).
 */
export async function execute(sql, params = []) {
  const [result] = await getPool().query(sql, params);
  return result;
}

/**
 * Runs `fn` inside a transaction. Commits on success, rolls back on any throw.
 * The callback receives a dedicated connection: use `conn.execute(conn, sql, params)`
 * style helpers below so the statements run on that same connection.
 *
 * @param {(conn: import('mysql2/promise').PoolConnection) => Promise<any>} fn
 */
export async function withTransaction(fn) {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/** SELECT helper bound to an existing transaction connection. */
export async function txQuery(connection, sql, params = []) {
  const [rows] = await connection.query(sql, params);
  return rows;
}

/** INSERT/UPDATE/DELETE helper bound to an existing transaction connection. */
export async function txExecute(connection, sql, params = []) {
  const [result] = await connection.query(sql, params);
  return result;
}

/** Cheap liveness probe used by GET /api/health and on server boot. */
export async function pingDatabase() {
  const startedAt = Date.now();
  await query('SELECT 1 AS ok');
  return Date.now() - startedAt;
}

/** Closes every pooled connection (call on graceful shutdown). */
export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    log.info('MySQL connection pool closed');
  }
}

/**
 * MySQL connection errors are recoverable on their own (server restart, network
 * blip). Retrying a read is safe; retrying a write could double-insert, so we
 * only retry here and let write paths decide for themselves.
 */
export async function queryWithRetry(sql, params = [], attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await query(sql, params);
    } catch (error) {
      lastError = error;
      const retriable = ['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'ER_CON_COUNT_ERROR', 'ETIMEDOUT'];
      if (!retriable.includes(error.code) || attempt === attempts) throw error;
      log.warn({ attempt, code: error.code }, 'Retrying query after connection error');
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw lastError;
}
