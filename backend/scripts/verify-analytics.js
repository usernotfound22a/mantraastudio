/**
 * Executes the analytics and FAQ service queries against a configured Supabase
 * project. Requires a server-only SUPABASE_SECRET_KEY.
 */
import { getAdminClient, selectRows, withSupabaseClient } from '../src/db/supabase.js';
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

await withSupabaseClient(getAdminClient(), async () => {
  const [workspace] = await selectRows('workspaces', 'id,name', {}, {
    order: [{ column: 'id', ascending: true }],
    limit: 1,
  });
  if (!workspace) {
    console.error('No workspace found. Register a user and create a workspace first.');
    process.exitCode = 1;
    return;
  }

  const since = resolveRange('30d').since;
  let pass = 0;
  let fail = 0;
  const run = async (label, fn, inspect) => {
    try {
      const result = await fn();
      console.log(`  PASS  ${label}${inspect ? ` -> ${inspect(result)}` : ''}`);
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
  if (fail) process.exitCode = 1;
});
