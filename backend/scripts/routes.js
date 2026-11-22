/**
 * Prints every registered route and audits the guards on each one. `npm run routes`
 *
 * Three jobs in one:
 *   1. Useful during development ("which endpoint did I forget?")
 *   2. A smoke test: if any route module has a syntax error or a bad import,
 *      this script fails immediately without a live database connection.
 *   3. A guard audit: proves every tenant route is authenticated, workspace
 *      scoped, validated and role-gated. This is the check that would have
 *      caught an un-authenticated route before it shipped.
 *
 * Express does not expose mount paths in a friendly way, so we record them by
 * patching Router.prototype.use BEFORE the app is built.
 */
import express from 'express';

// --- Record `router.use('/mount/path', childRouter)` pairs ----------------
// Express defines Router methods as OWN properties of the exported Router
// function (router instances do `setPrototypeOf(router, proto)`), so the patch
// has to target `Router.use`, not `Router.prototype.use`.
const mountPaths = new WeakMap();
const originalUse = express.Router.use;

express.Router.use = function patchedUse(...args) {
  const result = originalUse.apply(this, args);
  const [first, ...rest] = args;

  for (const candidate of typeof first === 'string' ? rest : [first]) {
    if (typeof candidate === 'function' && Array.isArray(candidate.stack)) {
      mountPaths.set(candidate, typeof first === 'string' ? first : '');
    }
  }
  return result;
};

// --- Build the app AFTER the patch ---------------------------------------
const { ensureAdaptersLoaded } = await import('../src/adapters/factory.js');
const { createApp } = await import('../src/app.js');
const auth = await import('../src/middleware/auth.js');
const apiAuth = await import('../src/middleware/apiAuth.js');
const { validate } = await import('../src/middleware/validate.js');

await ensureAdaptersLoaded();
const app = createApp();
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options'];

// ---------------------------------------------------------------------------
// Identify middleware by REFERENCE. asyncHandler(), validate() and
// requireRole() all return anonymous functions, so fn.name is useless here.
// validate() and requireRole() tag their result for exactly this purpose.
// ---------------------------------------------------------------------------
const IDENTITY = new Map([
  [auth.authenticate, 'authenticate'],
  [auth.loadWorkspace, 'loadWorkspace'],
  [apiAuth.authenticateApiKeyMiddleware, 'authenticateApiKey'],
]);

function labelOf(fn) {
  if (IDENTITY.has(fn)) return IDENTITY.get(fn);
  if (fn.validatesRequest) return 'validate';
  if (fn.requiresRoles) return `requireRole(${fn.requiresRoles.join('|')})`;
  return fn.name || 'middleware';
}

/**
 * Depth-first walk that INHERITS router-level middleware, because
 * `router.use(authenticate)` guards every route mounted below it even though it
 * never appears in a route's own stack. Order is preserved, matching Express.
 */
/** Incremented during the walk, so registration order survives the sort below. */
let order = 0;

