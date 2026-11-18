/**
 * Thin wrapper around pino so every module logs with the same shape and level.
 * In development we pipe through pino-pretty for human-readable output.
 */
import pino from 'pino';
import { env, BACKEND_ROOT } from './env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'socialhub-api' },
  // Only pay the pretty-print cost outside production.
  transport: env.isProd
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' },
      },
  redact: {
    // Never print credentials, even by accident.
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.passwordHash',
      '*.accessToken',
      '*.access_token',
      'config.accessToken',
    ],
    censor: '[redacted]',
  },
});

/** Creates a child logger that automatically tags every line with a module name. */
export const childLogger = (moduleName) => logger.child({ module: moduleName });

export const LOG_DIR = `${BACKEND_ROOT}/logs`;
