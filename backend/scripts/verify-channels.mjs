/** End-to-end inbound smoke test for every built-in messaging channel. */
import crypto from 'node:crypto';
import http from 'node:http';

// The webhook detector validates Meta signatures before it looks up a channel.
process.env.META_APP_SECRET ||= crypto.randomBytes(32).toString('hex');

const { env } = await import('../src/config/env.js');
const { ensureAdaptersLoaded } = await import('../src/adapters/factory.js');
const { loadAiPlugins } = await import('../src/plugins/ai.loader.js');
const { createApp } = await import('../src/app.js');
const {
  deleteRows,
  getAdminClient,
  insertRow,
  selectOne,
  withSupabaseClient,
} = await import('../src/db/supabase.js');
const { createChannel } = await import('../src/services/channels.service.js');
const { closeSocket, initSocket } = await import('../src/services/socket.service.js');

let failures = 0;
const check = (name, passed, detail = '') => {
  if (!passed) failures += 1;
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -> ${detail}` : ''}`);
};

let workspaceId = null;
let server = null;
const channels = [];

await withSupabaseClient(getAdminClient(), async () => {
try {
  await ensureAdaptersLoaded();
  await loadAiPlugins();

  const suffix = crypto.randomUUID();
  const workspace = await insertRow('workspaces', {
    name: 'Channel Integration Smoke Test',
    slug: `verify-channels-${suffix}`,
  });
  workspaceId = workspace.id;

  const metaSecret = env.META_APP_SECRET;
  const verifyToken = env.META_VERIFY_TOKEN;
  const metas = [
    {
      type: 'messenger',
      externalId: `page-${suffix}`,
      contactId: `psid-${suffix}`,
      messageId: `mid-${suffix}`,
      body: `Messenger smoke ${suffix}`,
      payload: (accountId, contactId, messageId, body) => ({
        object: 'page',
        entry: [{
          id: accountId,
          messaging: [{
            sender: { id: contactId, first_name: 'Smoke', last_name: 'Visitor' },
            recipient: { id: accountId },
            timestamp: Date.now(),
            message: { mid: messageId, text: body },
          }],
        }],
      }),
    },
    {
      type: 'instagram',
      externalId: `igid-${suffix}`,
      contactId: `ig-user-${suffix}`,
      messageId: `ig-mid-${suffix}`,
      body: `Instagram smoke ${suffix}`,
      payload: (accountId, contactId, messageId, body) => ({
        object: 'instagram',
        entry: [{
          id: accountId,
          messaging: [{
            sender: { id: contactId, name: 'Smoke Visitor' },
            recipient: { id: accountId },
            timestamp: Date.now(),
            message: { mid: messageId, text: body },
          }],
        }],
      }),
    },
    {
      type: 'whatsapp',
      externalId: `phone-${suffix}`,
      contactId: `1555${suffix.replaceAll('-', '').slice(0, 8)}`,
      messageId: `wamid-${suffix}`,
      body: `WhatsApp smoke ${suffix}`,
      payload: (phoneNumberId, contactId, messageId, body) => ({
        object: 'whatsapp_business_account',
        entry: [{
          id: `waba-${suffix}`,
          changes: [{
            field: 'messages',
            value: {
              metadata: { phone_number_id: phoneNumberId },
              contacts: [{ wa_id: contactId, profile: { name: 'Smoke Visitor' } }],
              messages: [{
                id: messageId,
                from: contactId,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'text',
                text: { body },
              }],
            },
          }],
        }],
      }),
    },
  ];

  for (const meta of metas) {
    const channel = await createChannel({
      workspaceId,
      type: meta.type,
      name: `${meta.type} smoke`,
      externalId: meta.externalId,
      config: {
        accessToken: 'test-token-not-used-by-inbound',
        appSecret: metaSecret,
        verifyToken,
        pageId: meta.externalId,
        instagramUserId: meta.externalId,
        phoneNumberId: meta.externalId,
      },
    });
    channels.push(channel);
  }

  const websiteKey = `wk_${workspaceId}_${suffix.replaceAll('-', '')}`;
  const website = await createChannel({
    workspaceId,
    type: 'website',
    name: 'Website smoke',
    config: { widgetKey: websiteKey, allowedDomains: [], defaultName: 'Smoke Visitor' },
  });
  channels.push(website);

  server = http.createServer(createApp());
  initSocket(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  console.log('\nInbound channel -> unified inbox');
  for (let index = 0; index < metas.length; index += 1) {
    const meta = metas[index];
    const channel = channels[index];
    const challenge = `challenge-${suffix}-${meta.type}`;
    const handshakeUrl = new URL(`/api/webhooks/${meta.type}`, baseUrl);
    handshakeUrl.search = new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.verify_token': verifyToken,
      'hub.challenge': challenge,
    });
    const handshake = await fetch(handshakeUrl);
    check(`${meta.type} webhook handshake`, handshake.status === 200 && (await handshake.text()) === challenge);

    const payload = meta.payload(meta.externalId, meta.contactId, meta.messageId, meta.body);
    const rawBody = JSON.stringify(payload);
    const signature = `sha256=${crypto.createHmac('sha256', metaSecret).update(rawBody).digest('hex')}`;
    const response = await fetch(`${baseUrl}/api/webhooks/${meta.type}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      body: rawBody,
    });
    const stored = await selectOne('messages', 'body,conversation_id,channel_id', {
      channel_id: channel.id, external_id: meta.messageId,
    });
    const storedChannel = stored && await selectOne('channels', 'type', { id: stored.channel_id });
    check(
      `${meta.type} inbound message appears in inbox`,
      response.status === 200 && storedChannel?.type === meta.type && stored?.body === meta.body,
      `http=${response.status}, conversation=${stored?.conversation_id ?? 'missing'}`,
    );
  }

  const websiteVisitor = `visitor-${suffix}`;
  const websiteMessage = `Website smoke ${suffix}`;
  const widgetResponse = await fetch(`${baseUrl}/api/widget/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ widgetKey: websiteKey, visitorId: websiteVisitor, message: websiteMessage }),
  });
  const websiteData = await widgetResponse.json();
  const websiteConversation = await selectOne('conversations', 'id,channel_id', {
    channel_id: website.id, external_id: websiteVisitor,
  });
  const websiteStored = websiteConversation
    ? await selectOne('messages', 'body,channel_id', {
        conversation_id: websiteConversation.id, body: websiteMessage,
      })
    : null;
  const websiteStoredChannel = websiteStored && await selectOne('channels', 'type', {
    id: websiteStored.channel_id,
  });
  check(
    'website widget message appears in inbox',
    widgetResponse.status === 201 && websiteData.conversationId && websiteStoredChannel?.type === 'website',
    `http=${widgetResponse.status}, conversation=${websiteStored?.conversation_id ?? 'missing'}`,
  );
} catch (error) {
  failures += 1;
  console.error(`  FAIL  channel integration setup -> ${error.message}`);
} finally {
  await closeSocket();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  if (workspaceId) await deleteRows('workspaces', { id: workspaceId }).catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL CHANNEL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
});