/**
 * Proves the three plugin systems are wired correctly at boot.
 *
 * This is a smoke test, not a unit test: it loads the app the same way the
 * server does and asserts that
 *   1. built-in AND third-party channel adapters were discovered
 *   2. the manifest for each was validated and recorded
 *   3. AI providers resolve, including the OpenAI-compatible presets
 *   4. behaviour stages run in order
 *   5. a broken plugin is rejected with a useful message
 */
import { loadChannelPlugins, listPluginManifests, getPluginManifest } from '../src/plugins/channel.loader.js';
import {
  loadAiPlugins,
  listAiProviderManifests,
  resolveAiProvider,
  listAiBehaviour,
  runAiBehaviour,
  registerAiBehaviour,
  registerAiProvider,
} from '../src/plugins/ai.loader.js';
import { validateManifest } from '../src/plugins/contract.js';
import { getAdapterClass } from '../src/adapters/registry.js';

let failures = 0;
const check = (label, condition, detail = '') => {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`  ${mark}  ${label}${detail ? ` -> ${detail}` : ''}`);
};

console.log('\nSocialHub plugin systems\n');

// ------------------------------------------------- 1. channel plugins
console.log('[1] Channel adapter plugins');
await loadChannelPlugins();
const manifests = listPluginManifests();
const types = manifests.map((m) => m.type);

check('built-in adapters discovered', ['website', 'messenger', 'instagram', 'whatsapp'].every((t) => types.includes(t)), types.join(', '));
check('third-party telegram plugin discovered', types.includes('telegram'));

const WhatsAppAdapter = getAdapterClass('whatsapp');
const whatsappAdapter = new WhatsAppAdapter();
const whatsappPayload = {
  entry: [{
    id: 'waba-1',
    changes: [{
      field: 'messages',
      value: {
        metadata: { phone_number_id: 'phone-1' },
        contacts: [{ wa_id: '15551234567', profile: { name: 'Ada Customer' } }],
        messages: [{
          id: 'wamid.test-1',
          from: '15551234567',
          timestamp: '1760000000',
          type: 'text',
          text: { body: 'Order status, please' },
        }],
      },
    }],
  }],
};
const whatsappMessages = whatsappAdapter.parseInbound(whatsappPayload);
check('WhatsApp webhook resolves its phone-number channel', whatsappAdapter.resolveAccountId(whatsappPayload) === 'phone-1');
check(
  'WhatsApp inbound message normalizes for the shared inbox',
  whatsappMessages.length === 1 &&
    whatsappMessages[0].contact.name === 'Ada Customer' &&
    whatsappMessages[0].content.text === 'Order status, please' &&
    whatsappMessages[0].metadata.channel === 'whatsapp',
);

const telegram = getPluginManifest('telegram');
check('telegram manifest parsed from manifest.json', telegram?.version === '1.0.0', `v${telegram?.version}`);
check('telegram manifest type matches adapter', telegram?.type === 'telegram');
check('telegram configSchema surfaced', Array.isArray(telegram?.configSchema) && telegram.configSchema.length === 2);

const builtin = getPluginManifest('messenger');
check('built-in adapter got a synthesised manifest', Boolean(builtin?.label));

// manifest validation must REJECT bad input
let rejected = false;
try {
  validateManifest({ name: 'x', version: 'nope', type: 'Bad Type' }, { source: 'test' });
} catch {
  rejected = true;
}
check('invalid manifest is rejected', rejected);

// ------------------------------------------------------ 2. AI providers
console.log('\n[2] AI provider plugins');
await loadAiPlugins();
const providers = listAiProviderManifests();
const providerIds = providers.map((p) => p.id);
check('offline/openai/groq registered', ['offline', 'openai', 'groq'].every((p) => providerIds.includes(p)), providerIds.join(', '));

const offline = resolveAiProvider('offline');
check('offline provider resolves', offline?.id === 'offline');
const offlineResult = await offline.generate({ faqAnswer: 'We ship in 2 days.' });
check('offline provider returns the FAQ text', offlineResult.text === 'We ship in 2 days.');

const groq = resolveAiProvider('groq');
check('groq preset resolves to the OpenAI-compatible class', groq?.baseUrl === 'https://api.groq.com/openai/v1');

// an unknown provider must fall back, never crash the pipeline
const unknown = resolveAiProvider('does-not-exist');
check('unknown provider falls back to offline', unknown?.id === 'offline');

// a third-party provider can be registered at runtime
registerAiProvider(
  class EchoProvider {
    static id = 'echo';
    async generate() {
      return { text: 'echo', generated: false };
    }
  },
);
check('runtime-registered provider works', (await resolveAiProvider('echo').generate()).text === 'echo');

// ------------------------------------------------------ 3. AI behaviours
console.log('\n[3] AI behaviour plugins');
const behaviourIds = listAiBehaviour().map((b) => b.id);
check('built-in behaviours registered', behaviourIds.includes('classify-intent') && behaviourIds.includes('detect-escalation'), behaviourIds.join(' -> '));

const ordered = listAiBehaviour().map((b) => b.id);
check('behaviours run in order', ordered.indexOf('classify-intent') < ordered.indexOf('detect-escalation'));

const ctx = await runAiBehaviour({ text: 'I want a refund and I am furious' });
check('intent classified by behaviour', ctx.intent === 'refund', `intent=${ctx.intent}`);
check('escalation decided by behaviour', ctx.escalate === true && ctx.escalationReason === 'negative_sentiment', ctx.escalationReason);

// a plugin can add a stage, and a throwing stage must not break the pipeline
registerAiBehaviour({
  id: 'test-shout',
  order: 5,
  async run() {
    return { shout: true };
  },
});
registerAiBehaviour({
  id: 'test-broken',
  order: 6,
  async run() {
    throw new Error('intentional');
  },
});
const ctx2 = await runAiBehaviour({ text: 'hello' });
check('custom behaviour applied', ctx2.shout === true);
check('throwing behaviour is skipped, pipeline survives', ctx2.intent !== undefined, `intent=${ctx2.intent}`);

console.log(`\n${failures === 0 ? 'ALL PLUGIN CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
