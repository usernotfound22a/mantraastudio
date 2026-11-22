CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.current_app_user_id()
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT u.id
  FROM public.users AS u
  WHERE u.auth_user_id = (SELECT auth.uid())
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION private.is_workspace_member(target_workspace_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (SELECT auth.uid()) IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.workspace_members AS m
       JOIN public.users AS u ON u.id = m.user_id
       WHERE m.workspace_id = target_workspace_id
         AND u.auth_user_id = (SELECT auth.uid())
         AND m.status = 'active'
     )
$$;

CREATE OR REPLACE FUNCTION private.has_workspace_role(
  target_workspace_id BIGINT,
  allowed_roles TEXT[]
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (SELECT auth.uid()) IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.workspace_members AS m
       JOIN public.users AS u ON u.id = m.user_id
       WHERE m.workspace_id = target_workspace_id
         AND u.auth_user_id = (SELECT auth.uid())
         AND m.status = 'active'
         AND m.role = ANY(allowed_roles)
     )
$$;

CREATE OR REPLACE FUNCTION private.is_user_in_my_workspace(target_user_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT target_user_id = private.current_app_user_id()
     OR EXISTS (
       SELECT 1
       FROM public.workspace_members AS theirs
       JOIN public.workspace_members AS mine
         ON mine.workspace_id = theirs.workspace_id
       WHERE theirs.user_id = target_user_id
         AND mine.user_id = private.current_app_user_id()
         AND theirs.status = 'active'
         AND mine.status = 'active'
     )
$$;

CREATE OR REPLACE FUNCTION private.api_key_has_scope(
  target_workspace_id BIGINT,
  required_scope TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(
    (SELECT current_setting('request.headers', true)::jsonb ->> 'x-socialhub-api-key-hash'),
    ''
  ) ~ '^[0-9a-f]{64}$'
  AND required_scope = ANY(ARRAY[
    'conversations:read', 'conversations:write', 'messages:read',
    'messages:write', 'contacts:read', 'analytics:read', 'faqs:read', 'faqs:write'
  ])
  AND EXISTS (
    SELECT 1
    FROM public.api_keys AS k
    WHERE k.workspace_id = target_workspace_id
      AND k.key_hash = (
        SELECT current_setting('request.headers', true)::jsonb ->> 'x-socialhub-api-key-hash'
      )
      AND k.revoked_at IS NULL
      AND (k.expires_at IS NULL OR k.expires_at > now())
      AND k.scopes @> jsonb_build_array(required_scope)
  )
$$;

CREATE OR REPLACE FUNCTION private.api_key_can_read_user(target_user_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.api_keys AS k
    JOIN public.workspace_members AS m ON m.workspace_id = k.workspace_id
    WHERE k.key_hash = (
        SELECT current_setting('request.headers', true)::jsonb ->> 'x-socialhub-api-key-hash'
      )
      AND k.revoked_at IS NULL
      AND (k.expires_at IS NULL OR k.expires_at > now())
      AND m.user_id = target_user_id
      AND m.status = 'active'
      AND (
        k.scopes @> '["messages:read"]'::jsonb
        OR k.scopes @> '["conversations:read"]'::jsonb
      )
  )
$$;

REVOKE ALL ON FUNCTION private.current_app_user_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.is_workspace_member(BIGINT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.has_workspace_role(BIGINT, TEXT[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.is_user_in_my_workspace(BIGINT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.api_key_has_scope(BIGINT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.api_key_can_read_user(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.current_app_user_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.is_workspace_member(BIGINT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.has_workspace_role(BIGINT, TEXT[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.is_user_in_my_workspace(BIGINT) TO authenticated, service_role;
GRANT USAGE ON SCHEMA private TO anon;
GRANT EXECUTE ON FUNCTION private.api_key_has_scope(BIGINT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION private.api_key_can_read_user(BIGINT) TO anon;

CREATE OR REPLACE FUNCTION public.bootstrap_workspace(p_full_name TEXT, p_workspace_name TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_auth_user_id UUID := (SELECT auth.uid());
  v_email TEXT := lower((SELECT auth.jwt() ->> 'email'));
  v_user_id BIGINT;
  v_workspace_id BIGINT;
  v_workspace_role TEXT;
  v_workspace_name TEXT;
  v_workspace_slug TEXT;
  v_base_slug TEXT;
  v_slug TEXT;
  v_suffix INTEGER := 1;
BEGIN
  IF v_auth_user_id IS NULL OR v_email IS NULL THEN
    RAISE EXCEPTION 'A verified Supabase Auth user is required' USING ERRCODE = '42501';
  END IF;
  IF length(trim(p_full_name)) NOT BETWEEN 1 AND 120
     OR length(trim(p_workspace_name)) NOT BETWEEN 1 AND 150 THEN
    RAISE EXCEPTION 'Name fields are invalid' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.users (auth_user_id, email, full_name, email_verified_at)
  VALUES (v_auth_user_id, v_email, trim(p_full_name), now())
  ON CONFLICT (auth_user_id) DO UPDATE
    SET full_name = EXCLUDED.full_name
  RETURNING id INTO v_user_id;

  SELECT w.id, w.name, w.slug, m.role
    INTO v_workspace_id, v_workspace_name, v_workspace_slug, v_workspace_role
  FROM public.workspace_members AS m
  JOIN public.workspaces AS w ON w.id = m.workspace_id
  WHERE m.user_id = v_user_id AND m.status = 'active'
  ORDER BY m.id
  LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'workspace',
      jsonb_build_object(
        'id', v_workspace_id,
        'name', v_workspace_name,
        'slug', v_workspace_slug,
        'role', v_workspace_role
      )
    );
  END IF;

  v_base_slug := trim(both '-' FROM regexp_replace(lower(trim(p_workspace_name)), '[^a-z0-9]+', '-', 'g'));
  v_base_slug := left(coalesce(nullif(v_base_slug, ''), 'workspace'), 60);
  v_slug := v_base_slug;
  WHILE EXISTS (SELECT 1 FROM public.workspaces WHERE slug = v_slug) LOOP
    v_suffix := v_suffix + 1;
    v_slug := left(v_base_slug, 60 - length(v_suffix::TEXT) - 1) || '-' || v_suffix::TEXT;
  END LOOP;

  INSERT INTO public.workspaces (name, slug, created_by, support_name)
  VALUES (trim(p_workspace_name), v_slug, v_user_id, trim(p_workspace_name))
  RETURNING id INTO v_workspace_id;

  INSERT INTO public.workspace_members (workspace_id, user_id, role, status, joined_at)
  VALUES (v_workspace_id, v_user_id, 'owner', 'active', now());

  INSERT INTO public.subscriptions
    (workspace_id, plan, status, seats, messages_limit, ai_replies_limit)
  VALUES (v_workspace_id, 'free', 'active', 3, 100, 50);

  RETURN jsonb_build_object(
    'workspace', jsonb_build_object('id', v_workspace_id, 'name', trim(p_workspace_name), 'slug', v_slug, 'role', 'owner')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.increment_subscription_usage(
  p_workspace_id BIGINT,
  p_messages INTEGER DEFAULT 0,
  p_ai_replies INTEGER DEFAULT 0
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_messages < 0 OR p_ai_replies < 0 THEN
    RAISE EXCEPTION 'Usage increments must be non-negative' USING ERRCODE = '22023';
  END IF;
  IF (SELECT auth.uid()) IS NOT NULL
     AND NOT private.is_workspace_member(p_workspace_id) THEN
    RAISE EXCEPTION 'Workspace membership required' USING ERRCODE = '42501';
  END IF;
  IF (SELECT auth.uid()) IS NULL
     AND coalesce((SELECT auth.jwt() ->> 'role'), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Trusted server context required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.subscriptions
  SET messages_used = messages_used + p_messages,
      ai_replies_used = ai_replies_used + p_ai_replies
  WHERE workspace_id = p_workspace_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_faq_match(p_faq_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.faqs f
    WHERE f.id = p_faq_id
      AND ((SELECT auth.uid()) IS NULL
           AND coalesce((SELECT auth.jwt() ->> 'role'), '') = 'service_role'
           OR private.is_workspace_member(f.workspace_id))
  ) THEN
    RAISE EXCEPTION 'FAQ is not accessible' USING ERRCODE = '42501';
  END IF;
  UPDATE public.faqs
  SET match_count = match_count + 1, last_matched_at = now()
  WHERE id = p_faq_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_faq_miss(p_faq_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.faqs f
    WHERE f.id = p_faq_id
      AND ((SELECT auth.uid()) IS NULL
           AND coalesce((SELECT auth.jwt() ->> 'role'), '') = 'service_role'
           OR private.is_workspace_member(f.workspace_id))
  ) THEN
    RAISE EXCEPTION 'FAQ is not accessible' USING ERRCODE = '42501';
  END IF;
  UPDATE public.faqs SET no_match_count = no_match_count + 1 WHERE id = p_faq_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_unanswered_question(
  p_workspace_id BIGINT,
  p_question TEXT,
  p_conversation_id BIGINT DEFAULT NULL,
  p_channel_id BIGINT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF (SELECT auth.uid()) IS NOT NULL
     AND NOT private.is_workspace_member(p_workspace_id) THEN
    RAISE EXCEPTION 'Workspace membership required' USING ERRCODE = '42501';
  END IF;
  IF (SELECT auth.uid()) IS NULL
     AND coalesce((SELECT auth.jwt() ->> 'role'), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Trusted server context required' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.unanswered_questions
    (workspace_id, question, conversation_id, channel_id, last_asked_at)
  VALUES (p_workspace_id, left(p_question, 500), p_conversation_id, p_channel_id, now())
  ON CONFLICT (workspace_id, question) DO UPDATE
    SET occurrences = public.unanswered_questions.occurrences + 1,
        last_asked_at = now(),
        conversation_id = coalesce(EXCLUDED.conversation_id, public.unanswered_questions.conversation_id),
        channel_id = coalesce(EXCLUDED.channel_id, public.unanswered_questions.channel_id);
END;
$$;

REVOKE ALL ON FUNCTION public.bootstrap_workspace(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.increment_subscription_usage(BIGINT, INTEGER, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_faq_match(BIGINT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_faq_miss(BIGINT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_unanswered_question(BIGINT, TEXT, BIGINT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bootstrap_workspace(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.increment_subscription_usage(BIGINT, INTEGER, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_faq_match(BIGINT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_faq_miss(BIGINT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_unanswered_question(BIGINT, TEXT, BIGINT, BIGINT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.join_workspace(p_slug TEXT, p_invite_code TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id BIGINT := private.current_app_user_id();
  v_workspace public.workspaces%ROWTYPE;
  v_member public.workspace_members%ROWTYPE;
BEGIN
  IF (SELECT auth.uid()) IS NULL OR v_user_id IS NULL THEN
    RAISE EXCEPTION 'A SocialHub account is required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_workspace FROM public.workspaces WHERE slug = p_slug;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No workspace with that link' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_member FROM public.workspace_members
    WHERE workspace_id = v_workspace.id AND user_id = v_user_id;
  IF FOUND AND v_member.status = 'active' THEN
    RAISE EXCEPTION 'You are already a member of this workspace' USING ERRCODE = '23505';
  ELSIF FOUND THEN
    UPDATE public.workspace_members
      SET status = 'active', joined_at = now()
      WHERE id = v_member.id;
  ELSE
    INSERT INTO public.workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES (v_workspace.id, v_user_id, 'agent', 'active', now());
  END IF;
  RETURN to_jsonb(v_workspace) || jsonb_build_object('role', 'agent');
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_api_key(p_key_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF p_key_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;
  UPDATE public.api_keys AS k
  SET last_used_at = now()
  FROM public.workspaces AS w
  WHERE k.workspace_id = w.id
    AND k.key_hash = p_key_hash
    AND k.revoked_at IS NULL
    AND (k.expires_at IS NULL OR k.expires_at > now())
  RETURNING jsonb_build_object(
    'id', k.id,
    'workspace_id', k.workspace_id,
    'workspace_name', w.name,
    'scopes', k.scopes
  ) INTO v_result;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.lookup_widget_channel(p_widget_key TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'id', c.id,
    'workspace_id', c.workspace_id,
    'type', c.type,
    'name', c.name,
    'status', c.status,
    'config', jsonb_strip_nulls(jsonb_build_object(
      'widgetKey', c.config -> 'widgetKey',
      'allowedDomains', c.config -> 'allowedDomains',
      'companyName', c.config -> 'companyName',
      'greeting', c.config -> 'greeting',
      'themeColor', c.config -> 'themeColor',
      'placeholder', c.config -> 'placeholder',
      'requireName', c.config -> 'requireName',
      'collectEmail', c.config -> 'collectEmail',
      'aiEnabled', c.config -> 'aiEnabled'
    ))
  )
  FROM public.channels AS c
  WHERE c.type = 'website'
    AND c.status = 'connected'
    AND c.config ->> 'widgetKey' = p_widget_key
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.poll_widget_messages(
  p_widget_key TEXT,
  p_visitor_id TEXT,
  p_after_id BIGINT DEFAULT 0
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(message_row) ORDER BY message_row.id), '[]'::jsonb)
  FROM (
    SELECT m.id, m.workspace_id, m.conversation_id, m.channel_id, m.external_id,
           m.direction, m.sender_type, m.sender_id, m.sender_name, m.body, m.attachments,
           m.status, m.sent_at, m.delivered_at, m.read_at, m.edited_at, m.metadata,
           m.created_at, m.updated_at, u.full_name AS sender_display_name,
           u.avatar_url AS sender_display_avatar
    FROM public.messages AS m
    JOIN public.conversations AS c ON c.id = m.conversation_id
    JOIN public.channels AS ch ON ch.id = c.channel_id
    LEFT JOIN public.users AS u ON u.id = m.sender_id
    WHERE ch.type = 'website'
      AND ch.config ->> 'widgetKey' = p_widget_key
      AND c.external_id = p_visitor_id
      AND m.id > coalesce(p_after_id, 0)
    ORDER BY m.id ASC
    LIMIT 100
  ) AS message_row
$$;

REVOKE ALL ON FUNCTION public.join_workspace(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.resolve_api_key(TEXT) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.lookup_widget_channel(TEXT) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.poll_widget_messages(TEXT, TEXT, BIGINT) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.join_workspace(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_api_key(TEXT) TO anon, service_role;
GRANT EXECUTE ON FUNCTION public.lookup_widget_channel(TEXT) TO anon, service_role;
GRANT EXECUTE ON FUNCTION public.poll_widget_messages(TEXT, TEXT, BIGINT) TO anon, service_role;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.faqs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unanswered_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.users, public.workspaces, public.workspace_members, public.faqs,
  public.channels, public.social_accounts, public.conversations, public.messages,
  public.notes, public.message_feedback, public.unanswered_questions,
  public.subscriptions, public.api_keys, public.webhook_endpoints, public.webhook_deliveries
TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
REVOKE ALL ON public.system_settings FROM anon, authenticated;

DO $$
DECLARE
  policy_row RECORD;
BEGIN
  FOR policy_row IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname IN (
        'users_select_related', 'users_update_self', 'users_select_api_key_sender',
        'workspaces_select_member', 'workspaces_update_admin', 'workspaces_delete_owner',
        'workspace_members_select_member', 'workspace_members_insert_admin',
        'workspace_members_update_admin', 'workspace_members_delete_admin',
        'workspace_members_select_api_key', 'faqs_select_member', 'faqs_mutate_admin',
        'faqs_select_api_key', 'channels_select_member', 'channels_mutate_admin',
        'channels_select_api_key', 'social_accounts_select_member',
        'social_accounts_mutate_admin', 'conversations_member_access',
        'conversations_select_api_key', 'conversations_update_api_key',
        'messages_member_access', 'messages_select_api_key', 'messages_insert_api_key',
        'notes_member_access', 'message_feedback_member_access',
        'unanswered_questions_member_access', 'subscriptions_select_member',
        'subscriptions_mutate_admin', 'api_keys_select_admin', 'api_keys_mutate_admin',
        'webhook_endpoints_admin_access', 'webhook_deliveries_select_member',
        'system_settings_deny_client_access'
      )
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', policy_row.policyname, policy_row.schemaname, policy_row.tablename);
  END LOOP;
END $$;

CREATE POLICY users_select_related ON public.users
  FOR SELECT TO authenticated
  USING (private.is_user_in_my_workspace(id));
CREATE POLICY users_update_self ON public.users
  FOR UPDATE TO authenticated
  USING (id = private.current_app_user_id())
  WITH CHECK (id = private.current_app_user_id());
CREATE POLICY users_select_api_key_sender ON public.users
  FOR SELECT TO anon USING (private.api_key_can_read_user(id));

CREATE POLICY workspaces_select_member ON public.workspaces
  FOR SELECT TO authenticated
  USING (private.is_workspace_member(id));
CREATE POLICY workspaces_update_admin ON public.workspaces
  FOR UPDATE TO authenticated
  USING (private.has_workspace_role(id, ARRAY['owner','admin']))
  WITH CHECK (private.has_workspace_role(id, ARRAY['owner','admin']));
CREATE POLICY workspaces_delete_owner ON public.workspaces
  FOR DELETE TO authenticated
  USING (private.has_workspace_role(id, ARRAY['owner']));

CREATE POLICY workspace_members_select_member ON public.workspace_members
  FOR SELECT TO authenticated
  USING (private.is_workspace_member(workspace_id) OR user_id = private.current_app_user_id());
CREATE POLICY workspace_members_insert_admin ON public.workspace_members
  FOR INSERT TO authenticated
  WITH CHECK (private.has_workspace_role(workspace_id, ARRAY['owner','admin']));
CREATE POLICY workspace_members_update_admin ON public.workspace_members
  FOR UPDATE TO authenticated
  USING (private.has_workspace_role(workspace_id, ARRAY['owner','admin']))
  WITH CHECK (private.has_workspace_role(workspace_id, ARRAY['owner','admin']));
CREATE POLICY workspace_members_delete_admin ON public.workspace_members
  FOR DELETE TO authenticated
  USING (private.has_workspace_role(workspace_id, ARRAY['owner','admin']));
CREATE POLICY workspace_members_select_api_key ON public.workspace_members
  FOR SELECT TO anon USING (private.api_key_has_scope(workspace_id, 'conversations:write'));

CREATE POLICY faqs_select_member ON public.faqs
  FOR SELECT TO authenticated USING (private.is_workspace_member(workspace_id));
CREATE POLICY faqs_mutate_admin ON public.faqs
  FOR ALL TO authenticated
  USING (private.has_workspace_role(workspace_id, ARRAY['owner','admin']))
  WITH CHECK (private.has_workspace_role(workspace_id, ARRAY['owner','admin']));
CREATE POLICY faqs_select_api_key ON public.faqs
  FOR SELECT TO anon USING (private.api_key_has_scope(workspace_id, 'faqs:read'));

CREATE POLICY channels_select_member ON public.channels
  FOR SELECT TO authenticated USING (private.is_workspace_member(workspace_id));
CREATE POLICY channels_mutate_admin ON public.channels
  FOR ALL TO authenticated
  USING (private.has_workspace_role(workspace_id, ARRAY['owner','admin']))
  WITH CHECK (private.has_workspace_role(workspace_id, ARRAY['owner','admin']));
CREATE POLICY channels_select_api_key ON public.channels
  FOR SELECT TO anon USING (
    private.api_key_has_scope(workspace_id, 'conversations:read')
    OR private.api_key_has_scope(workspace_id, 'messages:write')
  );

CREATE POLICY social_accounts_select_member ON public.social_accounts
  FOR SELECT TO authenticated USING (private.is_workspace_member(workspace_id));
CREATE POLICY social_accounts_mutate_admin ON public.social_accounts
  FOR ALL TO authenticated
  USING (private.has_workspace_role(workspace_id, ARRAY['owner','admin']))
  WITH CHECK (private.has_workspace_role(workspace_id, ARRAY['owner','admin']));

CREATE POLICY conversations_member_access ON public.conversations
  FOR ALL TO authenticated
  USING (private.is_workspace_member(workspace_id))
  WITH CHECK (private.is_workspace_member(workspace_id));
CREATE POLICY conversations_select_api_key ON public.conversations
  FOR SELECT TO anon USING (
    private.api_key_has_scope(workspace_id, 'conversations:read')
    OR private.api_key_has_scope(workspace_id, 'messages:read')
    OR private.api_key_has_scope(workspace_id, 'messages:write')
    OR private.api_key_has_scope(workspace_id, 'analytics:read')
  );
CREATE POLICY conversations_update_api_key ON public.conversations
  FOR UPDATE TO anon
  USING (private.api_key_has_scope(workspace_id, 'conversations:write'))
  WITH CHECK (private.api_key_has_scope(workspace_id, 'conversations:write'));
CREATE POLICY messages_member_access ON public.messages
  FOR ALL TO authenticated
  USING (private.is_workspace_member(workspace_id))
  WITH CHECK (private.is_workspace_member(workspace_id));
CREATE POLICY messages_select_api_key ON public.messages
  FOR SELECT TO anon USING (private.api_key_has_scope(workspace_id, 'messages:read'));
CREATE POLICY messages_insert_api_key ON public.messages
  FOR INSERT TO anon
  WITH CHECK (
    private.api_key_has_scope(workspace_id, 'messages:write')
    AND EXISTS (
      SELECT 1 FROM public.conversations AS c
      WHERE c.id = conversation_id
        AND c.workspace_id = messages.workspace_id
        AND c.channel_id = messages.channel_id
    )
  );
CREATE POLICY notes_member_access ON public.notes
  FOR ALL TO authenticated
  USING (private.is_workspace_member(workspace_id))
  WITH CHECK (private.is_workspace_member(workspace_id));
CREATE POLICY message_feedback_member_access ON public.message_feedback
  FOR ALL TO authenticated
  USING (private.is_workspace_member(workspace_id))
  WITH CHECK (private.is_workspace_member(workspace_id));
CREATE POLICY unanswered_questions_member_access ON public.unanswered_questions
  FOR ALL TO authenticated
  USING (private.is_workspace_member(workspace_id))
  WITH CHECK (private.is_workspace_member(workspace_id));

CREATE POLICY subscriptions_select_member ON public.subscriptions
  FOR SELECT TO authenticated USING (private.is_workspace_member(workspace_id));
CREATE POLICY subscriptions_mutate_admin ON public.subscriptions
  FOR ALL TO authenticated
  USING (private.has_workspace_role(workspace_id, ARRAY['owner','admin']))
  WITH CHECK (private.has_workspace_role(workspace_id, ARRAY['owner','admin']));

CREATE POLICY api_keys_select_admin ON public.api_keys
  FOR SELECT TO authenticated USING (private.has_workspace_role(workspace_id, ARRAY['owner','admin']));
CREATE POLICY api_keys_mutate_admin ON public.api_keys
  FOR ALL TO authenticated
  USING (private.has_workspace_role(workspace_id, ARRAY['owner','admin']))
  WITH CHECK (private.has_workspace_role(workspace_id, ARRAY['owner','admin']));

CREATE POLICY webhook_endpoints_admin_access ON public.webhook_endpoints
  FOR ALL TO authenticated
  USING (private.has_workspace_role(workspace_id, ARRAY['owner','admin']))
  WITH CHECK (private.has_workspace_role(workspace_id, ARRAY['owner','admin']));
CREATE POLICY webhook_deliveries_select_member ON public.webhook_deliveries
  FOR SELECT TO authenticated USING (private.is_workspace_member(workspace_id));

CREATE OR REPLACE VIEW public.vw_conversation_metrics
WITH (security_invoker = true)
AS
SELECT
  c.id AS conversation_id,
  c.workspace_id,
  ch.type AS channel_type,
  c.status,
  c.assignee_id,
  c.created_at,
  c.last_message_at,
  c.first_response_seconds,
  c.ai_handover,
  c.ai_resolved,
  c.resolved_at,
  c.ai_message_count,
  (SELECT count(*) FROM public.messages AS m WHERE m.conversation_id = c.id AND m.direction = 'inbound') AS inbound_messages,
  (SELECT count(*) FROM public.messages AS m WHERE m.conversation_id = c.id AND m.direction = 'outbound') AS outbound_messages
FROM public.conversations AS c
JOIN public.channels AS ch ON ch.id = c.channel_id;

CREATE OR REPLACE FUNCTION public.record_inbound_message(
  p_workspace_id BIGINT,
  p_conversation_id BIGINT,
  p_channel_id BIGINT,
  p_external_id TEXT,
  p_sender_name TEXT,
  p_body TEXT,
  p_attachments JSONB,
  p_sent_at TIMESTAMPTZ,
  p_metadata JSONB,
  p_widget_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_message public.messages%ROWTYPE;
  v_allowed BOOLEAN := FALSE;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.channels AS ch
    WHERE ch.id = p_channel_id
      AND ch.workspace_id = p_workspace_id
      AND ch.status IN ('active', 'connected')
      AND EXISTS (
        SELECT 1 FROM public.conversations AS c
        WHERE c.id = p_conversation_id
          AND c.workspace_id = p_workspace_id
          AND c.channel_id = p_channel_id
      )
      AND (
        coalesce((SELECT auth.jwt() ->> 'role'), '') = 'service_role'
        OR (p_widget_key IS NOT NULL AND ch.config ->> 'widgetKey' = p_widget_key)
        OR ((SELECT auth.uid()) IS NOT NULL AND private.is_workspace_member(p_workspace_id))
      )
  ) INTO v_allowed;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Inbound message is not authorized' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.messages (
    workspace_id, conversation_id, channel_id, external_id, direction,
    sender_type, sender_name, body, attachments, sent_at, metadata
  )
  VALUES (
    p_workspace_id, p_conversation_id, p_channel_id, p_external_id, 'inbound',
    'contact', left(p_sender_name, 191), left(p_body, 20000), p_attachments,
    coalesce(p_sent_at, now()), p_metadata
  )
  ON CONFLICT (channel_id, external_id) DO NOTHING
  RETURNING * INTO v_message;

  IF v_message.id IS NULL AND p_external_id IS NOT NULL THEN
    SELECT * INTO v_message
    FROM public.messages AS m
    WHERE m.channel_id = p_channel_id AND m.external_id = p_external_id
    LIMIT 1;
    RETURN jsonb_build_object('duplicate', TRUE, 'message', to_jsonb(v_message));
  END IF;

  UPDATE public.conversations
  SET last_message_at = v_message.sent_at,
      last_message_preview = left(v_message.body, 255),
      last_message_direction = 'inbound',
      unread_count = unread_count + 1
  WHERE id = p_conversation_id AND workspace_id = p_workspace_id AND channel_id = p_channel_id;

  RETURN jsonb_build_object('duplicate', FALSE, 'message', to_jsonb(v_message));
END;
$$;

CREATE OR REPLACE FUNCTION public.increment_conversation_ai_messages(
  p_conversation_id BIGINT,
  p_increment INTEGER DEFAULT 1
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_workspace_id BIGINT;
BEGIN
  IF p_increment < 0 OR p_increment > 100 THEN
    RAISE EXCEPTION 'Invalid AI message increment' USING ERRCODE = '22023';
  END IF;
  SELECT workspace_id INTO v_workspace_id
  FROM public.conversations
  WHERE id = p_conversation_id;
  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'Conversation not found' USING ERRCODE = 'P0002';
  END IF;
  IF coalesce((SELECT auth.jwt() ->> 'role'), '') <> 'service_role'
     AND NOT private.is_workspace_member(v_workspace_id) THEN
    RAISE EXCEPTION 'Workspace membership required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.conversations
  SET ai_message_count = ai_message_count + p_increment
  WHERE id = p_conversation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_inbound_message(BIGINT, BIGINT, BIGINT, TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ, JSONB, TEXT) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.increment_conversation_ai_messages(BIGINT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_inbound_message(BIGINT, BIGINT, BIGINT, TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ, JSONB, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.increment_conversation_ai_messages(BIGINT, INTEGER) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.save_meta_settings(
  p_workspace_id BIGINT,
  p_app_id_encrypted TEXT,
  p_app_secret_encrypted TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id BIGINT := private.current_app_user_id();
BEGIN
  IF v_user_id IS NULL OR NOT private.has_workspace_role(p_workspace_id, ARRAY['owner','admin']) THEN
    RAISE EXCEPTION 'Workspace administrator required' USING ERRCODE = '42501';
  END IF;
  IF length(p_app_id_encrypted) > 2000 OR length(p_app_secret_encrypted) > 4000 THEN
    RAISE EXCEPTION 'Encrypted Meta setting exceeds the maximum length' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.system_settings (setting_key, setting_value, updated_by)
  VALUES
    ('meta_app_id', p_app_id_encrypted, v_user_id),
    ('meta_app_secret', p_app_secret_encrypted, v_user_id)
  ON CONFLICT (setting_key) DO UPDATE
    SET setting_value = EXCLUDED.setting_value,
        updated_by = EXCLUDED.updated_by,
        updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.save_meta_settings(BIGINT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_meta_settings(BIGINT, TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.queue_webhook_event(
  p_workspace_id BIGINT,
  p_event TEXT,
  p_payload JSONB,
  p_max_attempts INTEGER DEFAULT 5
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_endpoint public.webhook_endpoints%ROWTYPE;
  v_sequence BIGINT;
  v_queued INTEGER := 0;
BEGIN
  IF p_max_attempts NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'Invalid maximum webhook attempts' USING ERRCODE = '22023';
  END IF;
  IF coalesce((SELECT auth.jwt() ->> 'role'), '') <> 'service_role'
     AND NOT private.is_workspace_member(p_workspace_id)
     AND NOT private.api_key_has_scope(p_workspace_id, 'messages:write')
     AND NOT private.api_key_has_scope(p_workspace_id, 'conversations:write') THEN
    RAISE EXCEPTION 'Workspace membership required' USING ERRCODE = '42501';
  END IF;
  FOR v_endpoint IN
    SELECT * FROM public.webhook_endpoints AS endpoint
    WHERE endpoint.workspace_id = p_workspace_id
      AND endpoint.status = 'active'
      AND endpoint.events @> jsonb_build_array(p_event)
    FOR UPDATE
  LOOP
    SELECT coalesce(max(sequence), 0) + 1 INTO v_sequence
    FROM public.webhook_deliveries
    WHERE endpoint_id = v_endpoint.id;
    INSERT INTO public.webhook_deliveries (
      endpoint_id, workspace_id, event, payload, sequence, status,
      attempt, max_attempts, next_attempt_at
    )
    VALUES (
      v_endpoint.id, p_workspace_id, p_event,
      jsonb_build_object('event', p_event, 'createdAt', now(), 'data', p_payload),
      v_sequence, 'pending', 0, p_max_attempts, now()
    );
    v_queued := v_queued + 1;
  END LOOP;
  RETURN v_queued;
END;
$$;

REVOKE ALL ON FUNCTION public.queue_webhook_event(BIGINT, TEXT, JSONB, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.queue_webhook_event(BIGINT, TEXT, JSONB, INTEGER) TO authenticated, service_role;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;
GRANT SELECT ON public.conversations, public.channels, public.messages, public.users,
  public.workspace_members, public.faqs TO anon;
GRANT UPDATE ON public.conversations TO anon;
GRANT INSERT ON public.messages TO anon;
GRANT SELECT ON public.vw_conversation_metrics TO authenticated, service_role;
REVOKE ALL ON public.system_settings FROM anon, authenticated;
CREATE POLICY system_settings_deny_client_access ON public.system_settings
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role;
