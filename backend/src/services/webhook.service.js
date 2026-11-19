/**
 * Outbound webhooks (plugin system 3, part 2).
 *
 * A customer registers a URL, picks the events they care about, and every
 * matching event is delivered as an HTTP POST with a signed body.
 *
 * DELIVERY GUARANTEES
 *   - Signed: X-SocialHub-Signature is HMAC-SHA256(secret, "<timestamp>.<body>")
 *     so a consumer can verify authenticity AND reject replays using the
 *     timestamp window. Signature covers the timestamp, not just the body.
 *   - Retried: a delivery is retried with exponential backoff up to
 *     WEBHOOK_MAX_ATTEMPTS times, then marked 'exhausted'.
 *   - Ordered + sequenced: each delivery carries a per-endpoint sequence
 *     number so a consumer can detect gaps.
 *   - Disabling: an endpoint that fails WEBHOOK_FAILURE_THRESHOLD times in a
 *     row is disabled automatically rather than hammering a dead URL.
 *
 * The worker is a single interval that claims due rows, so the design survives
 * more than one API process without double-sending (claimed rows are updated
 * with a next_attempt_at before the HTTP call is made).
 */
import crypto from 'node:crypto';
import {
  deleteRows,
  getAdminClient,
  insertRow,
  callRpc,
  selectOne,
  selectRows,
  updateRows,
  withSupabaseClient,
} from '../db/supabase.js';
import { env } from '../config/env.js';
import { childLogger } from '../config/logger.js';
import { AppError } from '../middleware/error.js';
import { encryptSecret, decryptSecret } from './crypto.service.js';

const log = childLogger('webhooks');

/** Events a customer may subscribe to. Mirrors the real-time event contract. */
export const WEBHOOK_EVENTS = Object.freeze([
  'message.created',
  'conversation.created',
  'conversation.updated',
  'conversation.assigned',
  'conversation.resolved',
  'note.created',
  'ai.replied',
  'ai.handed_over',
  'faq.matched',
  'faq.missed',
  'channel.connected',
  'channel.disconnected',
]);

/** Milliseconds before the next attempt, per attempt number (exponential). */
function backoffMs(attempt) {
  const base = 60_000; // 1 minute
  const capped = Math.min(base * 2 ** (attempt - 1), 60 * 60_000); // max 1 hour
  // Jitter avoids a thundering herd when many endpoints fail together.
  return Math.round(capped * (0.75 + Math.random() * 0.5));
}

// ------------------------------------------------------------- endpoints

export async function listEndpoints(workspaceId) {
  const rows = await selectRows('webhook_endpoints', '*', { workspace_id: workspaceId }, {
    order: [{ column: 'created_at', ascending: false }],
  });
  return rows.map(mapEndpoint);
}

export async function createEndpoint({ workspaceId, url, events, description = null }) {
  assertValidUrl(url);
  const wanted = assertValidEvents(events);

  const secret = crypto.randomBytes(32).toString('hex');
  // Stored encrypted: we must re-sign every delivery, so the secret has to be recoverable.
  const row = await insertRow('webhook_endpoints', {
    workspace_id: workspaceId,
    url,
    events: wanted,
    signing_secret: encryptSecret(secret),
    description,
  });
  return { endpoint: mapEndpoint(row), signingSecret: secret };
}

export async function getEndpoint(workspaceId, id) {
  const row = await selectOne('webhook_endpoints', '*', { id, workspace_id: workspaceId });
  if (!row) throw AppError.notFound('Webhook endpoint not found');
  return mapEndpoint(row);
}

export async function updateEndpoint(workspaceId, id, { url, events, status, description }) {
  const existing = await getEndpoint(workspaceId, id);
  const nextUrl = url ?? existing.url;
  assertValidUrl(nextUrl);
  const nextEvents = events ? assertValidEvents(events) : existing.events;

  await updateRows('webhook_endpoints', {
    url: nextUrl,
    events: nextEvents,
    status: status ?? existing.status,
    description: description ?? existing.description,
    disabled_reason: null,
  }, { id, workspace_id: workspaceId });
  return getEndpoint(workspaceId, id);
}

/** Re-enables a disabled endpoint and clears its failure counter. */
export async function enableEndpoint(workspaceId, id) {
  await updateRows('webhook_endpoints', {
    status: 'active', failure_count: 0, disabled_reason: null,
  }, { id, workspace_id: workspaceId });
  return getEndpoint(workspaceId, id);
}

/** Rotation returns the NEW secret immediately; the old one stops working. */
export async function rotateSecret(workspaceId, id) {
  const secret = crypto.randomBytes(32).toString('hex');
  const result = await updateRows('webhook_endpoints', { signing_secret: encryptSecret(secret) }, {
    id, workspace_id: workspaceId,
  });
  if (!result.length) throw AppError.notFound('Webhook endpoint not found');
  return { signingSecret: secret };
}

export async function deleteEndpoint(workspaceId, id) {
  const result = await deleteRows('webhook_endpoints', { id, workspace_id: workspaceId });
  if (!result.length) throw AppError.notFound('Webhook endpoint not found');
  return { deleted: true };
}

