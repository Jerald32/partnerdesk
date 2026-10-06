BEGIN;

-- Data API boundary only. No IP enforcement, attachment activation or Realtime/Storage.
-- Preserve the MFA-disabled issuance exception: possession of a valid app session,
-- not mfa_verified_at, is the additional credential required by this boundary.
CREATE FUNCTION private.request_app_session_token_hash()
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_headers jsonb;
    v_token text;
BEGIN
    v_headers := COALESCE(NULLIF(pg_catalog.current_setting('request.headers', true), ''), '{}')::jsonb;
    IF pg_catalog.jsonb_typeof(v_headers) IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(v_headers -> 'x-partnerdesk-session') IS DISTINCT FROM 'string' THEN
        RETURN NULL;
    END IF;
    v_token := v_headers ->> 'x-partnerdesk-session';
    IF v_token IS NULL OR v_token !~ '^[0-9a-f]{64}$' THEN
        RETURN NULL;
    END IF;
    -- Exact compatibility with app-auth sessionHash: hash decoded random bytes,
    -- not their hexadecimal text. Never return or log the raw token.
    RETURN pg_catalog.encode(pg_catalog.sha256(pg_catalog.decode(v_token, 'hex')), 'hex');
EXCEPTION
    WHEN invalid_text_representation OR invalid_parameter_value THEN
        RETURN NULL;
END;
$$;

CREATE FUNCTION private.find_valid_request_app_session()
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

CREATE FUNCTION public.has_valid_app_session()
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_session private.app_sessions%ROWTYPE;
BEGIN
    v_session := private.find_valid_request_app_session();
    RETURN v_session.id IS NOT NULL;
END;
$$;

CREATE FUNCTION private.require_request_app_session(p_touch boolean)
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

-- No parameters: caller cannot select an actor, Profile, Session, timestamp or touch flag.
-- Frontend integration must call this only for user activity, with throttling;
-- never for polling. Browser assertions cannot prove that activity was human.
CREATE FUNCTION public.touch_app_session()
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_session private.app_sessions%ROWTYPE;
BEGIN
    v_session := private.require_request_app_session(true);
    RETURN pg_catalog.jsonb_build_object('session_id', v_session.id,
        'last_activity_at', v_session.last_activity_at, 'expires_at', v_session.expires_at);
END;
$$;

-- Restrictive SELECT gates AND with existing permissive role/organization policies.
-- SELECT failures yield no visible rows; RPC guards raise explicit session errors.

CREATE POLICY profiles_select_app_session_gate ON public.profiles
    AS RESTRICTIVE FOR SELECT TO authenticated
    USING ((SELECT public.has_valid_app_session()));

CREATE POLICY organizations_select_app_session_gate ON public.organizations
    AS RESTRICTIVE FOR SELECT TO authenticated
    USING ((SELECT public.has_valid_app_session()));

CREATE POLICY partner_details_select_app_session_gate ON public.partner_details
    AS RESTRICTIVE FOR SELECT TO authenticated
    USING ((SELECT public.has_valid_app_session()));

CREATE POLICY businesses_select_app_session_gate ON public.businesses
    AS RESTRICTIVE FOR SELECT TO authenticated
    USING ((SELECT public.has_valid_app_session()));

CREATE POLICY service_partners_select_app_session_gate ON public.service_partners
    AS RESTRICTIVE FOR SELECT TO authenticated
    USING ((SELECT public.has_valid_app_session()));

CREATE POLICY tickets_select_app_session_gate ON public.tickets
    AS RESTRICTIVE FOR SELECT TO authenticated
    USING ((SELECT public.has_valid_app_session()));

CREATE POLICY activities_select_app_session_gate ON public.activities
    AS RESTRICTIVE FOR SELECT TO authenticated
    USING ((SELECT public.has_valid_app_session()));

CREATE POLICY notifications_select_app_session_gate ON public.notifications
    AS RESTRICTIVE FOR SELECT TO authenticated
    USING ((SELECT public.has_valid_app_session()));

CREATE POLICY role_requests_select_app_session_gate ON public.role_requests
    AS RESTRICTIVE FOR SELECT TO authenticated
    USING ((SELECT public.has_valid_app_session()));

