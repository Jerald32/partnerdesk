BEGIN;

-- Only UI-backed, unambiguous writes. No role/organization changes, deletion,
-- consent enforcement, Auth administration, logo mapping or inactivity automation.
-- This helper is internal: callers cannot supply actor identity or allowed roles.
CREATE FUNCTION private.require_management_actor(p_allowed_roles text[])
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

CREATE FUNCTION public.create_business(p_name text, p_description text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_business public.businesses%ROWTYPE;
BEGIN
    v_actor := private.require_management_actor(ARRAY['admin', 'operator']::text[]);
    IF p_name IS NULL OR p_name !~ '[^[:space:]]' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'business_name_required';
    END IF;
    INSERT INTO public.businesses (name, description, created_by_profile_id)
    VALUES (p_name, p_description, v_actor.id) RETURNING * INTO v_business;
    PERFORM audit.append_access_log(p_action => '비즈니스 생성', p_target_type => 'Business',
        p_target_id => v_business.id::text,
        p_metadata => pg_catalog.jsonb_build_object('business_id', v_business.id));
    RETURN pg_catalog.jsonb_build_object('id', v_business.id);
END;
$$;

CREATE FUNCTION public.create_partner(
    p_name text, p_partner_type text,
    p_contact_name text DEFAULT NULL, p_contact_email text DEFAULT NULL,
    p_contact_phone text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_organization_id uuid;
BEGIN
    v_actor := private.require_management_actor(ARRAY['admin']::text[]);
    IF p_name IS NULL OR p_name !~ '[^[:space:]]' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'partner_name_required';
    END IF;
    IF p_partner_type IS NULL OR p_partner_type NOT IN
        ('manufacturer', 'maintenance', 'installation', 'support', 'other') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_partner_type';
    END IF;
    INSERT INTO public.organizations (name, type, created_by_profile_id)
    VALUES (p_name, 'partner', v_actor.id) RETURNING id INTO v_organization_id;
    INSERT INTO public.partner_details (organization_id, partner_type,
        contact_name, contact_email, contact_phone, created_by_profile_id)
    VALUES (v_organization_id, p_partner_type,
        p_contact_name, p_contact_email, p_contact_phone, v_actor.id);
    PERFORM audit.append_access_log(p_action => '파트너 생성', p_target_type => 'Partner',
        p_target_id => v_organization_id::text,
        p_metadata => pg_catalog.jsonb_build_object('organization_id', v_organization_id,
            'partner_type', p_partner_type));
    RETURN pg_catalog.jsonb_build_object('organization_id', v_organization_id);
END;
$$;

-- Full company form save; logo_path and is_active are deliberately untouched.
CREATE FUNCTION public.update_partner(
    p_partner_organization_id uuid, p_name text, p_partner_type text,
    p_contact_name text DEFAULT NULL, p_contact_email text DEFAULT NULL,
    p_contact_phone text DEFAULT NULL, p_description text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_before public.partner_details%ROWTYPE;
    v_now timestamptz;
BEGIN
    v_actor := private.require_management_actor(ARRAY['admin']::text[]);
    IF p_name IS NULL OR p_name !~ '[^[:space:]]' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'partner_name_required';
    END IF;
    IF p_partner_type IS NULL OR p_partner_type NOT IN
        ('manufacturer', 'maintenance', 'installation', 'support', 'other') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_partner_type';
    END IF;
    PERFORM 1 FROM public.organizations AS o
    WHERE o.id = p_partner_organization_id AND o.type = 'partner' FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'partner_not_found';
    END IF;
    SELECT d.* INTO v_before FROM public.partner_details AS d
    WHERE d.organization_id = p_partner_organization_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'partner_details_not_found';
    END IF;
    v_now := pg_catalog.clock_timestamp();
    UPDATE public.organizations SET name = p_name, updated_at = v_now
    WHERE id = p_partner_organization_id;
    UPDATE public.partner_details SET partner_type = p_partner_type,
        contact_name = p_contact_name, contact_email = p_contact_email,
        contact_phone = p_contact_phone, description = p_description, updated_at = v_now
    WHERE organization_id = p_partner_organization_id;
    PERFORM audit.append_access_log(p_action => '파트너 정보 수정', p_target_type => 'Partner',
        p_target_id => p_partner_organization_id::text,
        p_metadata => pg_catalog.jsonb_build_object('organization_id', p_partner_organization_id,
            'old_partner_type', v_before.partner_type, 'new_partner_type', p_partner_type,
            'fields', pg_catalog.jsonb_build_array('name', 'partner_type', 'contact_name',
                'contact_email', 'contact_phone', 'description')));
    RETURN pg_catalog.jsonb_build_object('organization_id', p_partner_organization_id);
END;
$$;

CREATE FUNCTION public.link_service_partner(
    p_business_id uuid, p_partner_organization_id uuid,
    p_access_level text DEFAULT 'service', p_role_description text DEFAULT NULL,
    p_sla_response_hours numeric DEFAULT 4, p_sla_resolution_hours numeric DEFAULT 24
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_relation public.service_partners%ROWTYPE;
BEGIN
    v_actor := private.require_management_actor(ARRAY['admin', 'operator']::text[]);
    IF p_access_level IS NULL OR p_access_level NOT IN ('business', 'service') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_access_level';
    END IF;
    IF p_sla_response_hours IS NULL OR p_sla_resolution_hours IS NULL
       OR p_sla_response_hours < 0 OR p_sla_resolution_hours < 0
       OR p_sla_response_hours::text IN ('NaN', 'Infinity', '-Infinity')
       OR p_sla_resolution_hours::text IN ('NaN', 'Infinity', '-Infinity') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_sla_hours';
    END IF;
    -- Serialize all connection/access-level writes per Business, including first insertion.
    PERFORM 1 FROM public.businesses AS b WHERE b.id = p_business_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'business_not_found';
    END IF;
    PERFORM 1 FROM public.organizations AS o
    WHERE o.id = p_partner_organization_id AND o.type = 'partner' FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'partner_not_found';
    END IF;
    PERFORM 1 FROM public.partner_details AS d
    WHERE d.organization_id = p_partner_organization_id FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'partner_details_not_found';
    END IF;
    IF EXISTS (SELECT 1 FROM public.service_partners AS sp
        WHERE sp.business_id = p_business_id AND sp.partner_organization_id = p_partner_organization_id) THEN
        RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'business_partner_already_linked';
    END IF;
    IF p_access_level = 'business' AND EXISTS (SELECT 1 FROM public.service_partners AS sp
        WHERE sp.business_id = p_business_id AND sp.access_level = 'business') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'business_partner_limit';
    END IF;
    INSERT INTO public.service_partners (business_id, partner_organization_id, access_level,
        role_description, sla_response_hours, sla_resolution_hours, created_by_profile_id)
    VALUES (p_business_id, p_partner_organization_id, p_access_level,
        p_role_description, p_sla_response_hours, p_sla_resolution_hours, v_actor.id)
    RETURNING * INTO v_relation;
    PERFORM audit.append_access_log(p_action => '파트너 연결', p_target_type => 'Business',
        p_target_id => p_business_id::text,
        p_metadata => pg_catalog.jsonb_build_object('service_partner_id', v_relation.id,
            'business_id', p_business_id, 'partner_organization_id', p_partner_organization_id,
            'access_level', v_relation.access_level, 'sla_response_hours', v_relation.sla_response_hours,
            'sla_resolution_hours', v_relation.sla_resolution_hours));
    RETURN pg_catalog.jsonb_build_object('id', v_relation.id);
END;
$$;

CREATE FUNCTION public.change_service_partner_access_level(p_service_partner_id uuid, p_access_level text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_business_id uuid;
    v_relation public.service_partners%ROWTYPE;
BEGIN
    v_actor := private.require_management_actor(ARRAY['admin', 'operator']::text[]);
    IF p_access_level IS NULL OR p_access_level NOT IN ('business', 'service') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_access_level';
    END IF;
    SELECT sp.business_id INTO v_business_id FROM public.service_partners AS sp
    WHERE sp.id = p_service_partner_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'service_partner_not_found';
    END IF;
    PERFORM 1 FROM public.businesses AS b WHERE b.id = v_business_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'business_not_found';
    END IF;
    SELECT sp.* INTO v_relation FROM public.service_partners AS sp
    WHERE sp.id = p_service_partner_id AND sp.business_id = v_business_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'service_partner_not_found';
    END IF;
    IF p_access_level = 'business' AND EXISTS (SELECT 1 FROM public.service_partners AS sp
        WHERE sp.business_id = v_business_id AND sp.id <> p_service_partner_id
          AND sp.access_level = 'business') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'business_partner_limit';
    END IF;
    UPDATE public.service_partners SET access_level = p_access_level,
        updated_at = pg_catalog.clock_timestamp() WHERE id = p_service_partner_id;
    PERFORM audit.append_access_log(p_action => '파트너 접근등급 변경', p_target_type => 'Business',
        p_target_id => v_business_id::text,
        p_metadata => pg_catalog.jsonb_build_object('service_partner_id', p_service_partner_id,
            'business_id', v_business_id, 'partner_organization_id', v_relation.partner_organization_id,
            'old_access_level', v_relation.access_level, 'new_access_level', p_access_level));
    RETURN pg_catalog.jsonb_build_object('id', p_service_partner_id, 'access_level', p_access_level);
END;
$$;

CREATE FUNCTION public.reject_role_request(p_role_request_id uuid, p_admin_notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_request public.role_requests%ROWTYPE;
    v_now timestamptz;
BEGIN
    v_actor := private.require_management_actor(ARRAY['admin']::text[]);
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

-- Existing UserManagement suspended -> active button only; no generic status setter.
CREATE FUNCTION public.reactivate_profile(p_profile_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_target public.profiles%ROWTYPE;
BEGIN
    v_actor := private.require_management_actor(ARRAY['admin']::text[]);
    SELECT p.* INTO v_target FROM public.profiles AS p WHERE p.id = p_profile_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'profile_not_found';
    END IF;
    IF v_target.account_status <> 'suspended' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'profile_not_suspended';
    END IF;
    UPDATE public.profiles SET account_status = 'active', updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_profile_id;
    PERFORM audit.append_access_log(p_action => '사용자 상태 변경', p_target_type => 'Profile',
        p_target_id => p_profile_id::text,
        p_metadata => pg_catalog.jsonb_build_object('profile_id', p_profile_id,
            'old_account_status', v_target.account_status, 'new_account_status', 'active'));
    RETURN pg_catalog.jsonb_build_object('id', p_profile_id, 'account_status', 'active');
END;
$$;

ALTER FUNCTION private.require_management_actor(text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.require_management_actor(text[]) FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION public.create_business(text, text) OWNER TO postgres;
ALTER FUNCTION public.create_partner(text, text, text, text, text) OWNER TO postgres;
ALTER FUNCTION public.update_partner(uuid, text, text, text, text, text, text) OWNER TO postgres;
ALTER FUNCTION public.link_service_partner(uuid, uuid, text, text, numeric, numeric) OWNER TO postgres;
ALTER FUNCTION public.change_service_partner_access_level(uuid, text) OWNER TO postgres;
ALTER FUNCTION public.reject_role_request(uuid, text) OWNER TO postgres;
ALTER FUNCTION public.reactivate_profile(uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.create_business(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_partner(text, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_partner(uuid, text, text, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.link_service_partner(uuid, uuid, text, text, numeric, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.change_service_partner_access_level(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reject_role_request(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reactivate_profile(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.create_business(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_partner(text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_partner(uuid, text, text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.link_service_partner(uuid, uuid, text, text, numeric, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.change_service_partner_access_level(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_role_request(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reactivate_profile(uuid) TO authenticated;

COMMIT;
