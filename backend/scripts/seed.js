/**
 * Seeds a demo workspace so you can log in and see something on screen.
 *
 *   npm run db:seed
 *
 * Idempotent: re-running it updates the demo rows instead of duplicating them.
 * Login with  demo@socialhub.test / Demo1234!
 */
import bcrypt from 'bcryptjs';
import { env } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { query, queryOne, execute, withTransaction, txQuery, txExecute, closePool } from '../src/db/pool.js';

const DEMO = {
  email: 'demo@socialhub.test',
  password: 'Demo1234!',
  ownerName: 'Demo Owner',
  workspaceName: 'Acme Support',
  agentEmail: 'agent@socialhub.test',
  agentName: 'Sara Agent',
};

/** `acme-support`, `acme-support-2`, ... so re-runs never clash on the slug. */
async function uniqueSlug(base) {
  const rows = await query('SELECT slug FROM workspaces WHERE slug LIKE ?', [`${base}%`]);
  if (rows.length === 0) return base;
  return `${base}-${rows.length + 1}`;
}

async function main() {
  const passwordHash = await bcrypt.hash(DEMO.password, env.BCRYPT_ROUNDS);

  await withTransaction(async (connection) => {
    // --- 1. Owner user ----------------------------------------------------
    await txExecute(
      connection,
      `INSERT INTO users (email, password_hash, full_name, job_title, email_verified_at)
       VALUES (?, ?, ?, 'Head of Support', NOW())
       ON DUPLICATE KEY UPDATE full_name = VALUES(full_name)`,
      [DEMO.email, passwordHash, DEMO.ownerName],
    );
    const owner = await txQuery(connection, 'SELECT * FROM users WHERE email = ?', [DEMO.email]);

    // --- 2. Agent user ----------------------------------------------------
    await txExecute(
      connection,
      `INSERT INTO users (email, password_hash, full_name, job_title, email_verified_at)
       VALUES (?, ?, ?, 'Support Agent', NOW())
       ON DUPLICATE KEY UPDATE full_name = VALUES(full_name)`,
      [DEMO.agentEmail, passwordHash, DEMO.agentName],
    );
    const agent = await txQuery(connection, 'SELECT * FROM users WHERE email = ?', [DEMO.agentEmail]);

    // --- 3. Workspace -----------------------------------------------------
    const existing = await txQuery(connection, 'SELECT * FROM workspaces WHERE name = ?', [
      DEMO.workspaceName,
    ]);
    let workspace = existing[0];
    if (!workspace) {
      const slug = await uniqueSlug('acme-support');
      const result = await txExecute(
        connection,
        `INSERT INTO workspaces (name, slug, timezone, support_name, created_by, business_hours)
         VALUES (?, ?, 'Europe/London', 'Acme Support', ?, ?)`,
        [
          DEMO.workspaceName,
          slug,
          owner[0].id,
          JSON.stringify({
            monday: ['09:00', '17:00'],
            tuesday: ['09:00', '17:00'],
            wednesday: ['09:00', '17:00'],
            thursday: ['09:00', '17:00'],
            friday: ['09:00', '17:00'],
          }),
        ],
      );
      workspace = { id: result.insertId, slug };
    }

    // --- 4. Memberships ---------------------------------------------------
    await txExecute(
      connection,
      `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
       VALUES (?, ?, 'owner', 'active', NOW())
       ON DUPLICATE KEY UPDATE role = 'owner'`,
      [workspace.id, owner[0].id],
    );
    await txExecute(
      connection,
      `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
       VALUES (?, ?, 'agent', 'active', NOW())
       ON DUPLICATE KEY UPDATE role = 'agent'`,
      [workspace.id, agent[0].id],
    );

    // --- 5. Free subscription (plan limits live here) ---------------------
    await txExecute(
      connection,
      `INSERT INTO subscriptions (workspace_id, plan, status, seats, messages_limit, ai_replies_limit)
       VALUES (?, 'free', 'active', 3, 100, 50)
       ON DUPLICATE KEY UPDATE plan = VALUES(plan)`,
      [workspace.id],
    );

    // --- 6. A website channel so the inbox is not empty -------------------
    await txExecute(
      connection,
      `INSERT INTO channels (workspace_id, type, name, external_id, is_default, config, connected_by)
       VALUES (?, 'website', 'Website chat', ?, 1, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [
        workspace.id,
        `web-${workspace.id}`,
        JSON.stringify({
          widgetKey: `wk_demo_${workspace.id}_replace_me`,
          greeting: 'Hi! Ask us anything about your order.',
          themeColor: '#4f46e5',
        }),
        owner[0].id,
      ],
    );

    // --- 7. A couple of FAQ entries for the AI ---------------------------
    const faqCount = await txQuery(
      connection,
      'SELECT COUNT(*) AS total FROM faqs WHERE workspace_id = ?',
      [workspace.id],
    );
    if (faqCount[0].total === 0) {
      const faqs = [
        [
          'What are your delivery times?',
          'Standard delivery takes 2-3 working days within the UK, and 5-7 days internationally. You will get a tracking link by email as soon as your parcel leaves our warehouse.',
          ['delivery', 'shipping', 'how long', 'when will it arrive', 'postage'],
        ],
        [
          'How do I return an item?',
          'You have 30 days from delivery to return anything unused. Go to your account, open the order and click "Request return". We email you a free return label within one working day.',
          ['return', 'refund', 'exchange', 'send back'],
        ],
        [
          'Do you offer a warranty?',
          'All electronics include a 2-year manufacturer warranty, and clothing is covered for manufacturing faults for 12 months. Keep your receipt - we can look it up with your order number.',
          ['warranty', 'guarantee', 'broken', 'defect'],
        ],
      ];
      for (const [question, answer, keywords] of faqs) {
        await txExecute(
          connection,
          `INSERT INTO faqs (workspace_id, question, answer, keywords, category, source, created_by)
           VALUES (?, ?, ?, ?, 'General', 'manual', ?)`,
          [workspace.id, question, answer, JSON.stringify(keywords), owner[0].id],
        );
      }
    }

    logger.info(
      {
        workspaceId: workspace.id,
        workspaceSlug: workspace.slug,
        members: ['owner', 'agent'],
        faqsSeeded: faqCount[0].total === 0,
      },
      'Demo data ready',
    );
  });

  const check = await queryOne('SELECT COUNT(*) AS total FROM users');
  logger.info({ users: check.total }, 'Seed complete');
  logger.info(`   Login:  ${DEMO.email}  /  ${DEMO.password}`);
}

main()
  .catch((error) => {
    logger.error({ code: error.code, message: error.message }, 'Seed failed');
    if (error.code === 'ER_NO_SUCH_TABLE') {
      logger.error('Tables are missing - run `npm run db:migrate` first.');
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
