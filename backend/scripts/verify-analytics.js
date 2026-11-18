/**
 * Executes every analytics query against the live database.
 *
 * The route guard audit only proves the middleware is present; this proves the
 * SQL actually runs. Run with:
 *   node --env-file=.env scripts/verify-analytics.js
 */
import { closePool } from '../src/db/pool.js';
import {
  resolveRange,
  overview,
  timeseries,
  byChannel,
  byAgent,
  aiPerformance,
  faqPerformance,
} from '../src/services/analytics.service.js';
import { searchFaqs } from '../src/services/faq.service.js';
import { queryOne } from '../src/db/pool.js';

const workspace = await queryOne('SELECT id, name, ai_enabled, ai_auto_send FROM workspaces ORDER BY id LIMIT 1');
if (!workspace) {
  console.error('No workspace found - run `npm run db:seed` first.');
  process.exit(1);
}

const since = resolveRange('30d').since;
let pass = 0;
let fail = 0;

const run = async (label, fn, inspect) => {
  try {
    const result = await fn();
    const note = inspect ? ` -> ${inspect(result)}` : '';
    console.log(`  PASS  ${label}${note}`);
    pass += 1;
  } catch (error) {
    console.log(`  FAIL  ${label} -> ${error.message}`);
    fail += 1;
  }
};

console.log(`\nWorkspace: #${workspace.id} ${workspace.name}\n`);

await run('overview', () => overview(workspace.id, since), (r) =>
  `${r.conversations} conversations, aiResolutionRate=${r.aiResolutionRate}%, csat=${r.satisfaction.avgRating}`);
await run('timeseries', () => timeseries(workspace.id, since), (r) => `${r.length} day buckets`);
await run('byChannel', () => byChannel(workspace.id, since), (r) =>
  r.length ? r.map((row) => `${row.channel}:${row.conversations}`).join(' ') : 'no channel rows yet');
await run('byAgent', () => byAgent(workspace.id, since), (r) => `${r.length} members`);
await run('aiPerformance', () => aiPerformance(workspace.id, since), (r) =>
  `resolved=${r.resolved} handovers=${r.handovers} gaps=${r.knowledgeGaps.distinctQuestions}`);
await run('faqPerformance', () => faqPerformance(workspace.id), (r) => `${r.length} faqs`);
await run('searchFaqs("delivery")', () => searchFaqs(workspace.id, 'how long does delivery take', 3), (r) =>
  r.length ? `top=${r[0].faq.question.slice(0, 40)}... score=${Number(r[0].score.toFixed(3))}` : 'no match');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
await closePool();
process.exit(fail === 0 ? 0 : 1);
