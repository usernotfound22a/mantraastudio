/**
 * Central, validated configuration.
 *
 * Every environment variable the app needs is declared here exactly once and
 * parsed/validated at boot. If something required is missing the process exits
 * immediately with a readable message instead of failing later with a cryptic
 * "cannot read property of undefined" deep inside a request handler.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load `.env` from the backend root regardless of the current working directory.
const here = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = path.resolve(here, '..', '..');
dotenv.config({ path: path.join(BACKEND_ROOT, '.env') });

// Keep the existing browser-side Vite/Next-style names usable for the API,
// while documenting the unprefixed server-side settings in backend/.env.example.
process.env.SUPABASE_URL ||= process.env.NEXT_PUBLIC_SUPABASE_URL;
process.env.SUPABASE_PUBLISHABLE_KEY ||= process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

/** Turns "" into undefined so zod `.optional()` behaves as expected. */
const emptyToUndefined = (value) => (value === '' ? undefined : value);

const csvToArray = (value) =>
  (value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGINS: z.string().default('http://localhost:5173').transform(csvToArray),

  SUPABASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  SUPABASE_PUBLISHABLE_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  SUPABASE_SECRET_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),

  // Encrypts channel tokens and webhook signing secrets at rest. Falls back to
  // JWT_SECRET when unset so a fresh clone runs, but set it separately in
  // production so rotating one secret does not orphan the other's data.
  ENCRYPTION_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  // Optional override for where third-party channel plugins are loaded from.
  // Defaults to backend/plugins (see plugins/channel.loader.js).
  CHANNEL_PLUGINS_DIR: z.preprocess(emptyToUndefined, z.string().optional()),

  META_APP_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  META_APP_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  META_INSTAGRAM_APP_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  META_INSTAGRAM_APP_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  META_GRAPH_VERSION: z.string().default('v21.0'),
  META_REDIRECT_URI: z.preprocess(emptyToUndefined, z.string().url().optional()),
  META_INSTAGRAM_REDIRECT_URI: z.preprocess(emptyToUndefined, z.string().url().optional()),
  META_PRIVACY_POLICY_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  META_DEAUTH_CALLBACK_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  META_DATA_DELETION_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  WEBHOOK_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  META_VERIFY_TOKEN: z.string().default('change_me_verify_token'),

  // Any provider id is allowed here on purpose: third-party AI plugins register
  // their own id at boot. The loader falls back to `offline` for an unknown id,
  // so a typo degrades instead of crashing the server.
  AI_PROVIDER: z
    .string()
    .trim()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i, 'AI_PROVIDER must be a provider id like "openai"')
    .default('offline'),
  OPENAI_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  GROQ_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
  AI_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.55),
  AI_MAX_TOKENS: z.coerce.number().int().positive().default(400),

  STRIPE_SECRET_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  STRIPE_WEBHOOK_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  KHALTI_SECRET_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  KHALTI_API_BASE_URL: z.string().url().default('https://khalti.com/api'),
  // Monthly prices, and the optional yearly ones. Yearly is a separate Stripe
  // price, so a plan can be sold monthly-only until the yearly id is added.
  STRIPE_PRICE_STARTER: z.preprocess(emptyToUndefined, z.string().optional()),
  STRIPE_PRICE_STARTER_YEARLY: z.preprocess(emptyToUndefined, z.string().optional()),
  STRIPE_PRICE_PRO: z.preprocess(emptyToUndefined, z.string().optional()),
  STRIPE_PRICE_PRO_YEARLY: z.preprocess(emptyToUndefined, z.string().optional()),
  // Where Stripe sends the customer back to. Must be the dashboard origin, not
  // the API, or the success redirect lands on a JSON endpoint.
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Outbound webhooks (public API plugin system).
  WEBHOOK_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  // Consecutive failures before an endpoint is disabled automatically.
  WEBHOOK_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(50).default(10),
}).superRefine((config, context) => {
  if (config.NODE_ENV === 'production' && !config.SUPABASE_URL) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SUPABASE_URL'],
      message: 'SUPABASE_URL is required in production',
    });
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  console.error(`\n[config] Invalid environment variables:\n${details}\n`);
  console.error('Copy backend/.env.example to backend/.env and fill in the missing values.\n');
  process.exit(1);
}

/** Typed, immutable config object used across the whole backend. */
export const env = Object.freeze({
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
});

/** Non-fatal warnings: features that will be unavailable without extra setup. */
export function logConfigWarnings({ metaConfigured = Boolean(env.META_APP_ID && env.META_APP_SECRET) } = {}) {
  const warnings = [];
  if (!metaConfigured) {
    warnings.push('Meta app credentials missing -> configure them in Channels or set the META_APP_ID / META_APP_SECRET environment fallback.');
  }
  if (env.AI_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
    warnings.push('AI_PROVIDER=openai but OPENAI_API_KEY is missing -> AI replies will be skipped.');
  }
  if (env.AI_PROVIDER === 'groq' && !env.GROQ_API_KEY) {
    warnings.push('AI_PROVIDER=groq but GROQ_API_KEY is missing -> AI replies will be skipped.');
  }
  if (env.AI_PROVIDER === 'offline') {
    warnings.push('AI_PROVIDER=offline -> replies use the plain FAQ keyword matcher only (no LLM).');
  }
  if (!env.STRIPE_SECRET_KEY) {
    warnings.push('STRIPE_SECRET_KEY missing -> billing endpoints will return 503.');
  }
  if (!env.KHALTI_SECRET_KEY) {
    warnings.push('KHALTI_SECRET_KEY missing -> Khalti refunds are disabled.');
  }
  return warnings;
}
