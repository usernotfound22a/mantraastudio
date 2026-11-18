-- ===========================================================================
--  SocialHub - MySQL schema
--  Engine: InnoDB   Charset: utf8mb4   (emoji-safe for customer messages)
--
--  Run with:  npm run db:migrate      (applies this file)
--  Reset with: npm run db:reset       (drops + recreates + seeds)
--
--  Table order matters (parents before children) because of the FKs:
--    users -> workspaces -> workspace_members -> faqs -> channels
--           -> conversations -> messages / notes
--           -> subscriptions
--  `faqs` sits before `conversations` because conversations.ai_last_faq_id
--  references it.
-- ===========================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------------
--  Drop in reverse dependency order so the script can be re-run safely.
-- ---------------------------------------------------------------------------
-- TABLES ARE NEVER DROPPED HERE.
--
-- An earlier version dropped every table at the top of this file, which meant
-- `npm run db:migrate` silently deleted every connected channel, every
-- conversation and every message on a machine you had already set up. Connecting
-- a Meta page is manual, multi-step work, so losing it to a routine migration is
-- unacceptable.
--
-- Every CREATE below is therefore IF NOT EXISTS, and dropping is opt-in:
--     npm run db:migrate -- --fresh
-- migrate.js runs the teardown in reverse-dependency order (children first) when
-- that flag is present.
-- ---------------------------------------------------------------------------

-- Outbound webhook tables reference workspaces and api_keys, so if you ever add
-- a table like this, list it first in the teardown.


-- ===========================================================================
--  1. users  -  a human who can sign in. May belong to many workspaces.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS `users` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- 191 chars keeps the unique index inside the 767/3072 byte utf8mb4 limit.
  `email`          VARCHAR(191)    NOT NULL,
  -- NULL for accounts that only ever sign in through an OAuth provider.
  `password_hash`  VARCHAR(255)    NULL,
  `full_name`      VARCHAR(120)    NOT NULL,
  `avatar_url`     VARCHAR(500)    NULL,
  `job_title`      VARCHAR(120)    NULL,
  `phone`          VARCHAR(40)     NULL,
  -- Linked identities for Meta OAuth (one user, one Facebook identity).
  `meta_user_id`   VARCHAR(191)    NULL,
  `status`         ENUM('active','disabled')      NOT NULL DEFAULT 'active',
  `last_login_at`  DATETIME        NULL,
  `email_verified_at` DATETIME     NULL,
  `created_at`     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_users_email` (`email`),
  UNIQUE KEY `uq_users_meta_user` (`meta_user_id`),
  KEY `ix_users_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Server-wide admin settings. Secret values are AES-256-GCM encrypted by the