/** Recent deliveries, newest first, for the dashboard log. */
export async function listDeliveries(workspaceId, { endpointId, limit = 50 } = {}) {
  const capped = Math.min(Number(limit) || 50, 200);
  const rows = await selectRows(
    'webhook_deliveries',
    '*',
    endpointId ? { workspace_id: workspaceId, endpoint_id: endpointId } : { workspace_id: workspaceId },
    { order: [{ column: 'id', ascending: false }], limit: capped },
  );
  return rows.map(mapDelivery);
}

// ------------------------------------------------------------- dispatching

/**
 * Queues an event for every active endpoint subscribed to it.
 *
 * Queuing (not sending) is deliberate: the caller - a message insert, an AI
 * reply - must not be slowed down or failed by a customer's dead webhook URL.
 * Returns the number of endpoints queued for.
 */
export async function dispatchEvent(workspaceId, event, payload) {
  if (!WEBHOOK_EVENTS.includes(event)) {
    // An event nobody can subscribe to: nothing to do, and not an error.
    return 0;
  }

  const queued = await callRpc('queue_webhook_event', {
    p_workspace_id: workspaceId,
    p_event: event,
    p_payload: payload,
    p_max_attempts: env.WEBHOOK_MAX_ATTEMPTS,
  });

  if (queued) log.debug({ workspaceId, event, queued }, 'webhook event queued');
  return queued;
}

/**
 * Signs a delivery body.
 * Format: sha256=<hex> over "<timestamp>.<body>", which is what the customer
 * verifies with their signing secret.
 */
export function signPayload(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return { signature, timestamp };
}

/** Verifies a signature exactly as a consumer would. Used by the self-test. */
export function verifySignature(secret, body, signatureHeader, timestampHeader, toleranceSeconds = 300) {
  if (!signatureHeader?.startsWith('sha256=') || !timestampHeader) return false;
  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return false;
  // Reject stale signatures so a captured request cannot be replayed later.
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > toleranceSeconds) return false;

  const expected = signPayload(secret, body, timestamp).signature;
  const given = Buffer.from(signatureHeader.slice('sha256='.length));
  const want = Buffer.from(expected);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

// ------------------------------------------------------------------ worker

let workerTimer = null;

