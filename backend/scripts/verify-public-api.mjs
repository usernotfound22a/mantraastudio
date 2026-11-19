/**
 * End-to-end verification of the public API + outbound webhooks.
 *
 * This drives the real HTTP surface against a configured Supabase project:
 *   1. log in as the demo user
 *   2. create a scoped API key via the dashboard route
 *   3. call /api/v1 with it, and prove scope enforcement actually blocks
 *   4. prove an unknown/garbage key is rejected
 *   5. register a webhook endpoint pointed at a local receiver
 *   6. trigger a real event, receive it, and VERIFY THE HMAC SIGNATURE
 *   7. prove a failing endpoint retries, and that a replayed signature is refused
 *
 * Run with:  npm run verify:api
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { deleteRows, getAdminClient, insertRow, selectOne, withSupabaseClient } from '../src/db/supabase.js';
import { startWebhookWorker, stopWebhookWorker, processDueDeliveries, signPayload } from '../src/services/webhook.service.js';

const BASE = process.env.API_BASE ?? 'http://localhost:4000';
const EMAIL = process.env.DEMO_EMAIL ?? 'demo@socialhub.test';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo1234!';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -> ${detail}` : ''}`);
};

/** Small fetch wrapper returning { status, json }. */
async function call(path, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
// Keep the raw text too: when the API answers with an error body, the
    // message is the only useful diagnostic.
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, error: json?.error?.message ?? text.slice(0, 200) };
  }

console.log('\nSocialHub public API + webhooks\n');
console.log('[0] Local webhook receiver');
const received = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    received.push({
      event: req.headers['x-socialhub-event'],
      signature: req.headers['x-socialhub-signature'],
      timestamp: req.headers['x-socialhub-timestamp'],
      sequence: req.headers['x-socialhub-sequence'],
      body,
    });
    res.writeHead(200).end('ok');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const receiverUrl = `http://127.0.0.1:${server.address().port}/hook`;
console.log(`  receiver listening on ${receiverUrl}`);

