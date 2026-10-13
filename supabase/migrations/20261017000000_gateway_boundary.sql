BEGIN;
-- Apply only AFTER production gateway smoke verification. IP enforcement remains monitor.
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM private.gateway_config WHERE signing_key IS NOT NULL) THEN RAISE EXCEPTION 'gateway_key_required'; END IF; END $$;
-- PostgREST may provide a rooted HTTP path. Normalize only the leading slash,
-- and accept exactly the two nonce-consuming POST entry points.
CREATE OR REPLACE FUNCTION public.enforce_gateway_route() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF current_setting('role',true)='service_role' OR NOT (SELECT enabled FROM private.gateway_config WHERE id) THEN RETURN; END IF;
 IF current_setting('request.method',true)<>'POST' OR ltrim(current_setting('request.path',true),'/') NOT IN ('rpc/gateway_read','rpc/gateway_rpc') THEN
  RAISE EXCEPTION 'gateway_required' USING ERRCODE='42501'; END IF;
END $$;
UPDATE private.gateway_config SET enabled=true WHERE id;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['profiles','organizations','partner_details','businesses','service_partners','tickets','activities','ticket_attachments','notifications','role_requests','privacy_consents','system_settings','ip_whitelist','consent_policy_versions'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO anon,authenticated USING ((SELECT private.has_gateway_context())) WITH CHECK ((SELECT private.has_gateway_context()))',t||'_gateway_boundary',t);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('v','m')) THEN
  RAISE EXCEPTION 'exposed_views_require_review';
 END IF;
END $$;
GRANT EXECUTE ON FUNCTION private.has_gateway_context() TO anon,authenticated;
NOTIFY pgrst,'reload config';
CREATE OR REPLACE FUNCTION private.find_valid_request_app_session()
RETURNS private.app_sessions
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_user_id uuid := auth.uid();
    v_hash text;
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_session private.app_sessions%ROWTYPE;
BEGIN
    IF NOT private.has_gateway_context() THEN RETURN NULL; END IF;
    IF v_auth_user_id IS NULL THEN
        RETURN NULL;
    END IF;
    v_hash := private.request_app_session_token_hash();
    IF v_hash IS NULL THEN
        RETURN NULL;
    END IF;
    -- Read-only session check: no row/advisory locks, no writes, no touch.
    SELECT s.* INTO v_session
    FROM private.app_sessions AS s
    JOIN public.profiles AS p ON p.id = s.profile_id
    WHERE s.session_token_hash = v_hash
      AND p.auth_user_id = v_auth_user_id AND s.auth_user_id = v_auth_user_id
      AND p.account_status NOT IN ('suspended', 'disabled')
      AND s.revoked_at IS NULL
      AND pg_catalog.isfinite(s.authenticated_at)
      AND pg_catalog.isfinite(s.expires_at)
      AND pg_catalog.isfinite(s.last_activity_at)
      AND s.authenticated_at <= v_now
      AND s.last_activity_at >= s.authenticated_at
      -- All temporal checks use the same captured evaluation time.
      AND s.last_activity_at <= v_now
      AND v_now < s.expires_at
      AND v_now < s.authenticated_at + interval '8 hours'
      AND v_now < s.last_activity_at + interval '15 minutes';
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    RETURN v_session;
END;
$$;
CREATE OR REPLACE FUNCTION private.require_request_app_session(p_touch boolean)
RETURNS private.app_sessions
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_user_id uuid := auth.uid();
    v_profile public.profiles%ROWTYPE;
    v_session private.app_sessions%ROWTYPE;
    v_hash text;
    v_now timestamptz;
BEGIN
    IF NOT private.has_gateway_context() THEN RAISE EXCEPTION 'gateway_required' USING ERRCODE='42501'; END IF;
    IF v_auth_user_id IS NULL THEN
        RAISE EXCEPTION 'authentication_required' USING ERRCODE = '28000';
    END IF;
    IF p_touch IS NULL THEN
        RAISE EXCEPTION 'invalid_session_guard_input' USING ERRCODE = '22023';
    END IF;
    IF p_touch AND pg_catalog.current_setting('request.method', true) IS DISTINCT FROM 'POST' THEN
        RAISE EXCEPTION 'session_touch_requires_post' USING ERRCODE = '42501';
    END IF;
    v_hash := private.request_app_session_token_hash();
    IF v_hash IS NULL THEN
        RAISE EXCEPTION 'app_session_required' USING ERRCODE = '28000';
    END IF;
    -- Match backend auth/revocation lock order: Profile first, exact Session second.
    -- Admin callers take Step 17's advisory lock BEFORE reaching this guard.
    SELECT p.* INTO v_profile FROM public.profiles AS p
    WHERE p.auth_user_id = v_auth_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'profile_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF v_profile.account_status IN ('suspended', 'disabled') THEN
        RAISE EXCEPTION 'account_unavailable' USING ERRCODE = '42501';
    END IF;
    SELECT s.* INTO v_session FROM private.app_sessions AS s
    WHERE s.session_token_hash = v_hash AND s.profile_id = v_profile.id
      AND s.auth_user_id = v_auth_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'app_session_invalid' USING ERRCODE = '28000';
    END IF;
    v_now := pg_catalog.clock_timestamp();
    IF v_session.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'session_revoked' USING ERRCODE = '28000';
    END IF;
    IF NOT pg_catalog.isfinite(v_session.authenticated_at)
       OR NOT pg_catalog.isfinite(v_session.expires_at)
       OR NOT pg_catalog.isfinite(v_session.last_activity_at)
       OR v_session.authenticated_at > v_now
       OR v_session.last_activity_at < v_session.authenticated_at
       OR v_session.last_activity_at > v_now THEN
        RAISE EXCEPTION 'app_session_invalid' USING ERRCODE = '28000';
    END IF;
    IF v_now >= v_session.expires_at
       OR v_now >= v_session.authenticated_at + interval '8 hours' THEN
        RAISE EXCEPTION 'absolute_expired' USING ERRCODE = '28000';
    END IF;
    IF v_now >= v_session.last_activity_at + interval '15 minutes' THEN
        RAISE EXCEPTION 'idle_expired' USING ERRCODE = '28000';
    END IF;
    IF p_touch THEN
        UPDATE private.app_sessions SET last_activity_at = GREATEST(last_activity_at, v_now)
        WHERE id = v_session.id RETURNING * INTO v_session;
    END IF;
    RETURN v_session;
END;
$$;
CREATE OR REPLACE FUNCTION private.require_consent_profile()
RETURNS public.profiles
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_profile public.profiles%ROWTYPE;
BEGIN
 IF NOT private.has_gateway_context() THEN RAISE EXCEPTION 'gateway_required' USING ERRCODE='42501'; END IF;
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'authentication_required';
    END IF;
    SELECT p.* INTO v_profile FROM public.profiles AS p
    WHERE p.auth_user_id = auth.uid() FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'profile_not_found';
    END IF;
    IF v_profile.account_status IN ('suspended', 'disabled') THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'account_unavailable';
    END IF;
    RETURN v_profile;
END;
$$;
COMMIT;