/** Attempts one delivery. Exported so the self-test can drive it directly. */
export async function attemptDelivery(deliveryId) {
const delivery = await selectOne('webhook_deliveries', '*', { id: deliveryId });
    // 'processing' means processDueDeliveries already claimed it for us;
    // 'pending' still works when a test drives attemptDelivery directly.
    if (!delivery || !['pending', 'processing'].includes(delivery.status)) return null;

  const endpoint = await selectOne('webhook_endpoints', '*', { id: delivery.endpoint_id });
  if (!endpoint || endpoint.status !== 'active') {
    await updateRows('webhook_deliveries', { status: 'exhausted', error: 'endpoint disabled or deleted' }, {
      id: delivery.id,
    });
    return null;
  }

  // Decrypt the stored secret so we can sign with the real value.
  let secret;
  try {
    secret = decryptSecret(endpoint.signing_secret);
  } catch (error) {
    // Secrets created before encryption existed are stored as plain hex.
    secret = /^[0-9a-f]{64}$/.test(endpoint.signing_secret)
      ? endpoint.signing_secret
      : (() => {
          log.error({ err: error.message }, 'cannot decrypt webhook secret');
          return null;
        })();
  }
  if (!secret) {
    await updateRows('webhook_deliveries', { status: 'exhausted', error: 'signing secret is unreadable' }, {
      id: delivery.id,
    });
    return null;
  }

  const body = typeof delivery.payload === 'string' ? delivery.payload : JSON.stringify(delivery.payload);
  const { signature, timestamp } = signPayload(secret, body);
  const attempt = delivery.attempt + 1;
  const startedAt = Date.now();

  let responseStatus = null;
  let error = null;
  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SocialHub-Event': delivery.event,
        'X-SocialHub-Delivery': String(delivery.id),
        'X-SocialHub-Sequence': String(delivery.sequence),
        'X-SocialHub-Timestamp': String(timestamp),
        'X-SocialHub-Signature': `sha256=${signature}`,
        'User-Agent': 'SocialHub-Webhooks/1.0',
      },
      body,
      signal: AbortSignal.timeout(env.WEBHOOK_TIMEOUT_MS),
    });
    responseStatus = response.status;
    // 2xx = delivered. Everything else (including 3xx) is a failure to retry.
    if (response.status < 200 || response.status >= 300) {
      error = `HTTP ${response.status}`;
    }
  } catch (err) {
    error = err.name === 'TimeoutError' ? 'timeout' : err.message.slice(0, 500);
  }

  const durationMs = Date.now() - startedAt;
  const succeeded = !error;

  await updateRows('webhook_deliveries', {
    status: succeeded ? 'delivered' : attempt >= delivery.max_attempts ? 'exhausted' : 'pending',
    attempt,
    response_status: responseStatus,
    error,
    duration_ms: durationMs,
    delivered_at: succeeded ? new Date().toISOString() : delivery.delivered_at,
    next_attempt_at: succeeded ? null : new Date(Date.now() + backoffMs(attempt)).toISOString(),
    claimed_at: null,
  }, { id: delivery.id });

  if (succeeded) {
    await updateRows('webhook_endpoints', {
      last_status: responseStatus,
      last_success_at: new Date().toISOString(),
      failure_count: 0,
    }, { id: endpoint.id });
  } else {
    const failures = (endpoint.failure_count ?? 0) + 1;
    await updateRows('webhook_endpoints', {
      failure_count: failures,
      last_status: responseStatus,
      last_attempt_at: new Date().toISOString(),
    }, { id: endpoint.id });
    if (failures >= env.WEBHOOK_FAILURE_THRESHOLD) {
      await updateRows('webhook_endpoints', {
        status: 'disabled',
        disabled_reason: `disabled after ${failures} consecutive failures`,
      }, { id: endpoint.id });
      log.warn({ endpointId: endpoint.id, failures }, 'webhook endpoint auto-disabled');
    }
  }

  return { success: succeeded, responseStatus, error, attempt };
}

  /**
   * Atomically claims one delivery for this process.
   *
   * The SELECT-then-UPDATE pattern is NOT safe on its own: two API processes
   * would both read the same due row and both POST it. The conditional UPDATE is
   * what makes it safe - exactly one caller sees affectedRows = 1.
   *
   * @returns {Promise<boolean>} true when this process now owns the delivery.
   */
  async function claimDelivery(deliveryId) {
    const rows = await updateRows('webhook_deliveries', {
      status: 'processing', claimed_at: new Date().toISOString(),
    }, { id: deliveryId, status: 'pending' });
    return rows.length === 1;
  }

  /** Processes every delivery that is due now. */
  export async function processDueDeliveries(limit = 25) {
    return withSupabaseClient(getAdminClient(), async () => {
    const due = await selectRows('webhook_deliveries', 'id', { status: 'pending' }, {
      order: [{ column: 'id', ascending: true }],
      limit,
      or: `next_attempt_at.is.null,next_attempt_at.lte.${new Date().toISOString()}`,
    });
    let processed = 0;
    for (const { id } of due) {
      try {
        // Lost the race to another worker: skip it, do not double-send.
        if (!(await claimDelivery(id))) continue;
        await attemptDelivery(id);
        processed += 1;
      } catch (error) {
        log.error({ deliveryId: id, err: error.message }, 'delivery attempt crashed');
        // Never leave a row stuck in 'processing' after a crash here.
        await updateRows('webhook_deliveries', {
          status: 'pending', claimed_at: null,
        }, { id, status: 'processing' }).catch(() => {});
      }
    }
    return processed;
    });
  }

/** Starts the background worker. Safe to call once at boot. */
export function startWebhookWorker() {
  if (workerTimer) return;
  const interval = env.WEBHOOK_POLL_INTERVAL_MS;
  workerTimer = setInterval(() => {
    processDueDeliveries().catch((error) => log.error({ err: error.message }, 'webhook worker tick failed'));
  }, interval);
  // Do not hold the process open just for the worker.
  workerTimer.unref?.();
  log.info({ intervalMs: interval }, 'webhook worker started');
}

export function stopWebhookWorker() {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
}

// ----------------------------------------------------------------- helpers

/** Blocks the obvious SSRF targets before we ever make the request. */
function assertValidUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw AppError.badRequest('The webhook URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw AppError.badRequest('The webhook URL must be http or https');
  }
  if (url.protocol !== 'https:' && !isLocal(url.hostname)) {
    throw AppError.badRequest('Plain http is only allowed for localhost targets. Use https.');
  }
  const blocked = ['169.254.169.254', 'metadata.google.internal', 'metadata'];
  if (blocked.includes(url.hostname)) {
    throw AppError.badRequest('That host is not allowed');
  }
  return true;
}

const isLocal = (hostname) =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.endsWith('.local');

function assertValidEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    throw AppError.badRequest(`At least one event is required. Available: ${WEBHOOK_EVENTS.join(', ')}`);
  }
  const unknown = events.filter((event) => !WEBHOOK_EVENTS.includes(event));
  if (unknown.length) {
    throw AppError.badRequest(`Unknown event(s): ${unknown.join(', ')}. Available: ${WEBHOOK_EVENTS.join(', ')}`);
  }
  return [...new Set(events)];
}

function mapEndpoint(row) {
  return {
    id: row.id,
    url: row.url,
    events: Array.isArray(row.events) ? row.events : JSON.parse(row.events ?? '[]'),
    status: row.status,
    description: row.description,
    failureCount: row.failure_count,
    lastStatus: row.last_status,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    disabledReason: row.disabled_reason,
    createdAt: row.created_at,
    // The secret is never returned here - use the rotate endpoint to get a new one.
  };
}

function mapDelivery(row) {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    event: row.event,
    sequence: row.sequence,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    responseStatus: row.response_status,
    error: row.error,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}
