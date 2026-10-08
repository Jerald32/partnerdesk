-- Separate organization scope from internal role. Apply atomically after 20261008000002.
-- No organizations, memberships, Business links, Tickets or app sessions are rewritten.
BEGIN;
LOCK TABLE public.profiles, public.role_requests IN SHARE ROW EXCLUSIVE MODE;
-- An unreviewed permissive policy could OR around the new scope. Refuse drift.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN ('profiles','organizations','partner_details','businesses','service_partners','tickets',
   'activities','ticket_attachments','notifications','role_requests','privacy_consents','system_settings','ip_whitelist')
  AND NOT c.relrowsecurity) THEN RAISE EXCEPTION 'row_security_disabled_requires_review'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_policies p WHERE p.schemaname='public'
  AND p.tablename IN ('profiles','organizations','partner_details','businesses','service_partners','tickets',
   'activities','ticket_attachments','notifications','role_requests','privacy_consents','system_settings','ip_whitelist')
  AND p.permissive='PERMISSIVE' AND p.tablename||'.'||p.policyname NOT IN (
   'profiles.profiles_select_own','profiles.profiles_select_admin','organizations.organizations_select_authorized',
   'partner_details.partner_details_select_authorized','businesses.businesses_select_authorized',
   'service_partners.service_partners_select_authorized','tickets.tickets_select_authorized','activities.activities_select_authorized',
   'ticket_attachments.ticket_attachments_select_authorized','notifications.notifications_select_admin_or_own',
   'role_requests.role_requests_select_admin_or_own','privacy_consents.privacy_consents_select_admin_or_own',
   'system_settings.system_settings_select_admin','ip_whitelist.ip_whitelist_select_admin')) THEN
  RAISE EXCEPTION 'unreviewed_authorization_policy'; END IF;
 IF (SELECT count(*) FROM pg_catalog.pg_policies p WHERE p.schemaname='public'
  AND p.policyname=p.tablename||'_select_app_session_gate' AND p.permissive='RESTRICTIVE' AND p.cmd='SELECT')<>13 THEN
  RAISE EXCEPTION 'app_session_policy_baseline_mismatch'; END IF;
END $$;
-- Fail closed if a legacy partner administrator has an inconsistent membership.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.profiles p JOIN public.organizations o ON o.id=p.organization_id
   WHERE p.role='partner_admin' AND (o.type<>'partner' OR NOT EXISTS
     (SELECT 1 FROM public.partner_details d WHERE d.organization_id=o.id))) THEN
   RAISE EXCEPTION 'legacy_partner_membership_requires_review';
 END IF;
END $$;
-- Preserve all identity/org/status fields; translate only the legacy internal role.
UPDATE public.profiles SET role='admin' WHERE role='partner_admin';
ALTER TABLE public.profiles DROP CONSTRAINT profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK(role IN ('admin','operator','guest'));
-- Historical approved/denied requests retain their original role snapshots.
ALTER TABLE public.role_requests DROP CONSTRAINT role_requests_requested_role_check;
ALTER TABLE public.role_requests ADD CONSTRAINT role_requests_requested_role_check
 CHECK(requested_role IN ('admin','operator','partner_admin'));


CREATE FUNCTION public.current_organization_type() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT o.type FROM public.profiles p JOIN public.organizations o ON o.id=p.organization_id
 WHERE p.auth_user_id=auth.uid() AND public.has_valid_app_session() AND o.is_active
   AND o.id<>'10a8e084-c396-4a97-b301-c4ef4aa59d71';
$$;
CREATE FUNCTION public.is_company_member() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT COALESCE(public.current_organization_type()='operator'
   AND public.current_profile_role() IN ('admin','operator'),false);