-- application before being written; the key is ENCRYPTION_KEY (or JWT_SECRET).
CREATE TABLE IF NOT EXISTS `system_settings` (
  `setting_key`   VARCHAR(120) NOT NULL,
  `setting_value` TEXT         NOT NULL,
  `updated_by`    BIGINT UNSIGNED NULL,
  `updated_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`setting_key`),
  CONSTRAINT `fk_system_settings_user` FOREIGN KEY (`updated_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
--  2. workspaces  -  the tenant boundary. Everything else hangs off this.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS `workspaces` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`          VARCHAR(150)    NOT NULL,
  -- URL-safe handle used for public links (e.g. /w/acme-shop).
  `slug`          VARCHAR(150)    NOT NULL,
  `logo_url`      VARCHAR(500)    NULL,
  `timezone`      VARCHAR(64)     NOT NULL DEFAULT 'UTC',
  `locale`        VARCHAR(16)     NOT NULL DEFAULT 'en',
  -- Business hours are consumed by the AI service to answer "are you open?".
  `business_hours` JSON           NULL,
  -- Person shown in the widget header and AI signature.
  `support_name`  VARCHAR(120)    NULL,
  `ai_enabled`    TINYINT(1)      NOT NULL DEFAULT 1,
  -- When false the AI never auto-replies, it only drafts suggestions.
  `ai_auto_send`  TINYINT(1)      NOT NULL DEFAULT 1,
  `ai_handover_keywords` JSON      NULL,
  `settings`      JSON            NULL,
  `created_by`    BIGINT UNSIGNED NULL,
  `created_at`    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_workspaces_slug` (`slug`),
  KEY `ix_workspaces_created_by` (`created_by`),
  CONSTRAINT `fk_workspaces_creator` FOREIGN KEY (`created_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
--  3. workspace_members  -  many-to-many users <-> workspaces, with a role.
--     role: owner (billing + everything), admin (channels/FAQ/team),
--           agent (inbox only).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS `workspace_members` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `workspace_id`  BIGINT UNSIGNED NOT NULL,
  `user_id`       BIGINT UNSIGNED NOT NULL,
  `role`          ENUM('owner','admin','agent') NOT NULL DEFAULT 'agent',
  `status`        ENUM('active','invited')      NOT NULL DEFAULT 'active',
  `invited_by`    BIGINT UNSIGNED NULL,
  `invited_at`    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `joined_at`     DATETIME        NULL,
  `created_at`    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  -- One membership row per (workspace, user): lets us safely re-join.
  UNIQUE KEY `uq_member_workspace_user` (`workspace_id`, `user_id`),
  KEY `ix_members_user` (`user_id`),
  KEY `ix_members_role` (`workspace_id`, `role`),
  CONSTRAINT `fk_members_workspace` FOREIGN KEY (`workspace_id`)
    REFERENCES `workspaces` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_members_user` FOREIGN KEY (`user_id`)
    REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_members_inviter` FOREIGN KEY (`invited_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
--  4. faqs  -  the knowledge base the AI retrieves from.
--     Created before `conversations` because conversations.ai_last_faq_id
--     references it. `match_count` + `last_matched_at` power the
--     "top questions" panel on the analytics dashboard.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS `faqs` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `workspace_id`    BIGINT UNSIGNED NOT NULL,
  `question`        VARCHAR(500)    NOT NULL,
  `answer`          TEXT            NOT NULL,
  -- Alternative phrasings customers actually type; boosts retrieval recall.
  `keywords`        JSON            NULL,
  `tags`            JSON            NULL,
  `category`        VARCHAR(120)    NULL,
  `source`          ENUM('manual','imported','learned') NOT NULL DEFAULT 'manual',
  `match_count`     INT UNSIGNED    NOT NULL DEFAULT 0,
  `no_match_count`  INT UNSIGNED    NOT NULL DEFAULT 0,
  `last_matched_at` DATETIME        NULL,
  -- 1 = the AI may reply with this entry, 0 = archived but kept for history.
  `is_active`       TINYINT(1)      NOT NULL DEFAULT 1,
  `created_by`      BIGINT UNSIGNED NULL,
  `created_at`      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_faqs_workspace_active` (`workspace_id`, `is_active`),
  KEY `ix_faqs_question` (`question`(191)),
  KEY `ix_faqs_popularity` (`workspace_id`, `match_count`),
  CONSTRAINT `fk_faqs_workspace` FOREIGN KEY (`workspace_id`)
    REFERENCES `workspaces` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_faqs_creator` FOREIGN KEY (`created_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
--  5. channels  -  ONE ROW PER CONNECTED CHANNEL (adapter instance).
--
--     `type` decides which adapter class is instantiated by the adapter factory.
--     `config` holds every channel-specific secret/settings as JSON, which is
--     what keeps the adapters decoupled from the schema:
--       messenger / instagram -> { pageId, instagramUserId, accessToken,
--                                  verifyToken, appSecret }
--       website               -> { widgetKey, domain, themeColor, greeting }
--
--     Adding a channel = drop in an adapter plugin. Because `type` is a
--     VARCHAR rather than an ENUM, a third-party plugin can introduce its own
--     type (e.g. 'whatsapp', 'telegram', 'tiktok') with no migration, and
--     the value is still validated against the loaded adapter registry.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS `channels` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `workspace_id`  BIGINT UNSIGNED NOT NULL,
  `type`          VARCHAR(50)     NOT NULL,
  `name`          VARCHAR(150)    NOT NULL,
  -- Identifier of the account on the remote side (FB page id, IG business id,
  -- or the workspace id for the built-in website widget).
  `external_id`   VARCHAR(191)    NULL,
  `status`        ENUM('connected','disconnected','error') NOT NULL DEFAULT 'connected',
  `is_default`    TINYINT(1)      NOT NULL DEFAULT 0,
  `config`        JSON            NULL,
  `last_error`    VARCHAR(500)    NULL,
  `connected_by`  BIGINT UNSIGNED NULL,
  `created_at`    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  -- A remote account may only be attached to one workspace.
  UNIQUE KEY `uq_channel_external` (`type`, `external_id`),
  KEY `ix_channels_workspace` (`workspace_id`, `type`),
  -- Webhook routing: "which workspace owns this page id?"
  KEY `ix_channels_external` (`type`, `external_id`),
  CONSTRAINT `fk_channels_workspace` FOREIGN KEY (`workspace_id`)
    REFERENCES `workspaces` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_channels_user` FOREIGN KEY (`connected_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
--  Social account tokens and metadata. This is the phase-2 foundation for
--  Meta/Facebook/Instagram publishing, token refresh, and reconnect UX.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `social_accounts` (
  `id`                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `workspace_id`          BIGINT UNSIGNED NOT NULL,
  `platform`              VARCHAR(32)     NOT NULL,
  `external_id`           VARCHAR(191)    NOT NULL,
  `name`                  VARCHAR(150)    NOT NULL,
  `avatar_url`            VARCHAR(500)    NULL,
  -- AES-256-GCM encrypted value produced by crypto.service.js.
  `encrypted_access_token` TEXT            NULL,
  `token_expires_at`      DATETIME        NULL,
  `scopes`                JSON            NULL,
  `status`                ENUM('connected','needs_reconnect','disabled') NOT NULL DEFAULT 'connected',
  `connected_by`          BIGINT UNSIGNED NULL,
  `metadata`              JSON            NULL,
  `created_at`            TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_social_account_external` (`workspace_id`, `platform`, `external_id`),
  KEY `ix_social_accounts_workspace` (`workspace_id`, `platform`, `status`),
  CONSTRAINT `fk_social_accounts_workspace` FOREIGN KEY (`workspace_id`)
    REFERENCES `workspaces` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_social_accounts_user` FOREIGN KEY (`connected_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
--  6. conversations  -  one thread per customer, unified across channels.
--     The inbox reads *this* table only, which is the whole point of the
--     unified inbox: channel differences are normalised away by the adapter.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS `conversations` (
  `id`                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `workspace_id`          BIGINT UNSIGNED NOT NULL,
  `channel_id`            BIGINT UNSIGNED NOT NULL,
  -- Thread id on the remote side; used to de-duplicate webhook deliveries.
  `external_id`           VARCHAR(191)    NOT NULL,
  -- Customer identity on the remote side (FB PSID, IG IGID, widget visitor id).
  `contact_external_id`   VARCHAR(191)    NOT NULL,
  `contact_name`          VARCHAR(191)    NULL,
  `contact_avatar_url`    VARCHAR(500)    NULL,
  `contact_email`         VARCHAR(191)    NULL,
  `contact_locale`        VARCHAR(16)     NULL,
  `subject`               VARCHAR(255)    NULL,
  `status`                ENUM('open','pending','closed') NOT NULL DEFAULT 'open',
  `priority`              ENUM('low','normal','high')       NOT NULL DEFAULT 'normal',
  -- Agent currently responsible (NULL = unassigned round-robin pool).
  `assignee_id`           BIGINT UNSIGNED NULL,
  `unread_count`          INT UNSIGNED    NOT NULL DEFAULT 0,
  `last_message_at`       DATETIME        NULL,
  `last_message_preview`  VARCHAR(255)    NULL,
  `last_message_direction` ENUM('inbound','outbound') NULL,
  -- ---- AI bookkeeping -------------------------------------------------
  `ai_enabled`            TINYINT(1)      NOT NULL DEFAULT 1,
  -- 1 once a human took over; the AI stays silent for the rest of the thread.
  `ai_handover`           TINYINT(1)      NOT NULL DEFAULT 0,
  `ai_handover_reason`    VARCHAR(255)    NULL,
  `ai_handover_at`        DATETIME        NULL,
  `ai_last_faq_id`        BIGINT UNSIGNED NULL,
  `ai_confidence`         DECIMAL(4,3)    NULL,
  `ai_summary`            TEXT            NULL,
  `ai_lead_tags`          JSON            NULL,
  `ai_resolved`           TINYINT(1)      NOT NULL DEFAULT 0,
  `ai_message_count`      INT UNSIGNED    NOT NULL DEFAULT 0,
  -- ---- Response-time metrics (drives the analytics dashboard) ---------
  `first_response_at`     DATETIME        NULL,
  `first_response_seconds` INT UNSIGNED   NULL,
  `resolved_at`           DATETIME        NULL,
  `tags`                  JSON            NULL,
  `metadata`              JSON            NULL,
  `created_at`            TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  -- Guarantees a webhook retry can never create a duplicate thread.
  UNIQUE KEY `uq_conversation_external` (`channel_id`, `external_id`),
  KEY `ix_conv_inbox` (`workspace_id`, `status`, `last_message_at`),
  KEY `ix_conv_channel` (`channel_id`, `contact_external_id`),
  KEY `ix_conv_assignee` (`assignee_id`, `status`),
  KEY `ix_conv_unread` (`workspace_id`, `unread_count`),
  CONSTRAINT `fk_conv_workspace` FOREIGN KEY (`workspace_id`)
    REFERENCES `workspaces` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_conv_channel` FOREIGN KEY (`channel_id`)
    REFERENCES `channels` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_conv_assignee` FOREIGN KEY (`assignee_id`)
    REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_conv_faq` FOREIGN KEY (`ai_last_faq_id`)
    REFERENCES `faqs` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
--  7. messages  -  every inbound and outbound text, normalised.
--     `direction` + `sender_type` let the UI render one bubble list for all
--     channels, and let analytics count AI vs human replies.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS `messages` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `workspace_id`    BIGINT UNSIGNED NOT NULL,
  `conversation_id` BIGINT UNSIGNED NOT NULL,
  `channel_id`      BIGINT UNSIGNED NOT NULL,
  -- Remote message id when the channel has one. NULL for our own outbound
  -- messages on channels without ids (website widget uses its own uuid).
  `external_id`     VARCHAR(191)    NULL,
  `direction`       ENUM('inbound','outbound')   NOT NULL,
  `sender_type`     ENUM('contact','agent','ai','system') NOT NULL DEFAULT 'contact',
  `sender_id`       BIGINT UNSIGNED NULL,
  `sender_name`     VARCHAR(191)    NULL,
  `sender_avatar_url` VARCHAR(500)  NULL,
  `body`            TEXT            NOT NULL,
  -- [{ url, name, mimeType, size, width, height }]
  `attachments`     JSON            NULL,
  -- queued | sent | delivered | read | failed
  `status`          ENUM('queued','sent','delivered','read','failed') NOT NULL DEFAULT 'sent',
  `error_message`   VARCHAR(500)    NULL,
  -- 1 when an agent pressed "stop AI" on this thread.
  `is_ai_handover`  TINYINT(1)      NOT NULL DEFAULT 0,
  `intent`          VARCHAR(120)    NULL,
  `sent_at`         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `delivered_at`    DATETIME        NULL,
  `read_at`         DATETIME        NULL,
  `edited_at`       DATETIME        NULL,
  `metadata`        JSON            NULL,
  `created_at`      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  -- Webhook de-duplication: one remote message is stored exactly once.
  UNIQUE KEY `uq_message_external` (`channel_id`, `external_id`),
  KEY `ix_messages_thread` (`conversation_id`, `sent_at`),
  KEY `ix_messages_workspace_time` (`workspace_id`, `sent_at`),
  KEY `ix_messages_direction` (`workspace_id`, `direction`, `sent_at`),
  CONSTRAINT `fk_messages_workspace` FOREIGN KEY (`workspace_id`)
    REFERENCES `workspaces` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_messages_conversation` FOREIGN KEY (`conversation_id`)
    REFERENCES `conversations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_messages_channel` FOREIGN KEY (`channel_id`)
    REFERENCES `channels` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_messages_sender` FOREIGN KEY (`sender_id`)
    REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
--  8. notes  -  internal notes. Never leaves the workspace (no adapter send()).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS `notes` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `workspace_id`    BIGINT UNSIGNED NOT NULL,
  `conversation_id` BIGINT UNSIGNED NOT NULL,
  `user_id`         BIGINT UNSIGNED NULL,
  `body`            TEXT            NOT NULL,
  -- Optional @mention list for "FYI @sara" style notifications.
  `mentions`        JSON            NULL,
  `pinned`          TINYINT(1)      NOT NULL DEFAULT 0,
  `created_at`      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_notes_conversation` (`conversation_id`, `created_at`),
  KEY `ix_notes_workspace` (`workspace_id`, `created_at`),
  CONSTRAINT `fk_notes_workspace` FOREIGN KEY (`workspace_id`)
    REFERENCES `workspaces` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_notes_conversation` FOREIGN KEY (`conversation_id`)
    REFERENCES `conversations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_notes_user` FOREIGN KEY (`user_id`)
    REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
--  9. message_feedback  -  thumbs up/down on AI replies (Part 7 evaluation).
--     Only AI messages are rated, so `sender_type` on messages must be 'ai'.
--     One row per message (the UNIQUE key powers the upsert in the route).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS `message_feedback` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `message_id`      BIGINT UNSIGNED NOT NULL,
  `conversation_id` BIGINT UNSIGNED NOT NULL,
  `workspace_id`    BIGINT UNSIGNED NOT NULL,
  `user_id`         BIGINT UNSIGNED NULL,
  `rating`          ENUM('up','down') NOT NULL,
  `comment`         VARCHAR(500)    NULL,
  `created_at`      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_feedback_message` (`message_id`),
  KEY `ix_feedback_workspace` (`workspace_id`, `rating`),
  CONSTRAINT `fk_feedback_message` FOREIGN KEY (`message_id`)
    REFERENCES `messages` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_feedback_conversation` FOREIGN KEY (`conversation_id`)
    REFERENCES `conversations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_feedback_workspace` FOREIGN KEY (`workspace_id`)
    REFERENCES `workspaces` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_feedback_user` FOREIGN KEY (`user_id`)
    REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
--  10. unanswered_questions  -  what the AI could NOT answer.
--
--      This is the most useful table in the project for the report: it is the
--      evidence that drives "add this to your knowledge base" and shows the
--      assistant's real coverage. Keyed on the question text so the same
--      question asked 40 times is one row with occurrences = 40.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS `unanswered_questions` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `workspace_id`    BIGINT UNSIGNED NOT NULL,
  `question`        VARCHAR(500)    NOT NULL,
  `conversation_id` BIGINT UNSIGNED NULL,
  `channel_id`      BIGINT UNSIGNED NULL,
  `occurrences`     INT UNSIGNED    NOT NULL DEFAULT 1,
  `first_asked_at`  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_asked_at`   DATETIME        NOT NULL,
  PRIMARY KEY (`id`),
  -- The same question must not create a second row.
  UNIQUE KEY `uq_unanswered` (`workspace_id`, `question`(191)),
  KEY `ix_unanswered_recent` (`workspace_id`, `last_asked_at`),
  CONSTRAINT `fk_unanswered_workspace` FOREIGN KEY (`workspace_id`)
    REFERENCES `workspaces` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_unanswered_conversation` FOREIGN KEY (`conversation_id`)
    REFERENCES `conversations` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
--  11. subscriptions  -  one row per workspace (Stripe-backed).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS `subscriptions` (
  `id`                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `workspace_id`           BIGINT UNSIGNED NOT NULL,
  `plan`                   ENUM('free','starter','pro') NOT NULL DEFAULT 'free',
  `status`                 ENUM('trialing','active','past_due','canceled','incomplete','incomplete_expired') NOT NULL DEFAULT 'active',
  `billing_period`         ENUM('monthly','yearly') NOT NULL DEFAULT 'monthly',
  `seats`                  INT UNSIGNED    NOT NULL DEFAULT 3,
  -- Usage counters for plan limits (analytics + billing screens).
  `messages_used`          INT UNSIGNED    NOT NULL DEFAULT 0,
  `messages_limit`         INT UNSIGNED    NOT NULL DEFAULT 100,
  `ai_replies_used`        INT UNSIGNED    NOT NULL DEFAULT 0,
  `ai_replies_limit`       INT UNSIGNED    NOT NULL DEFAULT 50,
  `stripe_customer_id`     VARCHAR(191)    NULL,
  `stripe_subscription_id` VARCHAR(191)    NULL,
  `stripe_price_id`        VARCHAR(191)    NULL,
  `current_period_start`   DATETIME        NULL,
  `current_period_end`     DATETIME        NULL,
  `cancel_at_period_end`   TINYINT(1)      NOT NULL DEFAULT 0,
  `canceled_at`            DATETIME        NULL,
  `created_at`             TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`             TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_subscription_workspace` (`workspace_id`),
  UNIQUE KEY `uq_subscription_stripe` (`stripe_subscription_id`),
  KEY `ix_subscription_status` (`status`),
  CONSTRAINT `fk_subscriptions_workspace` FOREIGN KEY (`workspace_id`)
    REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;

-- ---------------------------------------------------------------------------
--  Convenience views used by the analytics module.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- PLUGIN SYSTEM 3: public customer API + outbound webhooks
-- ===========================================================================
-- A customer creates a scoped API key, calls /api/v1/... with it, and
-- optionally receives signed event deliveries at a URL they control.
-- ===========================================================================

-- API keys. Only the SHA-256 hash is stored, so a database leak cannot be
-- replayed against the API - the plaintext is shown once at creation time.
CREATE TABLE IF NOT EXISTS `api_keys` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `workspace_id`  BIGINT UNSIGNED NOT NULL,
  `name`          VARCHAR(120)    NOT NULL,
  -- Prefix is stored in plaintext purely so a key can be identified in a list
  -- (e.g. "sh_live_a1b2c3...") without revealing the secret half.
  `key_prefix`    VARCHAR(20)     NOT NULL,
  `key_hash`      CHAR(64)        NOT NULL,
  -- JSON array of granted scopes, e.g. ["conversations:read","messages:write"].
  `scopes`        JSON            NOT NULL,
  `last_used_at`  DATETIME        NULL,
  `expires_at`    DATETIME        NULL,
  `revoked_at`    DATETIME        NULL,
  `created_by`    BIGINT UNSIGNED NULL,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_api_keys_hash` (`key_hash`),
  KEY `idx_api_keys_workspace` (`workspace_id`, `revoked_at`),
  CONSTRAINT `fk_api_keys_workspace` FOREIGN KEY (`workspace_id`)
    REFERENCES `workspaces` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_api_keys_creator` FOREIGN KEY (`created_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Customer-owned webhook endpoints. The signing secret is stored encrypted so
-- we can produce a valid HMAC for each delivery without keeping a second copy.
CREATE TABLE IF NOT EXISTS `webhook_endpoints` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `workspace_id`    BIGINT UNSIGNED NOT NULL,
  `url`             VARCHAR(500)    NOT NULL,
  -- JSON array of event names, e.g. ["message.created","conversation.created"].
  `events`          JSON            NOT NULL,
  -- Secret used to sign the delivery body (X-SocialHub-Signature).
  -- Encrypted AES-256-GCM envelope (`v1.<iv>.<tag>.<ciphertext>`), so this must
  -- fit the ciphertext plus all three separators - not a bare 64-char hex key.
  `signing_secret`  VARCHAR(255)   NOT NULL,
  `status`          ENUM('active','disabled') NOT NULL DEFAULT 'active',
  `description`     VARCHAR(200)    NULL,
  -- Consecutive failures; the endpoint auto-disables past a threshold.
  `failure_count`   INT UNSIGNED    NOT NULL DEFAULT 0,
  `last_status`     SMALLINT        NULL,
  `last_attempt_at` DATETIME        NULL,
  `last_success_at` DATETIME        NULL,
  `disabled_reason` VARCHAR(200)    NULL,
  `created_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_webhook_endpoints_workspace` (`workspace_id`, `status`),
  CONSTRAINT `fk_webhook_endpoints_workspace` FOREIGN KEY (`workspace_id`)
    REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per delivery attempt. Kept as an append-only log so a customer can
-- see what was sent, when, and why it failed - and so retries are auditable.
CREATE TABLE IF NOT EXISTS `webhook_deliveries` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `endpoint_id`   BIGINT UNSIGNED NOT NULL,
  `workspace_id`  BIGINT UNSIGNED NOT NULL,
  `event`         VARCHAR(80)     NOT NULL,
  `payload`       JSON            NOT NULL,
  -- Monotonic per-endpoint sequence, so a consumer can detect ordering gaps.
  `sequence`      BIGINT UNSIGNED NOT NULL,
  `status`        ENUM('pending','processing','delivered','failed','exhausted') NOT NULL DEFAULT 'pending',
  -- Set while a worker owns the row. The claim UPDATE is conditional, so two
  -- processes cannot deliver the same event; a crashed worker's row is reclaimed
  -- once this timestamp falls outside the lease.
  `claimed_at`    DATETIME        NULL,
  `attempt`       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `max_attempts`  TINYINT UNSIGNED NOT NULL DEFAULT 5,
  `next_attempt_at` DATETIME      NULL,
  `response_status` SMALLINT      NULL,
  `error`         VARCHAR(500)    NULL,
  `duration_ms`   INT UNSIGNED    NULL,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `delivered_at`  DATETIME        NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_webhook_deliveries_seq` (`endpoint_id`, `sequence`),
  KEY `idx_webhook_deliveries_pending` (`status`, `next_attempt_at`),
  KEY `idx_webhook_deliveries_workspace` (`workspace_id`, `created_at`),
  CONSTRAINT `fk_webhook_deliveries_endpoint` FOREIGN KEY (`endpoint_id`)
    REFERENCES `webhook_endpoints` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_webhook_deliveries_workspace` FOREIGN KEY (`workspace_id`)
    REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-conversation rollup the analytics queries can join against cheaply.
CREATE OR REPLACE VIEW `vw_conversation_metrics` AS
SELECT
  c.`id`                                   AS conversation_id,
  c.`workspace_id`                         AS workspace_id,
  ch.`type`                                AS channel_type,
  c.`status`                               AS status,
  c.`assignee_id`                          AS assignee_id,
  c.`created_at`                           AS created_at,
  c.`last_message_at`                      AS last_message_at,
  c.`first_response_seconds`               AS first_response_seconds,
  c.`ai_handover`                          AS ai_handover,
  c.`ai_resolved`                          AS ai_resolved,
  c.`resolved_at`                          AS resolved_at,
  c.`ai_message_count`                     AS ai_message_count,
  (SELECT COUNT(*) FROM `messages` m
     WHERE m.`conversation_id` = c.`id` AND m.`direction` = 'inbound')  AS inbound_messages,
  (SELECT COUNT(*) FROM `messages` m
     WHERE m.`conversation_id` = c.`id` AND m.`direction` = 'outbound') AS outbound_messages
FROM `conversations` c
JOIN `channels` ch ON ch.`id` = c.`channel_id`;
