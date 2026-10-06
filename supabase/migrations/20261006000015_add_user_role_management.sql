BEGIN;

-- Step 18 blocker: existing RLS/business RPCs do not enforce app-session MFA/IP.
-- This migration does not change that boundary or create organizations/Auth users.
-- All user-access administration shares this transaction lock, before row locks.
CREATE FUNCTION private.require_user_role_admin()
RETURNS public.profiles
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'authentication_required' USING ERRCODE = '28000';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(20261006, 17);
    RETURN private.require_management_actor(ARRAY['admin']::text[]);
END;
$$;

CREATE FUNCTION private.validate_profile_role_organization(p_role text, p_organization_id uuid)
RETURNS public.organizations
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_org public.organizations%ROWTYPE;
BEGIN
    IF p_role IS NULL OR p_role NOT IN ('admin', 'operator', 'partner_admin', 'guest') THEN
        RAISE EXCEPTION 'invalid_role' USING ERRCODE = '22023';
    END IF;
    SELECT o.* INTO v_org FROM public.organizations AS o
    WHERE o.id = p_organization_id AND o.is_active FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'active_organization_required' USING ERRCODE = '22023';
    END IF;
    IF p_role IN ('admin', 'operator') AND v_org.type <> 'operator' THEN
        RAISE EXCEPTION 'operator_organization_required' USING ERRCODE = '22023';
    END IF;
    IF p_role = 'partner_admin' THEN
        IF v_org.type <> 'partner' THEN
            RAISE EXCEPTION 'partner_organization_required' USING ERRCODE = '22023';
        END IF;
        PERFORM 1 FROM public.partner_details AS d
        WHERE d.organization_id = v_org.id FOR KEY SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'partner_details_required' USING ERRCODE = '22023';
        END IF;
    END IF;
    -- Confirmed v1 policy overrides legacy UI: admin/operator belong to operator orgs.
    -- Guest retains an existing active organization until role approval.
    RETURN v_org;
END;
$$;