$$;
CREATE FUNCTION public.is_company_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT public.is_company_member() AND public.current_profile_role()='admin';
$$;
CREATE FUNCTION public.can_manage_organization(p_organization_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT public.is_company_admin() OR COALESCE(public.current_profile_role()='admin'
   AND public.current_organization_type()='partner'
   AND public.current_organization_id()=p_organization_id,false);
$$;
CREATE FUNCTION private.require_company_actor(p_allowed_roles text[]) RETURNS public.profiles
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor public.profiles%ROWTYPE;
BEGIN
 v_actor:=private.require_management_actor(p_allowed_roles);
 IF NOT public.is_company_member() THEN RAISE EXCEPTION 'company_role_required' USING ERRCODE='42501'; END IF;
 RETURN v_actor;
END $$;
CREATE OR REPLACE FUNCTION public.can_access_business(p_business_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.businesses b WHERE b.id=p_business_id AND (
  public.is_company_member() OR (public.current_profile_role() IN ('admin','operator')
    AND public.current_organization_type()='partner' AND EXISTS(SELECT 1 FROM public.service_partners sp
     WHERE sp.business_id=b.id AND sp.partner_organization_id=public.current_organization_id()))));
$$;
CREATE OR REPLACE FUNCTION public.can_access_ticket(p_ticket_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.tickets t WHERE t.id=p_ticket_id AND (
  public.is_company_member() OR (public.current_profile_role() IN ('admin','operator')
   AND public.current_organization_type()='partner' AND EXISTS(SELECT 1 FROM public.service_partners sp
    WHERE sp.business_id=t.business_id AND sp.partner_organization_id=public.current_organization_id()
     AND (sp.access_level='business' OR t.assigned_partner_organization_id=sp.partner_organization_id)))));
$$;
CREATE OR REPLACE FUNCTION private.validate_profile_role_organization(p_role text,p_organization_id uuid)
RETURNS public.organizations LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_org public.organizations%ROWTYPE;
BEGIN
 IF p_role IS NULL OR p_role NOT IN ('admin','operator','guest') THEN
  RAISE EXCEPTION 'invalid_role' USING ERRCODE='22023'; END IF;
 SELECT o.* INTO v_org FROM public.organizations o WHERE o.id=p_organization_id AND o.is_active FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'active_organization_required' USING ERRCODE='22023'; END IF;
 IF p_role<>'guest' AND v_org.id='10a8e084-c396-4a97-b301-c4ef4aa59d71' THEN
  RAISE EXCEPTION 'holding_organization_forbidden' USING ERRCODE='42501'; END IF;
 IF v_org.type='partner' AND NOT EXISTS(SELECT 1 FROM public.partner_details d WHERE d.organization_id=v_org.id) THEN
  RAISE EXCEPTION 'partner_details_required' USING ERRCODE='22023'; END IF;
 RETURN v_org;
END $$;


CREATE OR REPLACE FUNCTION private.require_management_actor(p_allowed_roles text[])
 RETURNS profiles
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    IF v_actor.role <> 'guest' AND public.current_organization_type() IS NULL THEN
        RAISE EXCEPTION 'active_organization_required' USING ERRCODE='42501';
    END IF;
    RETURN v_actor;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_business(p_name text, p_description text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_business public.businesses%ROWTYPE;
BEGIN
    v_actor := private.require_company_actor(ARRAY['admin','operator']::text[]);
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
$function$;

CREATE OR REPLACE FUNCTION public.create_partner(p_name text, p_partner_type text, p_contact_name text DEFAULT NULL::text, p_contact_email text DEFAULT NULL::text, p_contact_phone text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_organization_id uuid;
BEGIN
    v_actor := private.require_company_actor(ARRAY['admin']::text[]);
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
$function$;

CREATE OR REPLACE FUNCTION public.change_service_partner_access_level(p_service_partner_id uuid, p_access_level text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_business_id uuid;
    v_relation public.service_partners%ROWTYPE;
BEGIN
    v_actor := private.require_company_actor(ARRAY['admin']::text[]);
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
$function$;

CREATE OR REPLACE FUNCTION public.link_service_partner(p_business_id uuid, p_partner_organization_id uuid, p_access_level text DEFAULT 'service'::text, p_role_description text DEFAULT NULL::text, p_sla_response_hours numeric DEFAULT 4, p_sla_resolution_hours numeric DEFAULT 24)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_relation public.service_partners%ROWTYPE;
BEGIN
    v_actor := private.require_company_actor(ARRAY['admin']::text[]);
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
    WHERE o.id = p_partner_organization_id AND o.type = 'partner' AND o.is_active = true FOR SHARE;
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
$function$;

CREATE OR REPLACE FUNCTION public.unlink_service_partner(p_service_partner_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_business_id uuid;
    v_relation public.service_partners%ROWTYPE;
BEGIN
    v_actor := private.require_company_actor(ARRAY['admin']::text[]);
    SELECT sp.business_id INTO v_business_id FROM public.service_partners AS sp
    WHERE sp.id = p_service_partner_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'service_partner_not_found';
    END IF;
    -- Same Business -> relation lock order as existing management RPCs.
    PERFORM 1 FROM public.businesses AS b WHERE b.id = v_business_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'business_not_found';
    END IF;
    SELECT sp.* INTO v_relation FROM public.service_partners AS sp
    WHERE sp.id = p_service_partner_id AND sp.business_id = v_business_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'service_partner_not_found';
    END IF;
    IF EXISTS (SELECT 1 FROM public.tickets AS t
        WHERE t.business_id = v_business_id
          AND t.assigned_partner_organization_id = v_relation.partner_organization_id) THEN
        RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'partner_has_assigned_tickets';
    END IF;
    DELETE FROM public.service_partners
    WHERE id = p_service_partner_id AND business_id = v_business_id;
    PERFORM audit.append_access_log(p_action => '파트너 연결 해제', p_target_type => 'Business',
        p_target_id => v_business_id::text,
        p_metadata => pg_catalog.jsonb_build_object('service_partner_id', p_service_partner_id,
            'business_id', v_business_id, 'partner_organization_id', v_relation.partner_organization_id,
            'old_access_level', v_relation.access_level));
    RETURN pg_catalog.jsonb_build_object('id', p_service_partner_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_business(p_business_id uuid, p_name text, p_description text, p_is_active boolean, p_expected_updated_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_before public.businesses%ROWTYPE;
    v_now timestamptz;
BEGIN
    v_actor := private.require_company_actor(ARRAY['admin','operator']::text[]);
    IF p_name IS NULL OR p_name !~ '[^[:space:]]' OR p_is_active IS NULL
       OR p_expected_updated_at IS NULL THEN
        RAISE EXCEPTION 'invalid_business_input' USING ERRCODE = '22023';
    END IF;
    SELECT b.* INTO v_before FROM public.businesses b WHERE b.id = p_business_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'business_not_found' USING ERRCODE = 'P0002'; END IF;
    IF v_before.updated_at <> p_expected_updated_at THEN
        RAISE EXCEPTION 'business_version_conflict' USING ERRCODE = '40001';
    END IF;
    v_now := pg_catalog.clock_timestamp();
    UPDATE public.businesses SET name = pg_catalog.btrim(p_name), description = p_description,
        is_active = p_is_active, updated_at = v_now WHERE id = p_business_id;
    PERFORM audit.append_access_log(p_action => '비즈니스 수정', p_target_type => 'Business',
        p_target_id => p_business_id::text, p_metadata => pg_catalog.jsonb_build_object(
            'business_id',p_business_id,'old_is_active',v_before.is_active,'is_active',p_is_active,
            'fields',pg_catalog.jsonb_build_array('name','description','is_active')));
    RETURN pg_catalog.jsonb_build_object('id',p_business_id,'updated_at',v_now);
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_service_partner_terms(p_service_partner_id uuid, p_role_description text, p_sla_response_hours numeric, p_sla_resolution_hours numeric, p_expected_updated_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_business_id uuid;
    v_before public.service_partners%ROWTYPE;
    v_now timestamptz;
BEGIN
    v_actor := private.require_company_actor(ARRAY['admin']::text[]);
    IF p_expected_updated_at IS NULL OR p_sla_response_hours IS NULL OR p_sla_resolution_hours IS NULL
       OR p_sla_response_hours < 0 OR p_sla_resolution_hours < 0
       OR p_sla_response_hours::text IN ('NaN','Infinity','-Infinity')
       OR p_sla_resolution_hours::text IN ('NaN','Infinity','-Infinity') THEN
        RAISE EXCEPTION 'invalid_sla_hours' USING ERRCODE = '22023';
    END IF;
    SELECT sp.business_id INTO v_business_id FROM public.service_partners sp WHERE sp.id = p_service_partner_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'service_partner_not_found' USING ERRCODE = 'P0002'; END IF;
    PERFORM 1 FROM public.businesses b WHERE b.id = v_business_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'business_not_found' USING ERRCODE = 'P0002'; END IF;
    SELECT sp.* INTO v_before FROM public.service_partners sp
        WHERE sp.id = p_service_partner_id AND sp.business_id = v_business_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'service_partner_not_found' USING ERRCODE = 'P0002'; END IF;
    IF v_before.updated_at <> p_expected_updated_at THEN
        RAISE EXCEPTION 'service_partner_version_conflict' USING ERRCODE = '40001';
    END IF;
    v_now := pg_catalog.clock_timestamp();
    UPDATE public.service_partners SET role_description = p_role_description,
        sla_response_hours = p_sla_response_hours, sla_resolution_hours = p_sla_resolution_hours,
        updated_at = v_now WHERE id = p_service_partner_id AND business_id = v_business_id;
    PERFORM audit.append_access_log(p_action => '파트너 역할/SLA 수정',p_target_type => 'Business',
        p_target_id => v_business_id::text,p_metadata => pg_catalog.jsonb_build_object(
            'service_partner_id',p_service_partner_id,'business_id',v_business_id,
            'old_response_hours',v_before.sla_response_hours,'response_hours',p_sla_response_hours,
            'old_resolution_hours',v_before.sla_resolution_hours,'resolution_hours',p_sla_resolution_hours));
    RETURN pg_catalog.jsonb_build_object('id',p_service_partner_id,'updated_at',v_now);
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_partner(p_partner_organization_id uuid, p_name text, p_partner_type text, p_contact_name text DEFAULT NULL::text, p_contact_email text DEFAULT NULL::text, p_contact_phone text DEFAULT NULL::text, p_description text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    IF NOT public.can_manage_organization(p_partner_organization_id) THEN
        RAISE EXCEPTION 'organization_management_forbidden' USING ERRCODE='42501';
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
$function$;

CREATE OR REPLACE FUNCTION public.read_admin_audit(p_kind text, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_rows jsonb;
BEGIN
    PERFORM private.require_request_app_session(false);
    IF NOT public.is_company_admin() THEN
        RAISE EXCEPTION 'role_not_allowed' USING ERRCODE = '42501';
    END IF;
    IF p_offset IS NULL OR p_offset < 0 OR p_offset > 1000000 THEN
        RAISE EXCEPTION 'invalid_offset' USING ERRCODE = '22023';
    END IF;
    CASE p_kind
      WHEN 'access' THEN SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(q)),'[]'::jsonb) INTO v_rows
        FROM (SELECT id,accessed_at,user_name,user_role,action,target_type,target_id,detail,seq
            FROM audit.access_logs ORDER BY accessed_at DESC,id DESC LIMIT 100 OFFSET p_offset) q;
      WHEN 'role' THEN SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(q)),'[]'::jsonb) INTO v_rows
        FROM (SELECT id,changed_at,target_profile_id,role_before,role_after,affiliation_before,affiliation_after,actor_role
            FROM audit.role_change_logs ORDER BY changed_at DESC,id DESC LIMIT 100 OFFSET p_offset) q;
      WHEN 'deletion' THEN SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(q)),'[]'::jsonb) INTO v_rows
        FROM (SELECT id,created_at,entity_type,method,count,reason,triggered_by
            FROM audit.data_deletion_logs ORDER BY created_at DESC,id DESC LIMIT 100 OFFSET p_offset) q;
      ELSE RAISE EXCEPTION 'invalid_audit_kind' USING ERRCODE = '22023';
    END CASE;
    RETURN pg_catalog.jsonb_build_object('rows',v_rows);
END;
$function$;

CREATE OR REPLACE FUNCTION private.protect_last_active_admin(p_before public.profiles, p_after_role text, p_after_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
    IF p_before.role = 'admin' AND p_before.account_status = 'active'
       AND EXISTS(SELECT 1 FROM public.organizations o WHERE o.id=p_before.organization_id AND o.type='operator'
           AND o.is_active AND o.id<>'10a8e084-c396-4a97-b301-c4ef4aa59d71')
       AND (p_after_role <> 'admin' OR p_after_status <> 'active')
       AND NOT EXISTS (
           SELECT 1 FROM public.profiles AS p
           JOIN public.organizations AS o ON o.id = p.organization_id
           WHERE p.id <> p_before.id AND p.role = 'admin'
             AND p.account_status = 'active' AND p.auth_user_id IS NOT NULL
             AND o.is_active AND o.type = 'operator' AND o.id<>'10a8e084-c396-4a97-b301-c4ef4aa59d71'
       ) THEN
        RAISE EXCEPTION 'last_active_admin_protected' USING ERRCODE = '42501';
    END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION private.apply_profile_role_organization(p_profile_id uuid, p_role text, p_organization_id uuid, p_role_request_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    IF NOT public.can_manage_organization(v_before.organization_id)
       OR NOT public.can_manage_organization(p_organization_id) THEN
        RAISE EXCEPTION 'organization_management_forbidden' USING ERRCODE='42501';
    END IF;
    v_org := private.validate_profile_role_organization(p_role, p_organization_id);
    IF p_role_request_id IS NULL AND v_before.role = p_role
       AND v_before.organization_id = p_organization_id THEN
        RAISE EXCEPTION 'profile_access_unchanged' USING ERRCODE = '22023';
    END IF;
    -- Moving a Company admin to any other organization is loss of global authority.
    PERFORM private.protect_last_active_admin(v_before,
        CASE WHEN v_org.type='operator' THEN p_role ELSE 'guest' END, v_before.account_status);
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
$function$;

CREATE OR REPLACE FUNCTION public.deactivate_profile(p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    IF NOT public.can_manage_organization(v_target.organization_id) THEN
        RAISE EXCEPTION 'organization_management_forbidden' USING ERRCODE='42501';
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
$function$;

CREATE OR REPLACE FUNCTION public.reactivate_profile(p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_target public.profiles%ROWTYPE;
BEGIN
    v_actor := private.require_user_role_admin();
    SELECT p.* INTO v_target FROM public.profiles AS p WHERE p.id = p_profile_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'profile_not_found';
    END IF;
    IF NOT public.can_manage_organization(v_target.organization_id) THEN
        RAISE EXCEPTION 'organization_management_forbidden' USING ERRCODE='42501';
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
$function$;

CREATE OR REPLACE FUNCTION public.reject_role_request(p_role_request_id uuid, p_admin_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    IF NOT public.can_manage_organization(v_request.current_organization_id)
       OR NOT public.can_manage_organization(v_request.requested_organization_id) THEN
        RAISE EXCEPTION 'organization_management_forbidden' USING ERRCODE='42501';
    END IF;
    PERFORM 1 FROM public.profiles p WHERE p.id=v_request.requester_profile_id
      AND public.can_manage_organization(p.organization_id) FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'organization_management_forbidden' USING ERRCODE='42501'; END IF;
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
$function$;

CREATE OR REPLACE FUNCTION public.approve_role_request(p_role_request_id uuid, p_organization_id uuid DEFAULT NULL::uuid, p_admin_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    -- Preserve legacy request rows, canonicalize only the applied internal role.
    IF v_request.requested_role='partner_admin' THEN v_request.requested_role:='admin'; END IF;
    IF v_request.requested_role NOT IN ('operator', 'admin') THEN
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
    IF v_request.requested_org_type IS NOT NULL
   AND v_request.requested_org_type <> (
       CASE
           WHEN v_org.type = 'operator' THEN 'operator_company'
           ELSE 'partner'
       END
   )
THEN
    RAISE EXCEPTION 'requested_organization_type_mismatch'
        USING ERRCODE = '22023';
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
$function$;

CREATE OR REPLACE FUNCTION public.submit_role_request(p_requested_role text, p_requested_organization_id uuid, p_justification text, p_consent_agreed boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    IF p_requested_role IS NULL OR p_requested_role NOT IN ('operator', 'admin') THEN
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
$function$;

CREATE OR REPLACE FUNCTION public.mark_notifications_read(p_notification_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_actor public.profiles%ROWTYPE; v_count bigint;
BEGIN
    v_actor := private.require_management_actor(ARRAY['admin','operator']::text[]);
    UPDATE public.notifications SET is_read = true,read_at = pg_catalog.clock_timestamp()
        WHERE recipient_profile_id = v_actor.id AND NOT is_read AND (ticket_id IS NULL OR public.can_access_ticket(ticket_id))
          AND (p_notification_id IS NULL OR id = p_notification_id);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    PERFORM audit.append_access_log(p_action => '알림 읽음 처리',p_target_type => 'Notification',
        p_target_id => p_notification_id::text,p_metadata => pg_catalog.jsonb_build_object('count',v_count));
    RETURN pg_catalog.jsonb_build_object('count',v_count);
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_my_profile(p_full_name text, p_display_name text, p_job_title text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_actor public.profiles%ROWTYPE;
BEGIN
    v_actor := private.require_management_actor(ARRAY['admin','operator','guest']::text[]);
    IF pg_catalog.char_length(p_full_name) > 200 OR pg_catalog.char_length(p_display_name) > 200
       OR pg_catalog.char_length(p_job_title) > 200 THEN
        RAISE EXCEPTION 'profile_field_too_long' USING ERRCODE = '22023';
    END IF;
    UPDATE public.profiles SET full_name = NULLIF(pg_catalog.btrim(p_full_name),''),
        display_name = NULLIF(pg_catalog.btrim(p_display_name),''),job_title = NULLIF(pg_catalog.btrim(p_job_title),''),
        updated_at = pg_catalog.clock_timestamp() WHERE id = v_actor.id;
    PERFORM audit.append_access_log(p_action => '내 프로필 수정',p_target_type => 'Profile',
        p_target_id => v_actor.id::text,p_metadata => pg_catalog.jsonb_build_object(
            'fields',pg_catalog.jsonb_build_array('full_name','display_name','job_title')));
    RETURN pg_catalog.jsonb_build_object('id',v_actor.id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_ticket(p_business_id uuid, p_title text DEFAULT NULL::text, p_description text DEFAULT NULL::text, p_request_type text DEFAULT NULL::text, p_request_detail text DEFAULT NULL::text, p_priority text DEFAULT 'normal'::text, p_customer_name text DEFAULT NULL::text, p_customer_company text DEFAULT NULL::text, p_customer_contact text DEFAULT NULL::text, p_address text DEFAULT NULL::text, p_address_detail text DEFAULT NULL::text, p_assigned_partner_organization_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    IF v_actor.role NOT IN ('admin', 'operator') THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'role_not_allowed';
    END IF;
    IF v_actor.account_status IN ('suspended', 'disabled') THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'account_unavailable';
    END IF;

    PERFORM 1 FROM public.businesses AS b WHERE b.id = p_business_id FOR KEY SHARE;
    IF NOT FOUND OR NOT public.can_access_business(p_business_id) THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'business_not_found_or_forbidden';
    END IF;

    -- Service partners cannot manufacture assignments by creating their own tickets.
    IF NOT public.is_company_member() AND NOT EXISTS(SELECT 1 FROM public.service_partners sp
       WHERE sp.business_id=p_business_id AND sp.partner_organization_id=v_actor.organization_id AND sp.access_level='business') THEN
        RAISE EXCEPTION 'business_partner_access_required' USING ERRCODE='42501';
    END IF;
    v_partner_id := p_assigned_partner_organization_id;
    IF NOT public.is_company_member() THEN
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
$function$;

CREATE OR REPLACE FUNCTION public.change_ticket_status(p_ticket_id uuid, p_status text, p_expected_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    IF v_actor.role NOT IN ('admin', 'operator') THEN
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
    IF NOT public.is_company_member() THEN
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
$function$;

CREATE OR REPLACE FUNCTION public.add_ticket_activity(p_ticket_id uuid, p_type text, p_content text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    IF v_actor.role NOT IN ('admin', 'operator') THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'role_not_allowed';
    END IF;
    IF v_actor.account_status IN ('suspended', 'disabled') THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'account_unavailable';
    END IF;
    IF p_type IS NULL OR p_type NOT IN ('comment', 'note') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_activity_type';
    END IF;
    IF p_type = 'note' AND NOT public.is_company_member() THEN
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
    IF NOT public.is_company_member() THEN
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
$function$;

CREATE OR REPLACE FUNCTION public.change_ticket_assignment(p_ticket_id uuid, p_assigned_partner_organization_id uuid, p_expected_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    IF NOT public.is_company_member() THEN
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
$function$;

CREATE OR REPLACE FUNCTION private.lock_mutable_operator_ticket(p_ticket_id uuid, p_expected_version integer)
 RETURNS public.tickets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_ticket public.tickets%ROWTYPE;
BEGIN
    v_actor := private.require_management_actor(ARRAY['admin','operator']::text[]);
    IF p_expected_version IS NULL OR p_expected_version <= 0 THEN
        RAISE EXCEPTION 'invalid_expected_version' USING ERRCODE = '22023';
    END IF;
    IF NOT public.can_access_ticket(p_ticket_id) THEN
        RAISE EXCEPTION 'ticket_not_found_or_forbidden' USING ERRCODE = 'P0002';
    END IF;
    SELECT t.* INTO v_ticket FROM public.tickets t WHERE t.id = p_ticket_id FOR UPDATE;
    IF NOT FOUND OR NOT public.can_access_ticket(p_ticket_id) THEN
        RAISE EXCEPTION 'ticket_not_found_or_forbidden' USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.is_company_member() THEN
        PERFORM 1 FROM public.service_partners sp WHERE sp.business_id=v_ticket.business_id
            AND sp.partner_organization_id=v_actor.organization_id FOR SHARE;
        IF NOT FOUND OR NOT public.can_access_ticket(p_ticket_id) THEN
            RAISE EXCEPTION 'ticket_not_found_or_forbidden' USING ERRCODE='P0002';
        END IF;
    END IF;
    IF v_ticket.retention_state = 'anonymized' THEN
        RAISE EXCEPTION 'ticket_anonymized_read_only' USING ERRCODE = '55000';
    END IF;
    IF v_ticket.version <> p_expected_version THEN
        RAISE EXCEPTION 'ticket_version_conflict' USING ERRCODE = '40001';
    END IF;
    RETURN v_ticket;
END;
$function$;

CREATE OR REPLACE FUNCTION public.change_ticket_operator(p_ticket_id uuid, p_assign_to_me boolean, p_expected_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_ticket public.tickets%ROWTYPE;
    v_old_operator uuid;
    v_name text;
BEGIN
    v_actor := private.require_management_actor(ARRAY['admin','operator']::text[]);
    v_ticket := private.lock_mutable_operator_ticket(p_ticket_id,p_expected_version);
    IF p_assign_to_me IS NULL THEN RAISE EXCEPTION 'invalid_assignment' USING ERRCODE = '22023'; END IF;
    -- Operators may claim unassigned work, or release their own assignment.
    -- Admins may explicitly take over/release another operator's assignment.
    IF v_ticket.operator_profile_id IS NOT NULL AND v_ticket.operator_profile_id <> v_actor.id
       AND NOT (public.is_company_admin() OR (v_actor.role='admin' AND EXISTS(
           SELECT 1 FROM public.profiles p WHERE p.id=v_ticket.operator_profile_id AND p.organization_id=v_actor.organization_id))) THEN
        RAISE EXCEPTION 'operator_already_assigned' USING ERRCODE = '42501';
    END IF;
    IF (p_assign_to_me AND v_ticket.operator_profile_id = v_actor.id)
       OR (NOT p_assign_to_me AND v_ticket.operator_profile_id IS NULL) THEN
        RAISE EXCEPTION 'assignment_unchanged' USING ERRCODE = '22023';
    END IF;
    v_old_operator := v_ticket.operator_profile_id;
    v_name := CASE WHEN p_assign_to_me THEN
        COALESCE(NULLIF(v_actor.display_name,''),NULLIF(v_actor.full_name,''),v_actor.email) ELSE NULL END;
    UPDATE public.tickets SET operator_profile_id = CASE WHEN p_assign_to_me THEN v_actor.id ELSE NULL END,
        operator_name_snapshot = v_name,version = version + 1,updated_at = pg_catalog.clock_timestamp()
        WHERE id = p_ticket_id RETURNING * INTO v_ticket;
    INSERT INTO public.activities(ticket_id,actor_profile_id,actor_name_snapshot,actor_role_snapshot,
        type,content,is_internal,meta)
    VALUES(p_ticket_id,v_actor.id,COALESCE(NULLIF(v_actor.display_name,''),NULLIF(v_actor.full_name,''),v_actor.email),
        v_actor.role,'assignment',CASE WHEN p_assign_to_me THEN '담당자 배정: '||v_name ELSE '담당자 배정 해제' END,
        false,pg_catalog.jsonb_build_object('old_operator_profile_id',v_old_operator,
            'operator_profile_id',v_ticket.operator_profile_id,'old_version',p_expected_version,'new_version',v_ticket.version));
    PERFORM audit.append_access_log(p_action => '티켓 담당자 변경',p_target_type => 'Ticket',
        p_target_id => p_ticket_id::text,p_metadata => pg_catalog.jsonb_build_object(
            'old_operator_profile_id',v_old_operator,'operator_profile_id',v_ticket.operator_profile_id,
            'old_version',p_expected_version,'new_version',v_ticket.version));
    RETURN pg_catalog.jsonb_build_object('id',v_ticket.id,'version',v_ticket.version,
        'operator_profile_id',v_ticket.operator_profile_id,'operator_name_snapshot',v_ticket.operator_name_snapshot);
END;
$function$;

DROP POLICY profiles_select_own ON public.profiles;
CREATE POLICY profiles_select_own ON public.profiles FOR SELECT TO authenticated USING(auth.uid()=auth_user_id);

DROP POLICY profiles_select_admin ON public.profiles;
CREATE POLICY profiles_select_admin ON public.profiles FOR SELECT TO authenticated USING(public.can_manage_organization(organization_id));

DROP POLICY businesses_select_authorized ON public.businesses;
CREATE POLICY businesses_select_authorized ON public.businesses FOR SELECT TO authenticated USING(public.can_access_business(id));

DROP POLICY tickets_select_authorized ON public.tickets;
CREATE POLICY tickets_select_authorized ON public.tickets FOR SELECT TO authenticated USING(public.can_access_ticket(id));

DROP POLICY ticket_attachments_select_authorized ON public.ticket_attachments;
CREATE POLICY ticket_attachments_select_authorized ON public.ticket_attachments FOR SELECT TO authenticated USING(public.can_access_ticket(ticket_id));

DROP POLICY organizations_select_authorized ON public.organizations;
CREATE POLICY organizations_select_authorized ON public.organizations FOR SELECT TO authenticated USING(id=public.current_organization_id() OR public.is_company_admin() OR (public.is_company_member() AND type='partner'));

DROP POLICY partner_details_select_authorized ON public.partner_details;
CREATE POLICY partner_details_select_authorized ON public.partner_details FOR SELECT TO authenticated USING(public.is_company_member() OR (public.current_profile_role() IN ('admin','operator') AND organization_id=public.current_organization_id()));

DROP POLICY service_partners_select_authorized ON public.service_partners;
CREATE POLICY service_partners_select_authorized ON public.service_partners FOR SELECT TO authenticated USING(public.is_company_member() OR (public.current_profile_role() IN ('admin','operator') AND public.current_organization_type()='partner' AND partner_organization_id=public.current_organization_id()));

DROP POLICY activities_select_authorized ON public.activities;
CREATE POLICY activities_select_authorized ON public.activities FOR SELECT TO authenticated USING(public.can_access_ticket(ticket_id) AND (public.is_company_member() OR (NOT is_internal AND type NOT IN ('note','view'))));

DROP POLICY notifications_select_admin_or_own ON public.notifications;
CREATE POLICY notifications_select_admin_or_own ON public.notifications FOR SELECT TO authenticated USING(recipient_profile_id=public.current_profile_id() AND (ticket_id IS NULL OR public.can_access_ticket(ticket_id)));

DROP POLICY role_requests_select_admin_or_own ON public.role_requests;
CREATE POLICY role_requests_select_admin_or_own ON public.role_requests FOR SELECT TO authenticated USING(requester_profile_id=public.current_profile_id() OR (public.can_manage_organization(current_organization_id) AND public.can_manage_organization(requested_organization_id) AND EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=requester_profile_id AND public.can_manage_organization(p.organization_id))));

DROP POLICY privacy_consents_select_admin_or_own ON public.privacy_consents;
CREATE POLICY privacy_consents_select_admin_or_own ON public.privacy_consents FOR SELECT TO authenticated USING(profile_id=public.current_profile_id() OR public.can_manage_organization(organization_id));

DROP POLICY system_settings_select_admin ON public.system_settings;
CREATE POLICY system_settings_select_admin ON public.system_settings FOR SELECT TO authenticated USING(public.is_company_admin());

DROP POLICY ip_whitelist_select_admin ON public.ip_whitelist;
CREATE POLICY ip_whitelist_select_admin ON public.ip_whitelist FOR SELECT TO authenticated USING(public.is_company_admin());

DROP POLICY profiles_select_app_session_gate ON public.profiles;
CREATE POLICY profiles_select_app_session_gate ON public.profiles AS RESTRICTIVE FOR SELECT TO authenticated USING((SELECT public.has_valid_app_session()));

DROP POLICY businesses_select_app_session_gate ON public.businesses;
CREATE POLICY businesses_select_app_session_gate ON public.businesses AS RESTRICTIVE FOR SELECT TO authenticated USING((SELECT public.has_valid_app_session()));

DROP POLICY tickets_select_app_session_gate ON public.tickets;
CREATE POLICY tickets_select_app_session_gate ON public.tickets AS RESTRICTIVE FOR SELECT TO authenticated USING((SELECT public.has_valid_app_session()));

DROP POLICY ticket_attachments_select_app_session_gate ON public.ticket_attachments;
CREATE POLICY ticket_attachments_select_app_session_gate ON public.ticket_attachments AS RESTRICTIVE FOR SELECT TO authenticated USING((SELECT public.has_valid_app_session()));

DROP POLICY organizations_select_app_session_gate ON public.organizations;
CREATE POLICY organizations_select_app_session_gate ON public.organizations AS RESTRICTIVE FOR SELECT TO authenticated USING((SELECT public.has_valid_app_session()));

DROP POLICY partner_details_select_app_session_gate ON public.partner_details;
CREATE POLICY partner_details_select_app_session_gate ON public.partner_details AS RESTRICTIVE FOR SELECT TO authenticated USING((SELECT public.has_valid_app_session()));

DROP POLICY service_partners_select_app_session_gate ON public.service_partners;
CREATE POLICY service_partners_select_app_session_gate ON public.service_partners AS RESTRICTIVE FOR SELECT TO authenticated USING((SELECT public.has_valid_app_session()));

DROP POLICY activities_select_app_session_gate ON public.activities;
CREATE POLICY activities_select_app_session_gate ON public.activities AS RESTRICTIVE FOR SELECT TO authenticated USING((SELECT public.has_valid_app_session()));

DROP POLICY notifications_select_app_session_gate ON public.notifications;
CREATE POLICY notifications_select_app_session_gate ON public.notifications AS RESTRICTIVE FOR SELECT TO authenticated USING((SELECT public.has_valid_app_session()));

DROP POLICY role_requests_select_app_session_gate ON public.role_requests;
CREATE POLICY role_requests_select_app_session_gate ON public.role_requests AS RESTRICTIVE FOR SELECT TO authenticated USING((SELECT public.has_valid_app_session()));

DROP POLICY privacy_consents_select_app_session_gate ON public.privacy_consents;
CREATE POLICY privacy_consents_select_app_session_gate ON public.privacy_consents AS RESTRICTIVE FOR SELECT TO authenticated USING((SELECT public.has_valid_app_session()));

DROP POLICY system_settings_select_app_session_gate ON public.system_settings;
CREATE POLICY system_settings_select_app_session_gate ON public.system_settings AS RESTRICTIVE FOR SELECT TO authenticated USING((SELECT public.has_valid_app_session()));

DROP POLICY ip_whitelist_select_app_session_gate ON public.ip_whitelist;
CREATE POLICY ip_whitelist_select_app_session_gate ON public.ip_whitelist AS RESTRICTIVE FOR SELECT TO authenticated USING((SELECT public.has_valid_app_session()));

ALTER FUNCTION public.current_organization_type() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.current_organization_type() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.current_organization_type() TO authenticated;

ALTER FUNCTION public.is_company_member() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_company_member() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.is_company_member() TO authenticated;

ALTER FUNCTION public.is_company_admin() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_company_admin() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.is_company_admin() TO authenticated;

ALTER FUNCTION public.can_manage_organization(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.can_manage_organization(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.can_manage_organization(uuid) TO authenticated;

ALTER FUNCTION private.require_company_actor(text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.require_company_actor(text[]) FROM PUBLIC,anon,authenticated,service_role;

-- Require a usable global administrator after the canonical role conversion.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.profiles p JOIN public.organizations o ON o.id=p.organization_id
  WHERE p.role='admin' AND p.account_status='active' AND p.auth_user_id IS NOT NULL
  AND o.type='operator' AND o.is_active AND o.id<>'10a8e084-c396-4a97-b301-c4ef4aa59d71') THEN
  RAISE EXCEPTION 'active_company_admin_required'; END IF;
END $$;
COMMIT;