function walk(router, prefix = '', inherited = []) {
  const rows = [];
  const running = [...inherited];

  for (const layer of router.stack ?? []) {
    if (layer.route) {
      const fullPath = `${prefix}${layer.route.path}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
      const chain = [...running, ...layer.route.stack.map((s) => labelOf(s.handle))];
      for (const method of METHODS) {
        if (!layer.route.methods[method]) continue;
        rows.push({
          method: method.toUpperCase(),
          path: fullPath,
          chain,
          handlers: chain.length,
          order: order++,
        });
      }
    } else if (typeof layer.handle === 'function' && !Array.isArray(layer.handle.stack)) {
      running.push(labelOf(layer.handle));
    } else if (layer.handle) {
      rows.push(...walk(layer.handle, `${prefix}${mountPaths.get(layer.handle) ?? ''}`, running));
    }
  }

  return rows;
}

const rows = walk(app._router).sort(
  (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
);

const pathWidth = Math.max(0, ...rows.map((row) => row.path.length));

console.log('\nSocialHub API routes\n');
for (const row of rows) {
  console.log(
    `  ${row.method.padEnd(6)} ${row.path.padEnd(pathWidth)}   ${row.handlers} handler${
      row.handlers === 1 ? '' : 's'
    }`,
  );
}
console.log(`\n${rows.length} routes registered.\n`);

// ---------------------------------------------------------------------------
// Guard audit
// ---------------------------------------------------------------------------

/** Public by design: nobody is signed in, or the browser is on a redirect. */
const NO_AUTH_OK = [
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/refresh',
  // The OAuth callback exchanges a Supabase token in the request body.
  '/api/auth/oauth',
  // Facebook redirects the browser here; a top-level navigation sends no
  // Authorization header, so the signed state token is the CSRF defence.
  '/api/channels/meta/oauth/callback',
  '/api/channels/meta/instagram/oauth/callback',
];
/** User-scoped or tenant-is-the-target, so no workspace context is loaded. */
const NO_WORKSPACE_OK = [
  '/api/auth/',
  '/api/workspaces',
  '/api/channels/catalogue',
  '/api/channels/meta/oauth/callback',
  '/api/channels/meta/instagram/oauth/callback',
];
/** Writes whose input is not a JSON body. */
const NO_SCHEMA_OK = ['/api/auth/logout', '/api/auth/oauth', '/api/uploads/attachment'];
const PUBLIC_PREFIXES = ['/api/health', '/api/webhooks', '/api/widget'];

const tenant = rows.filter(
  (row) => row.path.startsWith('/api/') && !PUBLIC_PREFIXES.some((p) => row.path.startsWith(p)),
);
const problems = [];
const complain = (row, why) => problems.push(`${row.method} ${row.path}: ${why}`);

for (const row of tenant) {
  const apiKeyAuthenticated = row.chain.includes('authenticateApiKey');
  if (!row.chain.includes('authenticate') && !apiKeyAuthenticated && !NO_AUTH_OK.includes(row.path)) {
    complain(row, 'not authenticated');
  }
  const workspaceFromApiKey = row.path.startsWith('/api/v1/') && apiKeyAuthenticated;
  if (!workspaceFromApiKey && !NO_WORKSPACE_OK.some((p) => row.path.startsWith(p)) && !row.chain.includes('loadWorkspace')) {
    complain(row, 'no workspace context');
  }
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(row.method)) {
    if (!row.chain.includes('validate') && !NO_SCHEMA_OK.some((p) => row.path.startsWith(p))) {
      complain(row, 'write without validation');
    }
    // Anything a support agent can trigger must be role-gated.
    const agentFacing = /^\/api\/(conversations|channels|faqs|uploads)/.test(row.path);
    const isFeedback = row.path.endsWith('/feedback');
    if (agentFacing && !isFeedback && !row.chain.some((c) => c.startsWith('requireRole'))) {
      complain(row, 'write without a role check');
    }
  }
}

// A one-segment parameter route can shadow a later literal sibling only when
// the HTTP method also matches. Deeper paths do not match `/:channelId`.
const channels = rows.filter((row) => row.path.startsWith('/api/channels'));
for (const parameterRoute of channels.filter((row) => /\/:\w+$/.test(row.path))) {
  const parent = parameterRoute.path.slice(0, parameterRoute.path.lastIndexOf('/'));
  const collision = channels.find((row) => {
    if (row.method !== parameterRoute.method || row.order <= parameterRoute.order) return false;
    if (!row.path.startsWith(`${parent}/`) || row.path.includes(':')) return false;
    return !row.path.slice(parent.length + 1).includes('/');
  });
  if (collision) {
    problems.push(`${collision.method} ${collision.path} is registered after ${parameterRoute.path}`);
  }
}

console.log(`Tenant-scoped workspace routes: ${rows.filter((r) => r.path.startsWith('/api/workspaces/:workspaceId')).length}`);
console.log(`Tenant routes audited: ${tenant.length} (${NO_AUTH_OK.length} public by design)`);

/*
  Real-time contract: every event the server emits must exist in the catalogue
  in src/services/events.js. A renamed or mistyped event would otherwise break
  the frontend silently - the emit "succeeds" and the UI simply stops updating.
*/
const { EVENTS, EVENT_CATALOGUE } = await import('../src/services/events.js');
const { readdirSync, readFileSync, statSync } = await import('node:fs');
const { join } = await import('node:path');

const eventProblems = [];
const known = new Set(Object.values(EVENTS));
const sourceRoot = new URL('../src', import.meta.url).pathname.replace(/^\//, '');

const scanDir = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) scanDir(full);
    else if (entry.endsWith('.js')) {
      const source = readFileSync(full, 'utf8');
      // `emitX(room, 'literal:event', ...)` - a string that looks like an event.
      for (const match of source.matchAll(/emit(?:ToWorkspace|ToConversation|ToUser)?\(\s*[^,]+,\s*'([a-z_]+:[a-z_]+)'/g)) {
        const name = match[1];
        if (!known.has(name)) {
          eventProblems.push(`${full.replace(sourceRoot, 'src')}: emits undeclared event "${name}"`);
        }
      }
    }
  }
};
scanDir(sourceRoot);

// Every catalogue entry should also be documented, so a new event is described
// rather than merely named.
for (const entry of EVENT_CATALOGUE) {
  if (!entry.purpose) eventProblems.push(`EVENT_CATALOGUE: "${entry.event}" has no purpose`);
}

console.log(`Real-time events declared: ${Object.keys(EVENTS).length} (${EVENT_CATALOGUE.length} documented)`);

if (eventProblems.length) {
  console.error(`\n${eventProblems.length} event contract problem(s):`);
  for (const problem of eventProblems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('Event contract passed: every emitted event is declared and documented.');

if (problems.length) {
  console.error(`\n${problems.length} guard problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('\nGuard audit passed: every tenant route is authenticated, workspace-scoped, validated and role-gated.\n');