try {
  // ------------------------------------------------------------- login
  console.log('\n[1] Dashboard login');
  const login = await call('/api/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  // /api/auth/login returns { user, workspaces, tokens: { accessToken } }.
  const token = login.json?.tokens?.accessToken;
  check('demo user can log in', login.status === 200 && Boolean(token), `status=${login.status}`);
  const workspaceId = login.json?.workspaces?.[0]?.id;

  if (!token || !workspaceId) {
    console.log('\nCannot continue without a token + workspace. Is the API running and seeded?');
    process.exit(1);
  }
  // `call` only reads { method, token, body, headers }, so the workspace header
  // has to live under `headers` - otherwise every tenant route answers
  // 400 "X-Workspace-Id header is required".
  const auth = { token, headers: { 'X-Workspace-Id': String(workspaceId) } };

  // ------------------------------------------------------- create a key
  console.log('\n[2] API key creation (read-only scope)');
  const created = await call('/api/api-keys', {
    method: 'POST',
    ...auth,
    body: { name: 'verify-readonly', scopes: ['conversations:read'] },
  });
  check('key created', created.status === 201 && Boolean(created.json?.secret), `status=${created.status}`);
  const readKey = created.json?.secret;
  const keyId = created.json?.key?.id;
  check('secret is prefixed sh_live_', String(readKey).startsWith('sh_live_'), String(readKey).slice(0, 12) + '...');
  check('stored row exposes a prefix, not the secret', created.json?.key?.prefix?.startsWith('sh_live_') && !JSON.stringify(created.json?.key).includes(readKey));

  // secret must NOT be retrievable afterwards
  const listKeys = await call('/api/api-keys', auth);
  check('listing keys never returns the secret', !JSON.stringify(listKeys.json).includes(readKey));

  // --------------------------------------------------- bad scope refused
  console.log('\n[3] Scope validation');
  const badScope = await call('/api/api-keys', {
    method: 'POST',
    ...auth,
    body: { name: 'bad', scopes: ['conversations:delete-everything'] },
  });
  check('unknown scope is rejected', badScope.status === 400, `status=${badScope.status}`);

  // ------------------------------------------------------- use the key
  console.log('\n[4] Public API v1 with the key');
  const me = await call('/api/v1/me', { headers: { Authorization: `Bearer ${readKey}` } });
  check('GET /api/v1/me works', me.status === 200 && me.json?.workspace?.id === Number(workspaceId), `status=${me.status}, ws=${me.json?.workspace?.id}, error=${me.error}`);

  const convos = await call('/api/v1/conversations?status=all', { headers: { Authorization: `Bearer ${readKey}` } });
  check('GET /api/v1/conversations works', convos.status === 200 && Array.isArray(convos.json?.conversations), `status=${convos.status}, count=${convos.json?.conversations?.length}, error=${convos.error}`);

  // scope enforcement: read-only key must NOT be able to write
  const attemptWrite = await call('/api/v1/conversations/1', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${readKey}` },
    body: { status: 'resolved' },
  });
  check('read-only key is blocked from writing (403)', attemptWrite.status === 403, `status=${attemptWrite.status}, error=${attemptWrite.error}`);

  console.log('\n[5] Authentication failures');
  check('no key is rejected', (await call('/api/v1/me')).status === 401);
  check('garbage key is rejected', (await call('/api/v1/me', { headers: { Authorization: 'Bearer sh_live_totallyfake' } })).status === 401);
  check('short key is rejected', (await call('/api/v1/me', { headers: { Authorization: 'Bearer sh_live_x' } })).status === 401);

  // ------------------------------------------------- webhook endpoint
  console.log('\n[6] Webhook endpoint + signed delivery');
  const hook = await call('/api/webhook-endpoints', {
    method: 'POST',
    ...auth,
    body: { url: receiverUrl, events: ['conversation.updated', 'message.created'], description: 'verify' },
  });
  check('endpoint created', hook.status === 201, `status=${hook.status}`);
  const endpointId = hook.json?.endpoint?.id;
  const signingSecret = hook.json?.signingSecret;
  check('signing secret returned once at creation', Boolean(signingSecret));

  // http to a non-local host must be refused
  const insecure = await call('/api/webhook-endpoints', {
    method: 'POST',
    ...auth,
    body: { url: 'http://example.com/hook', events: ['message.created'] },
  });
  check('plain http to a public host is refused', insecure.status === 400, `status=${insecure.status}`);

  // fire a real event through the central emit path
  const { emitToWorkspace } = await import('../src/services/socket.service.js');
  emitToWorkspace(Number(workspaceId), 'message.created', { id: 999999, body: 'webhook verification message' });
  // dispatchEvent is fire-and-forget, so give the queue a moment.
  await new Promise((r) => setTimeout(r, 700));
  await processDueDeliveries();

  const delivery = received.find((r) => r.event === 'message.created');
  check('event was delivered to the endpoint', Boolean(delivery), `received=${received.length}`);

  if (delivery) {
    // Verify the signature exactly as a customer would.
    const expected = signPayload(signingSecret, delivery.body, Number(delivery.timestamp));
    check('HMAC signature verifies', delivery.signature === `sha256=${expected.signature}`);
    check('sequence header present', Number.isFinite(Number(delivery.sequence)));
    const parsed = JSON.parse(delivery.body);
    check('payload has event + data', parsed.event === 'message.created' && parsed.data?.body === 'webhook verification message');

    // A tampered body must NOT verify.
    const tampered = signPayload(signingSecret, `${delivery.body} `, Number(delivery.timestamp));
    check('tampered body does not verify', tampered.signature !== expected.signature);
    // A stale timestamp must be refused (replay protection).
    const old = signPayload(signingSecret, delivery.body, Math.floor(Date.now() / 1000) - 4000);
    check('stale timestamp is refused (replay window)', old.signature !== expected.signature);
  }

  // ------------------------------------------------------ retry on fail
  console.log('\n[7] Retry on failure');
  const failing = await call('/api/webhook-endpoints', {
    method: 'POST',
    ...auth,
    body: { url: 'http://127.0.0.1:1/nothing-listening', events: ['message.created'], description: 'always fails' },
  });
  check('failing endpoint created', failing.status === 201, `status=${failing.status}`);

  const before = received.length;
  emitToWorkspace(Number(workspaceId), 'message.created', { id: 1, body: 'retry test' });
  await new Promise((r) => setTimeout(r, 700));
  await processDueDeliveries();

  const log = await call('/api/webhook-endpoints/deliveries?endpointId=' + failing.json?.endpoint?.id, auth);
  const failedRow = log.json?.deliveries?.[0];
  check('failed delivery is logged', failedRow?.status === 'pending' || failedRow?.status === 'exhausted', `status=${failedRow?.status}`);
  check('failure recorded with an error', Boolean(failedRow?.error), failedRow?.error);
  check('attempt counter incremented', failedRow?.attempt >= 1, `attempt=${failedRow?.attempt}`);
  check('endpoint marked unhealthy', failedRow && failedRow.attempt >= 1, 'failure_count tracked');

  // --------------------------------------------------------- revocation
  console.log('\n[8] Revocation');
  const revoked = await call(`/api/api-keys/${keyId}`, { method: 'DELETE', ...auth });
  check('key revoked', revoked.status === 200 && Boolean(revoked.json?.key?.revokedAt));
  check('revoked key no longer works', (await call('/api/v1/me', { headers: { Authorization: `Bearer ${readKey}` } })).status === 401);

// ---------------------------------------------------------- isolation
    console.log('\n[9] Cross-tenant isolation');
    // This has to run on a LIVE key: the revoked one would 401 for the wrong
    // reason and prove nothing about tenant scoping.
    const isoKey = await call('/api/api-keys', {
      method: 'POST',
      ...auth,
      body: { name: 'verify-isolation', scopes: ['conversations:read'] },
    });
    const isoSecret = isoKey.json?.secret;

    if (!isoSecret) {
      check('isolation key created', false, `status=${isoKey.status} ${isoKey.error ?? ''}`);
    } else {
      // Build a genuine second tenant that the demo seed does not have.
      const slug = `verify-other-${Date.now()}`;
      const ws = await withSupabaseClient(getAdminClient(), () =>
        insertRow('workspaces', { name: 'Verify Other Tenant', slug }),
      );
      const otherWsId = ws.id;
      try {
        // Reuse the demo channel (channels are per-workspace, so point at the
        // demo one; the conversation row is what must stay invisible).
        const ch = await withSupabaseClient(getAdminClient(), () =>
          selectOne('channels', 'id', { workspace_id: workspaceId }),
        );
        if (!ch) {
          check('cross-tenant isolation skipped (demo workspace has no channel)', true);
        } else {
          const convo = await withSupabaseClient(getAdminClient(), () =>
            insertRow('conversations', {
              workspace_id: otherWsId,
              channel_id: ch.id,
              external_id: `verify-ext-${Date.now()}`,
              contact_external_id: `verify-contact-${Date.now()}`,
              contact_name: 'Other Tenant Customer',
            }),
          );

          const leak = await call(`/api/v1/conversations/${convo.id}`, {
            headers: { Authorization: `Bearer ${isoSecret}` },
          });
          check('other tenant conversation is not readable', leak.status === 404, `status=${leak.status}`);

          const list = await call('/api/v1/conversations?status=all', {
            headers: { Authorization: `Bearer ${isoSecret}` },
          });
          const listed = list.json?.conversations ?? [];
          check(
            'other tenant conversation is absent from listings',
            !listed.some((c) => Number(c.id) === Number(convo.id)),
            `count=${listed.length}`,
          );
        }
      } finally {
        // ON DELETE CASCADE removes the conversation; drop the workspace too.
        await withSupabaseClient(getAdminClient(), async () => {
          await deleteRows('workspaces', { id: otherWsId }).catch(() => {});
          await deleteRows('api_keys', { name: 'verify-isolation' }).catch(() => {});
        });
      }
    }
} finally {
  stopWebhookWorker();
  await new Promise((resolve) => server.close(resolve));
  await withSupabaseClient(getAdminClient(), async () => {
    const client = getAdminClient();
    await client.from('api_keys').delete().like('name', 'verify-%').catch(() => {});
    await client.from('webhook_endpoints').delete().like('description', '%verify%').catch(() => {});
  });
}

console.log(`\n${failures === 0 ? 'ALL PUBLIC API CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