CREATE POLICY privacy_consents_select_app_session_gate ON public.privacy_consents
    AS RESTRICTIVE FOR SELECT TO authenticated
    USING ((SELECT public.has_valid_app_session()));

CREATE POLICY system_settings_select_app_session_gate ON public.system_settings
    AS RESTRICTIVE FOR SELECT TO authenticated
    USING ((SELECT public.has_valid_app_session()));

CREATE POLICY ip_whitelist_select_app_session_gate ON public.ip_whitelist
    AS RESTRICTIVE FOR SELECT TO authenticated
    USING ((SELECT public.has_valid_app_session()));

CREATE POLICY ticket_attachments_select_app_session_gate ON public.ticket_attachments
    AS RESTRICTIVE FOR SELECT TO authenticated
    USING ((SELECT public.has_valid_app_session()));

CREATE OR REPLACE FUNCTION public.current_profile_id()
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT p.id FROM public.profiles AS p WHERE p.auth_user_id = auth.uid() AND public.has_valid_app_session();
$$;

CREATE OR REPLACE FUNCTION public.current_profile_role()
RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT p.role FROM public.profiles AS p WHERE p.auth_user_id = auth.uid() AND public.has_valid_app_session();
$$;

CREATE OR REPLACE FUNCTION public.current_organization_id()
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT p.organization_id FROM public.profiles AS p WHERE p.auth_user_id = auth.uid() AND public.has_valid_app_session();
$$;

CREATE OR REPLACE FUNCTION public.can_access_business(p_business_id uuid)
RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.profiles AS p
        WHERE p.auth_user_id = auth.uid()
          AND public.has_valid_app_session()
          AND (
              p.role IN ('admin', 'operator')
              OR (
                  p.role = 'partner_admin'
                  AND EXISTS (
                      SELECT 1 FROM public.service_partners AS sp
                      WHERE sp.business_id = p_business_id
                        AND sp.partner_organization_id = p.organization_id
                  )
              )
          )
    );
$$;

CREATE OR REPLACE FUNCTION public.can_access_ticket(p_ticket_id uuid)
RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.profiles AS p
        JOIN public.tickets AS t ON t.id = p_ticket_id
        WHERE p.auth_user_id = auth.uid()
          AND public.has_valid_app_session()
          AND (
              p.role IN ('admin', 'operator')
              OR (
                  p.role = 'partner_admin'
                  AND EXISTS (
                      SELECT 1 FROM public.service_partners AS sp
                      WHERE sp.business_id = t.business_id
                        AND sp.partner_organization_id = p.organization_id
                        AND (
                            sp.access_level = 'business'
                            OR t.assigned_partner_organization_id = p.organization_id
                        )
                  )
              )
          )
    );
$$;

-- Shared actor guard: admin advisory lock remains in require_user_role_admin,
-- acquired before this helper takes Profile/Session locks. Failed work rolls back touch.

CREATE OR REPLACE FUNCTION private.require_management_actor(p_allowed_roles text[])
RETURNS public.profiles
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_user_id uuid := auth.uid();
    v_actor public.profiles%ROWTYPE;
BEGIN
    IF v_auth_user_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'authentication_required';
    END IF;
    PERFORM private.require_request_app_session(true);
    SELECT p.* INTO v_actor FROM public.profiles AS p
    WHERE p.auth_user_id = v_auth_user_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'profile_not_found';
    END IF;
    IF (v_actor.role = ANY(p_allowed_roles)) IS DISTINCT FROM true THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'role_not_allowed';
    END IF;
    IF v_actor.account_status IN ('suspended', 'disabled') THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'account_unavailable';
    END IF;
    RETURN v_actor;
END;
$$;

-- Consent status polling remains no-touch; record_privacy_consent touches explicitly.

CREATE OR REPLACE FUNCTION private.require_consent_profile()
RETURNS public.profiles
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_profile public.profiles%ROWTYPE;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'authentication_required';
    END IF;
    PERFORM private.require_request_app_session(false);
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