-- Called only after require_user_role_admin, with the target Profile locked.
CREATE FUNCTION private.protect_last_active_admin(p_before public.profiles, p_after_role text, p_after_status text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    IF p_before.role = 'admin' AND p_before.account_status = 'active'
       AND (p_after_role <> 'admin' OR p_after_status <> 'active')
       AND NOT EXISTS (
           SELECT 1 FROM public.profiles AS p
           JOIN public.organizations AS o ON o.id = p.organization_id
           WHERE p.id <> p_before.id AND p.role = 'admin'
             AND p.account_status = 'active' AND p.auth_user_id IS NOT NULL
             AND o.is_active AND o.type = 'operator'
       ) THEN
        RAISE EXCEPTION 'last_active_admin_protected' USING ERRCODE = '42501';
    END IF;
END;
$$;

-- Internal shared transaction body. No actor identity is accepted from the client.
CREATE FUNCTION private.apply_profile_role_organization(
    p_profile_id uuid, p_role text, p_organization_id uuid, p_role_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_before public.profiles%ROWTYPE;
    v_org public.organizations%ROWTYPE;
    v_before_org_type text;
    v_now timestamptz;
BEGIN
    v_actor := private.require_user_role_admin();
    SELECT p.* INTO v_before FROM public.profiles AS p WHERE p.id = p_profile_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'profile_not_found' USING ERRCODE = 'P0002';
    END IF;
    v_org := private.validate_profile_role_organization(p_role, p_organization_id);
    IF p_role_request_id IS NULL AND v_before.role = p_role
       AND v_before.organization_id = p_organization_id THEN
        RAISE EXCEPTION 'profile_access_unchanged' USING ERRCODE = '22023';
    END IF;
    PERFORM private.protect_last_active_admin(v_before, p_role, v_before.account_status);
    SELECT o.type INTO v_before_org_type FROM public.organizations AS o
    WHERE o.id = v_before.organization_id;
    v_now := pg_catalog.clock_timestamp();
    UPDATE public.profiles SET role = p_role, organization_id = p_organization_id,
        updated_at = v_now WHERE id = p_profile_id;
    INSERT INTO audit.role_change_logs (
        target_profile_id, target_user_id, change_type, role_request_id,
        request_id, requester_profile_id, requested_at, role_before, role_after,
        org_type_before, org_type_after, affiliation_before, affiliation_after,
        actor_profile_id, actor_id, actor_role, source_api, changed_at
    ) VALUES (
        p_profile_id, p_profile_id::text,
        CASE WHEN p_role_request_id IS NULL THEN 'direct' ELSE 'request_approved' END,
        p_role_request_id, p_role_request_id::text,
        CASE WHEN p_role_request_id IS NOT NULL THEN p_profile_id END,
        (SELECT r.created_at FROM public.role_requests AS r WHERE r.id = p_role_request_id),
        v_before.role, p_role, v_before_org_type, v_org.type,
        v_before.organization_id::text, p_organization_id::text,
        v_actor.id, v_actor.id::text, v_actor.role,
        CASE WHEN p_role_request_id IS NULL THEN 'change_profile_role_organization'
             ELSE 'approve_role_request' END, v_now
    );
    -- UUID snapshots in legacy affiliation fields avoid name-based identity/PII copies.
    PERFORM private.revoke_profile_sessions(p_profile_id);
    PERFORM audit.append_access_log(
        p_action => CASE WHEN p_role_request_id IS NULL THEN '사용자 권한/소속 변경' ELSE '권한 승인' END,
        p_target_type => 'Profile', p_target_id => p_profile_id::text,
        p_metadata => pg_catalog.jsonb_build_object('profile_id', p_profile_id,
            'role_request_id', p_role_request_id, 'old_role', v_before.role, 'new_role', p_role,
            'old_organization_id', v_before.organization_id, 'new_organization_id', p_organization_id)
    );
    RETURN pg_catalog.jsonb_build_object('id', p_profile_id, 'role', p_role,
        'organization_id', p_organization_id);
END;
$$;

CREATE FUNCTION public.submit_role_request(
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

CREATE FUNCTION public.approve_role_request(
    p_role_request_id uuid, p_organization_id uuid DEFAULT NULL, p_admin_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_request public.role_requests%ROWTYPE;
    v_org public.organizations%ROWTYPE;
    v_organization_id uuid;
    v_result jsonb;
    v_now timestamptz;
BEGIN
    v_actor := private.require_user_role_admin();
    SELECT r.* INTO v_request FROM public.role_requests AS r
    WHERE r.id = p_role_request_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'role_request_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF v_request.status <> 'pending' THEN
        RAISE EXCEPTION 'role_request_already_reviewed' USING ERRCODE = '22023';
    END IF;
    IF v_request.requested_role NOT IN ('operator', 'partner_admin') THEN
        RAISE EXCEPTION 'invalid_requested_role' USING ERRCODE = '22023';
    END IF;
    IF v_request.consent_agreed IS DISTINCT FROM true OR v_request.consent_agreed_at IS NULL THEN
        RAISE EXCEPTION 'request_consent_required' USING ERRCODE = '22023';
    END IF;
    IF v_request.requested_organization_id IS NOT NULL AND p_organization_id IS NOT NULL
       AND v_request.requested_organization_id <> p_organization_id THEN
        RAISE EXCEPTION 'requested_organization_mismatch' USING ERRCODE = '22023';
    END IF;
    -- Legacy name/Base44-ID snapshots are never interpreted as organization identity.
    v_organization_id := COALESCE(v_request.requested_organization_id, p_organization_id);
    IF v_organization_id IS NULL THEN
        RAISE EXCEPTION 'explicit_organization_mapping_required' USING ERRCODE = '22023';
    END IF;
    v_org := private.validate_profile_role_organization(v_request.requested_role, v_organization_id);
    IF v_request.requested_org_type IS NOT NULL AND v_request.requested_org_type <>
       CASE WHEN v_org.type = 'operator' THEN 'operator_company' ELSE 'partner' END THEN
        RAISE EXCEPTION 'requested_organization_type_mismatch' USING ERRCODE = '22023';
    END IF;
    PERFORM 1 FROM public.profiles AS p WHERE p.id = v_request.requester_profile_id
        AND p.account_status NOT IN ('suspended', 'disabled') FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'requester_unavailable' USING ERRCODE = '42501';
    END IF;
    v_result := private.apply_profile_role_organization(v_request.requester_profile_id,
        v_request.requested_role, v_organization_id, v_request.id);
    v_now := pg_catalog.clock_timestamp();
    UPDATE public.role_requests SET status = 'approved', requested_organization_id = v_organization_id,
        reviewed_by_profile_id = v_actor.id, reviewed_at = v_now, admin_notes = p_admin_notes,
        updated_at = v_now WHERE id = v_request.id;
    RETURN v_result || pg_catalog.jsonb_build_object('role_request_id', v_request.id, 'status', 'approved');
END;
$$;

-- Explicit final pair supports role-only, org-only and simultaneous UI edits atomically.
CREATE FUNCTION public.change_profile_role_organization(p_profile_id uuid, p_role text, p_organization_id uuid)
RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$ SELECT private.apply_profile_role_organization(p_profile_id, p_role, p_organization_id); $$;

CREATE FUNCTION public.deactivate_profile(p_profile_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_target public.profiles%ROWTYPE;
    v_now timestamptz;
BEGIN
    v_actor := private.require_user_role_admin();
    IF p_profile_id = v_actor.id THEN
        RAISE EXCEPTION 'self_deactivation_not_allowed' USING ERRCODE = '42501';
    END IF;
    SELECT p.* INTO v_target FROM public.profiles AS p WHERE p.id = p_profile_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'profile_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF v_target.account_status = 'disabled' THEN
        RAISE EXCEPTION 'profile_already_disabled' USING ERRCODE = '22023';
    END IF;
    PERFORM private.protect_last_active_admin(v_target, v_target.role, 'disabled');
    v_now := pg_catalog.clock_timestamp();
    UPDATE public.profiles SET account_status = 'disabled', disabled_at = v_now,
        updated_at = v_now WHERE id = p_profile_id;
    PERFORM private.revoke_profile_sessions(p_profile_id);
    PERFORM audit.append_access_log(p_action => '사용자 비활성화', p_target_type => 'Profile',
        p_target_id => p_profile_id::text, p_metadata => pg_catalog.jsonb_build_object(
            'profile_id', p_profile_id, 'old_account_status', v_target.account_status,
            'new_account_status', 'disabled'));
    RETURN pg_catalog.jsonb_build_object('id', p_profile_id, 'account_status', 'disabled');
END;
$$;

-- Existing review/reactivation bodies follow below with shared serialization/revoke.

CREATE OR REPLACE FUNCTION public.reject_role_request(p_role_request_id uuid, p_admin_notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_request public.role_requests%ROWTYPE;
    v_now timestamptz;
BEGIN
    v_actor := private.require_user_role_admin();
    SELECT r.* INTO v_request FROM public.role_requests AS r
    WHERE r.id = p_role_request_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'role_request_not_found';
    END IF;
    IF v_request.status <> 'pending' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'role_request_already_reviewed';
    END IF;
    v_now := pg_catalog.clock_timestamp();
    UPDATE public.role_requests SET status = 'denied', admin_notes = p_admin_notes,
        reviewed_by_profile_id = v_actor.id, reviewed_at = v_now, updated_at = v_now
    WHERE id = p_role_request_id;
    PERFORM audit.append_access_log(p_action => '권한 거절', p_target_type => 'RoleRequest',
        p_target_id => p_role_request_id::text,
        p_metadata => pg_catalog.jsonb_build_object('role_request_id', p_role_request_id,
            'requester_profile_id', v_request.requester_profile_id,
            'old_status', v_request.status, 'new_status', 'denied'));
    RETURN pg_catalog.jsonb_build_object('id', p_role_request_id, 'status', 'denied');
END;
$$;

CREATE OR REPLACE FUNCTION public.reactivate_profile(p_profile_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_target public.profiles%ROWTYPE;
BEGIN
    v_actor := private.require_user_role_admin();
    SELECT p.* INTO v_target FROM public.profiles AS p WHERE p.id = p_profile_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'profile_not_found';
    END IF;
    IF v_target.account_status <> 'suspended' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'profile_not_suspended';
    END IF;
    UPDATE public.profiles SET account_status = 'active', updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_profile_id;
    PERFORM private.revoke_profile_sessions(p_profile_id);
    PERFORM audit.append_access_log(p_action => '사용자 상태 변경', p_target_type => 'Profile',
        p_target_id => p_profile_id::text,
        p_metadata => pg_catalog.jsonb_build_object('profile_id', p_profile_id,
            'old_account_status', v_target.account_status, 'new_account_status', 'active'));
    RETURN pg_catalog.jsonb_build_object('id', p_profile_id, 'account_status', 'active');
END;
$$;

ALTER FUNCTION private.require_user_role_admin() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.require_user_role_admin() FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION private.validate_profile_role_organization(text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.validate_profile_role_organization(text, uuid) FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION private.protect_last_active_admin(public.profiles, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.protect_last_active_admin(public.profiles, text, text) FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION private.apply_profile_role_organization(uuid, text, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.apply_profile_role_organization(uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION public.submit_role_request(text, uuid, text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.submit_role_request(text, uuid, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_role_request(text, uuid, text, boolean) TO authenticated;

ALTER FUNCTION public.approve_role_request(uuid, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.approve_role_request(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.approve_role_request(uuid, uuid, text) TO authenticated;

ALTER FUNCTION public.change_profile_role_organization(uuid, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.change_profile_role_organization(uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.change_profile_role_organization(uuid, text, uuid) TO authenticated;

ALTER FUNCTION public.deactivate_profile(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.deactivate_profile(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deactivate_profile(uuid) TO authenticated;

ALTER FUNCTION public.reject_role_request(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reject_role_request(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reject_role_request(uuid, text) TO authenticated;

ALTER FUNCTION public.reactivate_profile(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reactivate_profile(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reactivate_profile(uuid) TO authenticated;

COMMIT;
