# SocialHub (Monorepo)

AI-Assisted Omnichannel Inbox: manage Facebook Messenger, Instagram and a custom website chat widget in one unified inbox.

## 1) Prerequisites

- Node.js 20+ (this project uses ES modules)
- MySQL 8.x or MariaDB 10.6+ running locally (or a remote instance)
- npm 10+

MySQL on Windows: install [MySQL Community Server](https://dev.mysql.com/downloads/mysql/). MariaDB works too - the schema avoids MySQL-8-only syntax. If you have neither, `npm run check` will tell you exactly what's missing.

## 2) Folder structure

```text
socialhub/
  backend/        Express + Socket.IO + MariaDB/MySQL API
  frontend/       React + Vite + Tailwind dashboard
    widget/       Embeddable website chat (served by the API at /widget/*)
  docs/           Diagrams, report notes
```

The widget lives under `frontend/widget` because it is a front-end asset, but it
is served by the Express app so the whole system runs from one origin and a
customer embeds a single stable URL.

## 3) Setup backend

1. Copy `.env.example` to `.env`

   ```bash
   cd socialhub/backend
   cp .env.example .env        # Windows cmd:  copy .env.example .env
   ```

2. Fill the required values in `backend/.env` (at minimum):

   - `JWT_SECRET` - generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
   - `DB_USER`, `DB_PASSWORD`, `DB_NAME` (default `socialhub`)
   - `CORS_ORIGINS` - `http://localhost:5173` for the frontend

   Leave the Meta/Stripe/OpenAI values blank for now (demo works in offline AI mode).

3. Create the database and tables

   ```bash
   npm run db:migrate
   ```

4. Seed demo data (logs in with `demo@socialhub.test / Demo1234!`)

   ```bash
   npm run db:seed
   ```

5. Verify everything

   ```bash
   npm run check
   ```

6. Run the API

   ```bash
   npm run dev      # watches for changes (node --watch)
   # or
   npm start
   ```

API health: [http://localhost:4000/api/health](http://localhost:4000/api/health)

## 4) Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start with auto-reload (development) |
| `npm start` | Start in production mode |
| `npm run db:migrate` | Create DB if missing + apply schema.sql |
| `npm run db:migrate -- --fresh` | DROP all tables, re-apply schema (destroys data) |
| `npm run db:seed` | Insert demo workspace/users/faqs/channel |
| `npm run db:reset` | Fresh + seed in one go |
| `npm run check` | Environment + DB + tables health check |
| `npm run routes` | Route/guard/event audit against the live router stack |
| `npm run verify:analytics` | Run every analytics query against the real database |
| `npm run verify:plugins` | Contract tests for the channel + AI plugin systems |
| `npm run verify:api` | End-to-end public API + outbound webhook test (needs the API running) |
| `npm run verify:channels` | Inbound/outbound adapter round trip against the real database |

## 5) Architecture decisions (important)

- **Adapter Pattern**: every channel (`website`, `messenger`, `instagram`) will be implemented as its own adapter extending `BaseAdapter`. Webhooks call the adapter factory — they must not contain channel-specific logic. (Part 5)
- **Multi-tenancy**: every tenant-scoped query filters by `workspace_id` via `loadWorkspace` middleware. The `X-Workspace-Id` header is required for workspace routes.
- **Stateless auth**: JWT access + refresh tokens. Refresh tokens are never stored in the DB here (simple + demo-friendly). Add a token revocation table later if you need it.
- **ES modules**: The backend uses `"type": "module"` to match modern Node (and Vite). Use relative imports with `.js` (Node's ESM requires it).
- **Transaction-first writes**: operations that create a user + workspace + subscription run in `withTransaction()` to keep data consistent.
- **Validation**: zod at the route boundary (`validate()` middleware). Handlers receive typed, normalised bodies/params/queries.
- **Errors**: `AppError` + a single `errorHandler`. No `res.status(...).json(...)` for failures outside 404.

## 6) Part 1 + Part 5 status

Implemented (foundation + adapter system):

- [x] Folder structure
- [x] `package.json` + scripts
- [x] `.env.example`, `env.js`, `logger.js`
- [x] `pool.js` (MySQL pool + transaction helpers)
- [x] `schema.sql` (10 tables + FK constraints + metrics view)
- [x] `migrate.js`, `seed.js`, `check-env.js`, `routes.js` (route map **+ guard audit**)
- [x] Error middleware + validation
- [x] Auth tokens + membership service
- [x] Auth middleware (`authenticate`, `loadWorkspace`, `requireRole`)
- [x] Rate limiters
- [x] Auth module (register/login/refresh/me/change-password)
- [x] Workspaces module (CRUD + members + agents + join/leave)
- [x] Socket.IO bootstrap (workspace/conversation rooms + typing)
- [x] App + routes + server (graceful shutdown, fail fast on DB down)

- [x] Part 6: Channels CRUD, Meta OAuth (connect + subscribe webhooks)
- [x] Part 6: Conversations, messages, notes (with pagination and de-dup)
- [x] Part 6: FAQs (full CRUD, bulk import, search, stats, archive-on-delete)
- [x] Part 6: Attachment uploads (multer, allow-listed MIME types, uuid filenames)

## 7) The Adapter Pattern (Part 5)

### How a message flows

```
Meta / widget                    webhook.routes.js                 adapters/
   |                                    |                              |
   |  POST /api/webhooks/messenger       |                              |
   |----------------------------------->|  1. type from URL            |
   |                                    |  2. detector.verifyWebhook() |  <- HMAC, before any DB access
   |                                    |  3. resolveAccountId()       |
   |                                    |  4. find channel row         |  -> channels table
   |                                    |  5. createAdapterForChannel  |
   |                                    |  6. parseInbound() --------> |  -> NormalizedInbound[]
   |                                    |  7. ingestInboundMessage()   |  -> conversations + messages
   |                                    |  8. maybeAutoReply()         |  -> Part 7
   |<-----------------------------------  200 OK                      |
```

`NormalizedInbound` - the single shape every channel is reduced to:

```js
{
  externalMessageId: 'mid.AAA',
  conversationExternalId: 'PSID_123',
  contact: { externalId, name, avatarUrl, email, locale },
  content: { text, attachments: [], quickReplies: [] },
  timestamp: Date,
  metadata: { channel, pageId, referral }
}
```

Everything downstream (inbox UI, AI, analytics, Socket.IO) reads only that shape.

### Adding a channel = one file

1. Create `src/adapters/TelegramAdapter.js`:

```js
import { BaseAdapter } from './BaseAdapter.js';

export class TelegramAdapter extends BaseAdapter {
  static type = 'telegram';            // must match channels.type
  static label = 'Telegram';
  static capabilities = { attachments: true, readReceipts: false };

  parseInbound(payload) { /* -> NormalizedInbound[] */ }
  normalizeContact(raw) { /* -> contact */ }
  async sendMessage({ to, body }) { /* -> { externalId, status } */ }
}
export default TelegramAdapter;
```

2. `npm run db:migrate` (add `'telegram'` to the `channels.type` ENUM - the only
   schema change, and only because MySQL ENUMs are rigid).
3. Restart. `registry.js` imports the file automatically.

**Nothing else changes.** No factory edit, no `index.js` edit, no switch
statement, no webhook route change, no UI change beyond a label. If the file is
broken, the server refuses to boot and names the file.

### Security notes

- Webhook signatures are verified **before** any database access.
- Missing `META_APP_SECRET` fails **closed** in production (503) and only warns
  in development.
- `channels.config` secrets never leave the server (`publicConfig()` filters
  `accessToken`, `appSecret`, `verifyToken`).
- Unknown page ids get `200`, not `404`, so Meta stops retrying an event that can
  never succeed.
- Webhook bodies are read with `express.raw` (re-serialising JSON breaks the HMAC).

## 8) Test the adapters without Meta

The website channel needs no external account:

```bash
# 1. Start the API
npm run dev

# 2. Grab the seeded workspace + widget key
curl "http://localhost:4000/api/health"
#    widget key is in the `channels.config` of the seeded website channel:
#    wk_demo_1_replace_me   (see scripts/seed.js)

# 3. Bootstrap the widget
curl "http://localhost:4000/api/widget/config?key=wk_demo_1_replace_me"

# 4. Send a customer message
curl -X POST http://localhost:4000/api/widget/messages \
  -H "Content-Type: application/json" \
  -d '{"widgetKey":"wk_demo_1_replace_me","visitorId":"visitor-1","name":"Sam","message":"How long is delivery?"}'

# 5. Poll for the agent's reply
curl "http://localhost:4000/api/widget/messages?key=wk_demo_1_replace_me&visitorId=visitor-1"
```

For Messenger/Instagram you need a Meta app. Expose the API with a tunnel and
register the webhook:

```bash
npm run dev
ngrok http 4000
# Webhook URL:  https://<subdomain>.ngrok.io/api/webhooks/messenger
# Verify token: the value of META_VERIFY_TOKEN
# Subscribe to: messages, messaging_postbacks
```

## 9) Route map (Part 6)

`npm run routes` prints all 63 routes **and** audits them. Run it after any
change; it exits non-zero if a tenant route loses a guard.

### Channels

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/channels` | any member | secrets are stripped by `toPublicChannel()` |
| POST | `/api/channels` | owner, admin | `type` validated against the adapter registry |
| GET | `/api/channels/catalogue` | any member | labels + capabilities for the connect screen |
| GET | `/api/channels/:id` | any member | |
| PATCH | `/api/channels/:id` | owner, admin | config is merged, so secrets survive |
| DELETE | `/api/channels/:id` | owner, admin | unsubscribes Meta webhooks first |
| POST | `/api/channels/:id/regenerate-widget-key` | owner, admin | invalidates existing embeds |
| GET | `/api/channels/meta/availability` | any member | is OAuth configured? webhook URLs to paste |
| GET | `/api/channels/meta/oauth/start` | owner, admin | 302 to Facebook |
| GET | `/api/channels/meta/oauth/callback` | public | signed state is the CSRF defence |
| POST | `/api/channels/meta/connect` | owner, admin | long-lived token + subscribe webhooks |

### Conversations (the inbox)

| Method | Path | Who |
|---|---|---|
| GET | `/api/conversations` | any member |
| GET | `/api/conversations/stats` | any member |
| GET | `/api/conversations/:id` | any member |
| PATCH | `/api/conversations/:id/status` | agent+ |
| PATCH | `/api/conversations/:id/assign` · `/unassign` | agent+ |
| POST | `/api/conversations/:id/read` | agent+ |
| PATCH | `/api/conversations/:id/handover` | agent+ |
| GET · POST | `/api/conversations/:id/messages` | get: member · post: agent+ |
| POST | `/api/conversations/:id/messages/:mid/retry` | agent+ |
| POST | `/api/conversations/:id/messages/:mid/feedback` | any member (AI replies only) |
| GET · POST | `/api/conversations/:id/notes` | get: member · post: agent+ |
| PATCH · DELETE | `/api/conversations/:id/notes/:noteId` | author or admin |

### FAQs, uploads

| Method | Path | Who |
|---|---|---|
| GET | `/api/faqs` · `/faqs/top` · `/faqs/search` | any member |
| POST | `/api/faqs` · `/faqs/import` | admin, owner |
| PATCH · DELETE | `/api/faqs/:id` | admin, owner |
| POST | `/api/faqs/:id/reset-stats` | admin, owner |
| POST | `/api/uploads/attachment` | agent+ |

## 10) Design decisions worth defending

**The OAuth handshake never exposes a Meta token to the browser.** The callback
exchanges the code, lists the user's Pages, and returns a signed 10-minute
`connectToken` instead. The browser picks a `pageId` from that signed list and
posts it back; because the list was signed, a client cannot ask for a Page Meta
never offered. Only then do we touch the page token server-side.

**`channels.type` is validated against the adapter registry, not a literal
enum.** `listAdapterTypes()` is the single source of truth, so a new channel
needs no route change.

**Ownership is enforced in the SQL, not after it.** Every read filters on
`workspace_id`, so a conversation id from another tenant is indistinguishable
from one that does not exist.

**Notes are not messages.** There is deliberately no adapter call in the notes
module - that single omission is what makes them internal.

**A reply is persisted before it is delivered.** `status: queued` is written
first, so a Meta outage leaves a visible `failed` row with a retry button
instead of a message that silently vanished.

**FAQ retrieval is TF-IDF, not embeddings.** See the header comment in
`faq.service.js` for the reasoning; `searchFaqs()` is the only function to swap
if embeddings are added later.

**Every guard is machine-checked.** `scripts/routes.js` walks the live Express
router stack and fails the build if a tenant route is not authenticated,
workspace-scoped, validated and role-gated. It also verifies that literal paths
such as `/channels/meta/oauth/start` are registered *before* `/channels/:id`.

## 11) The AI assistant

`ai.service.js` is no longer a stub. `maybeAutoReply()` is the single entry
point, called by the website widget and the Meta webhooks after a message is
stored. The pipeline:

1. **Gate** - skips entirely if the workspace has `ai_enabled = 0` or the
   channel has `aiEnabled = false`.
2. **Greeting / escalation** - a greeting is answered, and an urgent message
   hands straight over.
3. **Retrieval** - `faq.service.js` scores every active FAQ against the message
   (token overlap, keyword hits, phrase bonus) and returns the best match with a
   0..1 score. The AI never invents an answer: it either finds one or it does
   not reply.
4. **Confidence gate** - below `AI_CONFIDENCE_THRESHOLD` the thread is marked
   `ai_handover`, a system message explains why, and the question is recorded
   in `unanswered_questions`.
5. **Answer** - with `AI_PROVIDER=offline` (the default) the matched FAQ answer
   is sent as-is. With `openai` or `groq`, the matched answer is sent to the
   model to be rewritten in the assistant's own voice, and the model may decide
   to decline instead.
6. **Quota** - `assertAiQuotaAvailable()` refuses when the plan's monthly AI
   reply allowance is spent, and says so in the handover reason.

Only step 3 needs replacing to move to embeddings: `searchFaqs()` is the only
function involved.

**Closing the loop.** Every question the assistant could not answer is stored,
deduped, and ranked by how often it was asked
(`GET /api/faqs/unanswered`). Answering one creates the FAQ entry for you
(`POST /api/faqs/unanswered/:id/resolve`), so the gap closes permanently. This
is the single most important screen for improving resolution rate, which is why
the dashboard leads with it.

## 12) Analytics

`analytics.service.js` answers five questions with plain SQL against the
`vw_conversation_metrics` view, all workspace-scoped and parameterised:

| Endpoint | Shape |
|---|---|
| `GET /api/analytics/overview?range=7d\|30d\|90d` | totals + previous-period trends, daily series, per-channel split |
| `GET /api/analytics/ai?range=` | AI message count, handovers and reasons, avg confidence, top intents, knowledge gaps |
| `GET /api/analytics/faqs` | per-entry hits, near misses and hit rate |
| `GET /api/analytics/agents` | per-agent volume, response time, resolution |
| `GET /api/analytics/export?format=csv` | conversation export |

`scripts/verify-analytics.js` runs all seven underlying queries against a live
database and reports pass/fail per statement, so an aggregate can never ship
with a typo in it:

```bash
npm run verify:analytics
```

## 13) Billing

Stripe is optional. Without `STRIPE_SECRET_KEY` the endpoints return 503 and the
dashboard says so, while plan limits, usage counters and the AI quota are fully
enforced from the local `PLAN_CATALOG` in `subscription.service.js`. That means
the product is fully functional on the free plan with no third-party account.

Two price ids are needed per paid plan, because yearly billing is a *different
Stripe price*, not a discount applied at checkout:

```dotenv
STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_STARTER_YEARLY=price_...
STRIPE_PRICE_PRO=price_...
STRIPE_PRICE_PRO_YEARLY=price_...
```

`listPlans()` reports per-period availability, so the pricing screen greys out a
period that has no price instead of taking an order it would fulfil at the
monthly rate.

The webhook is `POST /api/webhooks/stripe` and is registered **before** the
generic `webhookRoutes` router in `app.js`. That ordering is load-bearing:
`webhookRoutes` ends in a catch-all `/:channelType` POST, so mounting it first
would answer `/api/webhooks/stripe` with "unknown channel type" and the Stripe
handler would never run.

## 14) The website widget

`frontend/widget/socialhub.js` is a single dependency-free file served by the API
at `/widget/socialhub.js`:

```html
<script src="https://your-api.example.com/widget/socialhub.js" data-key="wk_..."></script>
```

It is plain ES5 in an IIFE so it can be dropped into any page, any framework,
any build. It polls rather than using a socket, because the widget runs on
arbitrary third-party pages with arbitrary CSP rules while the dashboard (which
is where realtime actually matters) uses Socket.IO.

Security is two-part, replacing a login:

- `widgetKey` - an unguessable public id resolving to exactly one channel.
  Rotating it is a full revoke.
- `visitorId` - a random id in `localStorage`, scoping a visitor to their own
  conversation.

The optional `allowedDomains` channel config is checked as well, so a leaked key
cannot be embedded on someone else's site. All four widget routes are behind
`publicLimiter`.

**Testing it** does not require deploying anything:

```bash
# in the dashboard: Settings -> Channels -> create the website channel
# then open the preview at /widget-preview, or:
open http://localhost:4000/widget/index.html?key=wk_...
```

`frontend/widget/index.html` is a stand-in customer site. The dashboard preview
embeds that same page in an iframe rather than mounting the widget inline,
because the widget positions itself with `position: fixed` and reads
`document.referrer` - sharing a DOM would hide exactly the bugs worth catching.

## 15) Frontend

Vite + React 18 + Tailwind 3, with TanStack Query for server state and
Socket.IO for realtime. `App.jsx` owns the `QueryClient` and the router so the
auth gate can live inside the router and use `useLocation`.

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173, proxies /api and /socket.io to :4000
npm run build
```

Screens:

| Route | Screen |
|---|---|
| `/` | Unified inbox: filters, search, thread, customer panel, internal notes |
| `/analytics` | Volume, channels, assistant performance, FAQ effectiveness |
| `/settings` | Workspace, assistant switches, profile, password |
| `/settings/channels` | Connect channels, Meta OAuth, widget key, embed snippet |
| `/settings/faq` | Knowledge base, the unanswered-question list, CSV import |
| `/settings/team` | Members and roles |
| `/settings/billing` | Plan, usage bars, upgrades |
| `/widget-preview` | The real widget in an iframe, with the copy-paste snippet |

**Realtime strategy.** The dashboard subscribes to workspace events; the inbox
patches its query cache directly instead of refetching, so a new message
re-sorts the row rather than making the list flicker under the cursor. An event
for a conversation outside the current filter falls back to invalidating
instead of inserting a row that may not belong there.

**Design.** One indigo brand scale in `tailwind.config.js`, shared by the
dashboard and the widget. Component classes (`.card`, `.field`, `.nav-link`)
live in `index.css` so a new screen does not invent its own spacing.

## 16) The three plugin systems

All three are loaded at boot by a loader, validated against a shared contract,
and visible at runtime in **Settings -> Plugins**. Plugins are *code*: you add
one by dropping a file or folder into the project and restarting, never through
the UI. That is deliberate - an install button would be a remote-code-execution
hole wearing a nicer hat.

### 16.1 Channel adapters

`src/plugins/contract.js` defines the manifest + adapter shape;
`src/plugins/channel.loader.js` discovers and registers them from two places:

1. `src/adapters/channels/*.js` - the built-ins (messenger, instagram, whatsapp,
   website).
2. `backend/plugins/<folder>/` - third-party plugins. Each folder needs a
   `manifest.json` and an `index.js`. Override the location with
   `CHANNEL_PLUGINS_DIR`.

`backend/plugins/telegram/` is a complete working example. `manifest.json`
declares `id`, `version`, `label`, `description`, `capabilities` and a
`configSchema`; the dashboard renders that schema, so adding a channel needs no
frontend change.

```jsonc
{
  "id": "acme-chat",
  "version": "1.0.0",
  "label": "Acme Chat",
  "capabilities": { "attachments": true, "typingIndicator": false },
  "configSchema": [{ "key": "apiKey", "label": "API key", "required": true }]
}
```

Because `GET /api/channels/catalogue` returns each adapter's
`availability.missing`, the UI greys out any channel whose credentials are not
configured instead of letting you fill in a form that is guaranteed to fail.

### 16.2 AI provider + behaviour plugins

- `src/plugins/ai.contract.js` - provider and behaviour contracts.
- `src/plugins/ai.providers/*.provider.js` - `offline`, `openai`, `groq`.
- `src/plugins/ai.behaviours/*.behaviour.js` - `classify-intent`,
  `detect-escalation`.

A provider exports a `manifest` and a class with `generate()`. A behaviour
exports a `manifest` and `run(context)`, returning a patch object that is merged
into the context for later stages. `ai.service.js` runs the whole pipeline
through `runAiBehaviour()`, so a plugin can replace intent detection or add a
PII-redaction stage without editing the service.

Ordering is by `order` (lower runs first). **A stage that throws is logged and
skipped** - a bad plugin degrades the answer, it does not break the reply.

`AI_PROVIDER` accepts any registered provider id; an unknown id falls back to
`offline` instead of crashing, so a typo is survivable.

### 16.3 Public API + outbound webhooks

**Scoped API keys.** A key belongs to a *workspace* (not a user) and carries
explicit scopes. Only a SHA-256 hash is stored, so the plaintext is returned
exactly once, at creation. Send it as `Authorization: Bearer sh_live_...`.

```bash
curl -H "Authorization: Bearer sh_live_..." http://localhost:4000/api/v1/me
curl -H "Authorization: Bearer sh_live_..." http://localhost:4000/api/v1/conversations
```

Because the workspace comes from the key and never from a header, an integration
physically cannot reach another tenant. `npm run verify:api` proves this by
building a real second workspace and asserting its conversation is invisible.

**Signed webhooks.** Events are POSTed to each subscribed endpoint with:

| Header | Meaning |
|---|---|
| `X-SocialHub-Event` | e.g. `message.created` |
| `X-SocialHub-Delivery` | delivery id (safe to use for dedupe) |
| `X-SocialHub-Sequence` | per-endpoint monotonic counter |
| `X-SocialHub-Timestamp` | unix seconds |
| `X-SocialHub-Signature` | `sha256=<hex>` |

Verify with `HMAC-SHA256(secret, timestamp + "." + rawBody)`, compare in
constant time, and reject timestamps older than 5 minutes to block replays:

```js
const expected = crypto.createHmac('sha256', secret)
  .update(`${req.get('X-SocialHub-Timestamp')}.${rawBody}`)
  .digest('hex');
const ok = crypto.timingSafeEqual(
  Buffer.from(`sha256=${expected}`), Buffer.from(req.get('X-SocialHub-Signature')));
```

Delivery semantics: a 2xx counts as delivered; anything else is retried with
exponential backoff up to `WEBHOOK_MAX_ATTEMPTS`, then the endpoint is
auto-disabled and `disabled_reason` explains why. Rows are claimed atomically
(`status='processing'` + a lease), so two API processes cannot double-send the
same event, and a crashed worker's row is reclaimed once the lease expires.

Signing secrets are encrypted at rest with AES-256-GCM (`ENCRYPTION_KEY`),
because unlike an API key they must be *recoverable* to sign future deliveries.

## 17) Environment variables

Full list with comments in `backend/.env.example`. The ones that change
behaviour rather than just connecting a third party:

| Variable | Effect when unset |
|---|---|
| `AI_PROVIDER` | `offline` - the AI answers only with verbatim FAQ text |
| `AI_CONFIDENCE_THRESHOLD` | defaults to `0.62` |
| `AI_AUTO_SEND` | `false` - the AI drafts, a human sends |
| Meta App ID / App Secret | Configure in Settings → Channels; encrypted in `system_settings`. `.env` remains a fallback. |
| `WEBHOOK_BASE_URL` | Public HTTPS URL required for Meta OAuth callbacks and inbound webhooks |
| `STRIPE_SECRET_KEY` | billing endpoints return 503; plan limits still enforced |
| `FRONTEND_URL` | Checkout redirects to the wrong host |

`npm run check` prints a warning for each of these at boot, so a missing
integration is always visible rather than a silent 500 later.

## 18) What is verified, and what is not

Machine-checked on every run:

- `npm run routes` - 101 routes, guard audit, event contract. It walks the live
  Express router stack, so a new route that skips authentication or tenant
  scoping fails the check.
- `npm run verify:analytics` - all seven aggregate queries against a live DB.
- `npm run verify:plugins` - contract tests for both plugin systems: manifest
  validation, config-schema enforcement, third-party discovery, a working
  example plugin, unknown-provider fallback, and that a *throwing* behaviour
  stage is skipped instead of breaking the reply.
- `npm run verify:api` - 27 checks over the real HTTP surface: key creation and
  one-time secret, scope enforcement, `/api/v1`, signature verification,
  tamper detection, replay-window rejection, retry + auto-disable, revocation,
  and cross-tenant isolation against a genuine second workspace.
- `npm run verify:channels` - signed webhook and widget HTTP messages for all
  built-in inbox channels.
- `npm run verify:meta-config` - confirms Meta credentials are encrypted at
  rest and never returned to the admin client.
- `npm run build` (frontend) - every screen compiles.
- `npm run db:migrate` twice in a row - the schema is re-runnable.

Not yet exercised end to end in a browser: the OAuth redirect dance, a real
Stripe checkout, and the widget round trip against a running API. Those need
real credentials, or a deliberate manual pass.

### Channels: what actually works locally

This matters, because a green build does not mean "all channels send messages".
Only channels with real credentials can complete a round trip.

| Channel | Catalogue | Inbound pipeline | Live send |
|---|---|---|---|
| Website Chat | available | proven | proven |
| Facebook Messenger | configure in Channels | proven | Meta app permissions, public HTTPS callback, authorized Page |
| Instagram | configure in Channels | proven | Meta app permissions, public HTTPS callback, linked professional account |
| WhatsApp | configure in Channels | proven | Meta app permissions, public HTTPS callback, authorized Cloud API phone number |
| Telegram | needs setup | proven | needs `TELEGRAM_BOT_TOKEN` |

The Channels admin screen stores App ID/Secret encrypted on the server and
shows the callback URLs. Configure `WEBHOOK_BASE_URL` in `backend/.env` to a
public HTTPS endpoint, add the OAuth callback/webhooks in Meta, then authorize
Pages and WhatsApp numbers with **Connect Meta account**.

Inbound is a different story, and worth being precise about: `npm run
verify:channels` drives the Meta handshake and inbound-message path for
Messenger, Instagram and WhatsApp against the real database, plus a full website
widget round trip. So the *shared pipeline* - signature check, account
resolution, dedupe, persist, AI reply - is proven for every channel. What is not
proven is Meta's live transport and OAuth consent, which need real credentials.

## 19) Known gaps

Honest list of what is deliberately not done:

- Meta invite-based team onboarding: the add-member endpoint takes an existing
  account's email, and does not send an invitation email.
- Email notifications and SLA breach alerts.
- `POST /api/conversations/:id/messages/:messageId/retry` exists and the UI
  shows failed messages, but the retry button is not wired into the thread yet.
- Conversation priority is stored and displayed but not editable (no route).
- Message attachments can be uploaded and sent, but there is no drag-and-drop
  or file picker in the composer.
- Webhook SSRF protection is deliberately partial: `assertValidUrl` blocks the
  literal metadata endpoints and plain-HTTP public hosts (localhost stays
  allowed so the loopback test works), but it does not yet resolve DNS, so a
  hostname that resolves to a private address would still pass. Add DNS
  resolution + a redirect guard before exposing this publicly.
- `contacts:read` and `faqs:write` are advertised in `API_SCOPES` but no public
  route consumes them yet, so a key can be granted a scope that does nothing.
- The Meta connect token store is in-process and in-memory, so it does not
  survive a restart and will not work behind more than one API instance. Move it
  to the database (or a shared cache) before scaling out.