CREATE OR REPLACE FUNCTION public.create_ticket(
    p_business_id uuid,
    p_title text DEFAULT NULL,
    p_description text DEFAULT NULL,
    p_request_type text DEFAULT NULL,
    p_request_detail text DEFAULT NULL,
    p_priority text DEFAULT 'normal',
    p_customer_name text DEFAULT NULL,
    p_customer_company text DEFAULT NULL,
    p_customer_contact text DEFAULT NULL,
    p_address text DEFAULT NULL,
    p_address_detail text DEFAULT NULL,
    p_assigned_partner_organization_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_user_id uuid := auth.uid();
    v_actor public.profiles%ROWTYPE;
    v_ticket public.tickets%ROWTYPE;
    v_partner_id uuid;
    v_title text;
    v_now timestamptz;
    v_count bigint;
BEGIN
    IF v_auth_user_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'authentication_required';
    END IF;

    -- Serialize creates for this Profile, including concurrent requests.
    PERFORM private.require_request_app_session(true);
    SELECT p.* INTO v_actor FROM public.profiles AS p
    WHERE p.auth_user_id = v_auth_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'profile_not_found';
    END IF;
    IF v_actor.role NOT IN ('admin', 'operator', 'partner_admin') THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'role_not_allowed';
    END IF;
    IF v_actor.account_status IN ('suspended', 'disabled') THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'account_unavailable';
    END IF;

    PERFORM 1 FROM public.businesses AS b WHERE b.id = p_business_id FOR KEY SHARE;
    IF NOT FOUND OR NOT public.can_access_business(p_business_id) THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'business_not_found_or_forbidden';
    END IF;

    v_partner_id := p_assigned_partner_organization_id;
    IF v_actor.role = 'partner_admin' THEN
        IF v_partner_id IS NOT NULL AND v_partner_id <> v_actor.organization_id THEN
            RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'partner_assignment_forbidden';
        END IF;
        v_partner_id := v_actor.organization_id;
    END IF;
    IF v_partner_id IS NOT NULL THEN
        PERFORM 1 FROM public.service_partners AS sp
        WHERE sp.business_id = p_business_id
          AND sp.partner_organization_id = v_partner_id FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'business_partner_relation_required';
        END IF;
    END IF;

    IF p_priority IS NULL OR p_priority NOT IN ('low', 'normal', 'high', 'urgent') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_priority';
    END IF;
    IF p_request_type IS NOT NULL AND p_request_type NOT IN (
        '장애/고장', '설치 요청', '점검/유지보수', '교체 요청',
        '소프트웨어 오류', '네트워크 문제', '이전/철거', '기타'
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_request_type';
    END IF;
    IF pg_catalog.char_length(p_address) > 200 OR pg_catalog.char_length(p_address_detail) > 200 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'address_too_long';
    END IF;

    -- Preserve the UI's title fallback and 100-character display title.
    v_title := pg_catalog.left(COALESCE(
        NULLIF(pg_catalog.btrim(p_title), ''),
        NULLIF(pg_catalog.btrim(p_request_detail), ''),
        p_request_type, '티켓'
    ), 100);

    -- Use wall-clock time after waiting for the Profile lock.
    v_now := pg_catalog.clock_timestamp();
    SELECT pg_catalog.count(*) INTO v_count FROM public.tickets AS t
    WHERE t.created_by_profile_id = v_actor.id
      AND t.created_at >= v_now - INTERVAL '1 minute';
    IF v_count >= 5 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ticket_create_rate_limit_exceeded';
    END IF;

    INSERT INTO public.tickets (
        business_id, title, description, request_type, request_detail, priority,
        customer_name, customer_company, customer_contact, address, address_detail,
        assigned_partner_organization_id, created_by_profile_id, created_at, updated_at
    ) VALUES (
        p_business_id, v_title, p_description, p_request_type, p_request_detail, p_priority,
        p_customer_name, p_customer_company, p_customer_contact, p_address, p_address_detail,
        v_partner_id, v_actor.id, v_now, v_now
    ) RETURNING * INTO v_ticket;

    -- Audit append: same transaction; errors propagate.
    PERFORM audit.append_access_log(
        p_action => '티켓 생성',
        p_target_type => 'Ticket',
        p_target_id => v_ticket.id::text,
        p_subject_info => NULL,
        p_detail => '티켓 생성 완료',
        p_metadata => pg_catalog.jsonb_build_object(
            'ticket_id', v_ticket.id, 'business_id', v_ticket.business_id,
            'request_type', v_ticket.request_type, 'priority', v_ticket.priority,
            'assigned_partner_organization_id', v_ticket.assigned_partner_organization_id),
        p_trusted_ip => NULL,
        p_trusted_user_agent => NULL
    );

    RETURN pg_catalog.jsonb_build_object('id', v_ticket.id, 'status', v_ticket.status,
        'version', v_ticket.version, 'assigned_partner_organization_id', v_partner_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.change_ticket_status(
    p_ticket_id uuid,
    p_status text,
    p_expected_version integer
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_user_id uuid := auth.uid();
    v_actor public.profiles%ROWTYPE;
    v_ticket public.tickets%ROWTYPE;
    v_old_status text;
    v_old_label text;
    v_new_label text;
    v_now timestamptz;
BEGIN
    IF v_auth_user_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'authentication_required';
    END IF;
    PERFORM private.require_request_app_session(true);
    SELECT p.* INTO v_actor FROM public.profiles AS p
    WHERE p.auth_user_id = v_auth_user_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'profile_not_found';
    END IF;
    IF v_actor.role NOT IN ('admin', 'operator', 'partner_admin') THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'role_not_allowed';
    END IF;
    IF v_actor.account_status IN ('suspended', 'disabled') THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'account_unavailable';
    END IF;
    IF p_status IS NULL OR p_status NOT IN ('new', 'inprogress', 'hold', 'done') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_status';
    END IF;
    IF p_expected_version IS NULL OR p_expected_version <= 0 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_expected_version';
    END IF;

    -- Check visibility before locking to avoid locking arbitrary forbidden Tickets.
    IF NOT public.can_access_ticket(p_ticket_id) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'ticket_not_found_or_forbidden';
    END IF;
    SELECT t.* INTO v_ticket FROM public.tickets AS t WHERE t.id = p_ticket_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'ticket_not_found_or_forbidden';
    END IF;
    IF v_actor.role = 'partner_admin' THEN
        PERFORM 1 FROM public.service_partners AS sp
        WHERE sp.business_id = v_ticket.business_id
          AND sp.partner_organization_id = v_actor.organization_id FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'ticket_not_found_or_forbidden';
        END IF;
    END IF;
    -- Recheck after locks: assignment or access_level may have changed while waiting.
    IF NOT public.can_access_ticket(p_ticket_id) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'ticket_not_found_or_forbidden';
    END IF;
    IF v_ticket.retention_state = 'anonymized' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ticket_anonymized_read_only';
    END IF;

    IF v_ticket.version <> p_expected_version THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'ticket_version_conflict';
    END IF;
    IF v_ticket.status = p_status THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'ticket_status_unchanged';
    END IF;

    v_old_status := v_ticket.status;
    v_now := pg_catalog.clock_timestamp();
    UPDATE public.tickets AS t
    SET status = p_status,
        resolved_at = CASE WHEN p_status = 'done' THEN v_now ELSE NULL END,
        version = t.version + 1,
        updated_at = v_now
    WHERE t.id = p_ticket_id AND t.version = p_expected_version
    RETURNING t.* INTO v_ticket;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'ticket_version_conflict';
    END IF;

    v_old_label := CASE v_old_status WHEN 'new' THEN '신규' WHEN 'inprogress' THEN '진행중'
        WHEN 'hold' THEN '보류' WHEN 'done' THEN '완료' END;
    v_new_label := CASE p_status WHEN 'new' THEN '신규' WHEN 'inprogress' THEN '진행중'
        WHEN 'hold' THEN '보류' WHEN 'done' THEN '완료' END;
    INSERT INTO public.activities (
        ticket_id, actor_profile_id, actor_name_snapshot, actor_role_snapshot,
        type, content, is_internal, meta, created_at
    ) VALUES (
        v_ticket.id, v_actor.id,
        COALESCE(NULLIF(v_actor.display_name, ''), NULLIF(v_actor.full_name, ''), v_actor.email),
        v_actor.role, 'status_change', '상태 변경: ' || v_old_label || ' → ' || v_new_label, false,
        pg_catalog.jsonb_build_object('old_status', v_old_status, 'new_status', p_status,
            'old_version', p_expected_version, 'new_version', v_ticket.version), v_now
    );
    -- Audit append: same transaction; errors propagate.
    PERFORM audit.append_access_log(
        p_action => '상태 변경',
        p_target_type => 'Ticket',
        p_target_id => v_ticket.id::text,
        p_subject_info => NULL,
        p_detail => '티켓 상태 변경 완료',
        p_metadata => pg_catalog.jsonb_build_object(
            'ticket_id', v_ticket.id, 'old_status', v_old_status,
            'new_status', v_ticket.status, 'old_version', p_expected_version,
            'new_version', v_ticket.version),
        p_trusted_ip => NULL,
        p_trusted_user_agent => NULL
    );

    RETURN pg_catalog.jsonb_build_object('id', v_ticket.id, 'status', v_ticket.status,
        'version', v_ticket.version, 'resolved_at', v_ticket.resolved_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.add_ticket_activity(
    p_ticket_id uuid,
    p_type text,
    p_content text
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_user_id uuid := auth.uid();
    v_actor public.profiles%ROWTYPE;
    v_ticket public.tickets%ROWTYPE;
    v_activity public.activities%ROWTYPE;
    v_content text;
BEGIN
    IF v_auth_user_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'authentication_required';
    END IF;
    PERFORM private.require_request_app_session(true);
    SELECT p.* INTO v_actor FROM public.profiles AS p
    WHERE p.auth_user_id = v_auth_user_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'profile_not_found';
    END IF;
    IF v_actor.role NOT IN ('admin', 'operator', 'partner_admin') THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'role_not_allowed';
    END IF;
    IF v_actor.account_status IN ('suspended', 'disabled') THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'account_unavailable';
    END IF;
    IF p_type IS NULL OR p_type NOT IN ('comment', 'note') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_activity_type';
    END IF;
    IF p_type = 'note' AND v_actor.role NOT IN ('admin', 'operator') THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'internal_note_forbidden';
    END IF;
    IF p_content IS NULL OR p_content !~ '[^[:space:]]' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'activity_content_required';
    END IF;
    -- Preserve trim behavior without inventing a content length limit.
    v_content := pg_catalog.regexp_replace(p_content, '^[[:space:]]+|[[:space:]]+$', '', 'g');

    IF NOT public.can_access_ticket(p_ticket_id) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'ticket_not_found_or_forbidden';
    END IF;
    -- SHARE prevents assignment changes while authorization and INSERT complete.
    SELECT t.* INTO v_ticket FROM public.tickets AS t WHERE t.id = p_ticket_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'ticket_not_found_or_forbidden';
    END IF;
    IF v_actor.role = 'partner_admin' THEN
        PERFORM 1 FROM public.service_partners AS sp
        WHERE sp.business_id = v_ticket.business_id
          AND sp.partner_organization_id = v_actor.organization_id FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'ticket_not_found_or_forbidden';
        END IF;
    END IF;
    IF NOT public.can_access_ticket(p_ticket_id) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'ticket_not_found_or_forbidden';
    END IF;

    IF v_ticket.retention_state = 'anonymized' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ticket_anonymized_read_only';
    END IF;

    INSERT INTO public.activities (
        ticket_id, actor_profile_id, actor_name_snapshot, actor_role_snapshot,
        type, content, is_internal, created_at
    ) VALUES (
        v_ticket.id, v_actor.id,
        COALESCE(NULLIF(v_actor.display_name, ''), NULLIF(v_actor.full_name, ''), v_actor.email),
        v_actor.role, p_type, v_content, p_type = 'note', pg_catalog.clock_timestamp()
    ) RETURNING * INTO v_activity;

    -- Audit append: same transaction; errors propagate.
    PERFORM audit.append_access_log(
        p_action => CASE p_type WHEN 'comment' THEN '댓글 작성' ELSE '내부 메모 작성' END,
        p_target_type => 'Ticket',
        p_target_id => v_activity.ticket_id::text,
        p_subject_info => NULL,
        p_detail => CASE p_type WHEN 'comment' THEN '티켓 댓글 작성 완료' ELSE '티켓 내부 메모 작성 완료' END,
        p_metadata => pg_catalog.jsonb_build_object(
            'ticket_id', v_activity.ticket_id, 'activity_id', v_activity.id,
            'activity_type', v_activity.type, 'is_internal', v_activity.is_internal),
        p_trusted_ip => NULL,
        p_trusted_user_agent => NULL
    );

    RETURN pg_catalog.jsonb_build_object('id', v_activity.id, 'ticket_id', v_activity.ticket_id,
        'type', v_activity.type, 'is_internal', v_activity.is_internal,
        'created_at', v_activity.created_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.change_ticket_assignment(
    p_ticket_id uuid,
    p_assigned_partner_organization_id uuid,
    p_expected_version integer
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_user_id uuid := auth.uid();
    v_actor public.profiles%ROWTYPE;
    v_ticket public.tickets%ROWTYPE;
    v_old_partner_id uuid;
    v_new_partner_name text;
    v_now timestamptz;
BEGIN
    IF v_auth_user_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'authentication_required';
    END IF;
    PERFORM private.require_request_app_session(true);
    SELECT p.* INTO v_actor FROM public.profiles AS p
    WHERE p.auth_user_id = v_auth_user_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'profile_not_found';
    END IF;
    IF v_actor.role NOT IN ('admin', 'operator') THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'role_not_allowed';
    END IF;
    IF v_actor.account_status IN ('suspended', 'disabled') THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'account_unavailable';
    END IF;
    IF p_expected_version IS NULL OR p_expected_version <= 0 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_expected_version';
    END IF;
    IF NOT public.can_access_ticket(p_ticket_id) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'ticket_not_found_or_forbidden';
    END IF;
    SELECT t.* INTO v_ticket FROM public.tickets AS t WHERE t.id = p_ticket_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'ticket_not_found_or_forbidden';
    END IF;
    IF NOT public.can_access_ticket(p_ticket_id) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'ticket_not_found_or_forbidden';
    END IF;
    IF v_ticket.retention_state = 'anonymized' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ticket_anonymized_read_only';
    END IF;

    IF v_ticket.version <> p_expected_version THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'ticket_version_conflict';
    END IF;
    IF v_ticket.assigned_partner_organization_id IS NOT DISTINCT FROM p_assigned_partner_organization_id THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'assignment_unchanged';
    END IF;

    IF p_assigned_partner_organization_id IS NOT NULL THEN
        -- Use the locked Ticket's Business, never a caller-provided Business ID.
        -- Hold relation and organization locks until UPDATE and Activity INSERT finish.
        SELECT o.name INTO v_new_partner_name
        FROM public.service_partners AS sp
        JOIN public.organizations AS o ON o.id = sp.partner_organization_id
        WHERE sp.business_id = v_ticket.business_id
          AND sp.partner_organization_id = p_assigned_partner_organization_id
          AND o.type = 'partner'
        FOR SHARE OF sp, o;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'business_partner_relation_required';
        END IF;
    END IF;

    v_old_partner_id := v_ticket.assigned_partner_organization_id;
    v_now := pg_catalog.clock_timestamp();
    UPDATE public.tickets AS t
    SET assigned_partner_organization_id = p_assigned_partner_organization_id,
        version = t.version + 1,
        updated_at = v_now
    WHERE t.id = p_ticket_id AND t.version = p_expected_version
    RETURNING t.* INTO v_ticket;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'ticket_version_conflict';
    END IF;

    -- Existing Partner assignment history is public, including unassignment.
    INSERT INTO public.activities (
        ticket_id, actor_profile_id, actor_name_snapshot, actor_role_snapshot,
        type, content, is_internal, meta, created_at
    ) VALUES (
        v_ticket.id, v_actor.id,
        COALESCE(NULLIF(v_actor.display_name, ''), NULLIF(v_actor.full_name, ''), v_actor.email),
        v_actor.role, 'assignment', '파트너 배정: ' || COALESCE(v_new_partner_name, '–'), false,
        pg_catalog.jsonb_build_object('old_partner_organization_id', v_old_partner_id,
            'new_partner_organization_id', p_assigned_partner_organization_id,
            'old_version', p_expected_version, 'new_version', v_ticket.version), v_now
    );

    -- Audit append: same transaction; errors propagate.
    PERFORM audit.append_access_log(
        p_action => '파트너 배정 변경',
        p_target_type => 'Ticket',
        p_target_id => v_ticket.id::text,
        p_subject_info => NULL,
        p_detail => '티켓 담당 파트너 변경 완료',
        p_metadata => pg_catalog.jsonb_build_object(
            'ticket_id', v_ticket.id, 'old_partner_organization_id', v_old_partner_id,
            'new_partner_organization_id', v_ticket.assigned_partner_organization_id,
            'old_version', p_expected_version, 'new_version', v_ticket.version),
        p_trusted_ip => NULL,
        p_trusted_user_agent => NULL
    );

    RETURN pg_catalog.jsonb_build_object('id', v_ticket.id,
        'assigned_partner_organization_id', v_ticket.assigned_partner_organization_id,
        'version', v_ticket.version, 'updated_at', v_ticket.updated_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_role_request(
    p_requested_role text, p_requested_organization_id uuid,
    p_justification text, p_consent_agreed boolean
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_org public.organizations%ROWTYPE;
    v_current_org public.organizations%ROWTYPE;
    v_id uuid;
    v_now timestamptz;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'authentication_required' USING ERRCODE = '28000';
    END IF;
    -- Per-user serialization, including the first pending request insertion.
    PERFORM private.require_request_app_session(true);
    SELECT p.* INTO v_actor FROM public.profiles AS p
    WHERE p.auth_user_id = auth.uid() FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'profile_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF v_actor.account_status IN ('suspended', 'disabled') THEN
        RAISE EXCEPTION 'account_unavailable' USING ERRCODE = '42501';
    END IF;
    IF p_requested_role IS NULL OR p_requested_role NOT IN ('operator', 'partner_admin') THEN
        RAISE EXCEPTION 'invalid_requested_role' USING ERRCODE = '22023';
    END IF;
    IF p_consent_agreed IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'request_consent_required' USING ERRCODE = '22023';
    END IF;
    IF p_justification IS NULL OR p_justification !~ '[^[:space:]]'
       OR pg_catalog.char_length(p_justification) > 2000 THEN
        RAISE EXCEPTION 'invalid_justification' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.role_requests AS r
        WHERE r.requester_profile_id = v_actor.id AND r.status = 'pending') THEN
        RAISE EXCEPTION 'pending_role_request_exists' USING ERRCODE = '23505';
    END IF;
    v_org := private.validate_profile_role_organization(p_requested_role, p_requested_organization_id);
    SELECT o.* INTO v_current_org FROM public.organizations AS o WHERE o.id = v_actor.organization_id;
    v_now := pg_catalog.clock_timestamp();
    INSERT INTO public.role_requests (
        requester_profile_id, requester_name_snapshot, requester_email_snapshot,
        current_role_snapshot, current_org_type_snapshot, current_affiliation_snapshot,
        current_organization_id, requested_role, requested_org_type, company,
        requested_organization_id, justification, status, consent_agreed,
        consent_agreed_at, created_by_profile_id, created_at, updated_at
    ) VALUES (
        v_actor.id, v_actor.full_name, v_actor.email, v_actor.role,
        CASE WHEN v_current_org.type = 'operator' THEN 'operator_company' ELSE 'partner' END,
        v_current_org.name, v_actor.organization_id, p_requested_role,
        CASE WHEN v_org.type = 'operator' THEN 'operator_company' ELSE 'partner' END,
        v_org.name, v_org.id, pg_catalog.btrim(p_justification), 'pending', true,
        v_now, v_actor.id, v_now, v_now
    ) RETURNING id INTO v_id;
    -- Request-specific ConsentModal agreement; annual pledge history is untouched.
    PERFORM audit.append_access_log(p_action => '권한 요청', p_target_type => 'RoleRequest',
        p_target_id => v_id::text, p_metadata => pg_catalog.jsonb_build_object(
            'role_request_id', v_id, 'requested_role', p_requested_role,
            'requested_organization_id', v_org.id));
    RETURN pg_catalog.jsonb_build_object('id', v_id, 'status', 'pending');
END;
$$;

CREATE OR REPLACE FUNCTION public.record_privacy_consent(p_agreed boolean)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
SET timezone = 'UTC'
AS $$
DECLARE
    v_profile public.profiles%ROWTYPE;
    v_required_version text;
    v_now timestamptz;
    v_consent public.privacy_consents%ROWTYPE;
    v_company text;
BEGIN
    PERFORM private.require_request_app_session(true);
    IF p_agreed IS DISTINCT FROM true THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'explicit_consent_required';
    END IF;
    v_profile := private.require_consent_profile();
    SELECT s.value INTO v_required_version FROM public.system_settings AS s
    WHERE s.key = 'privacy_pledge_version' FOR SHARE;
    IF v_required_version IS NULL OR v_required_version !~ '[^[:space:]]' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'pledge_version_unavailable';
    END IF;
    SELECT o.name INTO v_company FROM public.organizations AS o
    WHERE o.id = v_profile.organization_id FOR SHARE;
    v_now := pg_catalog.clock_timestamp();
    INSERT INTO public.privacy_consents (profile_id, organization_id, consent_type,
        pledge_version, consent_date, valid_until, user_name_snapshot,
        user_email_snapshot, company_snapshot, created_at)
    VALUES (v_profile.id, v_profile.organization_id, 'privacy_pledge', v_required_version,
        v_now, (v_now + interval '1 year')::date,
        COALESCE(NULLIF(v_profile.display_name, ''), NULLIF(v_profile.full_name, ''), v_profile.email),
        v_profile.email, v_company, v_now)
    RETURNING * INTO v_consent;
    RETURN pg_catalog.jsonb_build_object('id', v_consent.id, 'consent_date', v_consent.consent_date,
        'valid_until', v_consent.valid_until, 'pledge_version', v_required_version,
        'consent_type', 'privacy_pledge');
END;
$$;

ALTER FUNCTION private.request_app_session_token_hash() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.request_app_session_token_hash() FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION private.find_valid_request_app_session() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.find_valid_request_app_session() FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION private.require_request_app_session(boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.require_request_app_session(boolean) FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION private.require_management_actor(text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.require_management_actor(text[]) FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION private.require_consent_profile() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.require_consent_profile() FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION public.has_valid_app_session() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.has_valid_app_session() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_valid_app_session() TO authenticated;

ALTER FUNCTION public.touch_app_session() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.touch_app_session() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.touch_app_session() TO authenticated;

ALTER FUNCTION public.current_profile_id() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.current_profile_id() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_profile_id() TO authenticated;

ALTER FUNCTION public.current_profile_role() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.current_profile_role() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_profile_role() TO authenticated;

ALTER FUNCTION public.current_organization_id() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.current_organization_id() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_organization_id() TO authenticated;

ALTER FUNCTION public.can_access_business(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.can_access_business(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_business(uuid) TO authenticated;

ALTER FUNCTION public.can_access_ticket(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.can_access_ticket(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_ticket(uuid) TO authenticated;

ALTER FUNCTION public.create_ticket(uuid, text, text, text, text, text, text, text, text, text, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_ticket(uuid, text, text, text, text, text, text, text, text, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_ticket(uuid, text, text, text, text, text, text, text, text, text, text, uuid) TO authenticated;

ALTER FUNCTION public.change_ticket_status(uuid, text, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.change_ticket_status(uuid, text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.change_ticket_status(uuid, text, integer) TO authenticated;

ALTER FUNCTION public.add_ticket_activity(uuid, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.add_ticket_activity(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.add_ticket_activity(uuid, text, text) TO authenticated;

ALTER FUNCTION public.change_ticket_assignment(uuid, uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.change_ticket_assignment(uuid, uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.change_ticket_assignment(uuid, uuid, integer) TO authenticated;

ALTER FUNCTION public.submit_role_request(text, uuid, text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.submit_role_request(text, uuid, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_role_request(text, uuid, text, boolean) TO authenticated;

ALTER FUNCTION public.record_privacy_consent(boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_privacy_consent(boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_privacy_consent(boolean) TO authenticated;

-- Backend authentication/revocation and retention functions keep their existing ACLs
-- and implementation. No grants to private schema/tables or policies there are added.
COMMIT;
