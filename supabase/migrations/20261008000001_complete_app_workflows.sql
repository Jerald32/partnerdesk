BEGIN;

-- Extend the existing session/role/audit boundary; no table grants or auth changes.
CREATE OR REPLACE FUNCTION public.update_business(
    p_business_id uuid, p_name text, p_description text, p_is_active boolean,
    p_expected_updated_at timestamptz
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_before public.businesses%ROWTYPE;
    v_now timestamptz;
BEGIN
    v_actor := private.require_management_actor(ARRAY['admin','operator']::text[]);
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
$$;

CREATE OR REPLACE FUNCTION public.update_service_partner_terms(
    p_service_partner_id uuid, p_role_description text,
    p_sla_response_hours numeric, p_sla_resolution_hours numeric,
    p_expected_updated_at timestamptz
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_business_id uuid;
    v_before public.service_partners%ROWTYPE;
    v_now timestamptz;
BEGIN
    v_actor := private.require_management_actor(ARRAY['admin','operator']::text[]);
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
$$;

-- Internal helper, executable only by trusted RPC owners.
CREATE OR REPLACE FUNCTION private.lock_mutable_operator_ticket(p_ticket_id uuid,p_expected_version integer)
RETURNS public.tickets LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
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
    IF v_ticket.retention_state = 'anonymized' THEN
        RAISE EXCEPTION 'ticket_anonymized_read_only' USING ERRCODE = '55000';
    END IF;
    IF v_ticket.version <> p_expected_version THEN
        RAISE EXCEPTION 'ticket_version_conflict' USING ERRCODE = '40001';
    END IF;
    RETURN v_ticket;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_ticket_address(
    p_ticket_id uuid,p_address text,p_address_detail text,p_expected_version integer
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_ticket public.tickets%ROWTYPE;
BEGIN
    v_ticket := private.lock_mutable_operator_ticket(p_ticket_id,p_expected_version);
    IF pg_catalog.char_length(p_address) > 200 OR pg_catalog.char_length(p_address_detail) > 200 THEN
        RAISE EXCEPTION 'address_too_long' USING ERRCODE = '22023';
    END IF;
    UPDATE public.tickets SET address = NULLIF(pg_catalog.btrim(p_address),''),
        address_detail = NULLIF(pg_catalog.btrim(p_address_detail),''),version = version + 1,
        updated_at = pg_catalog.clock_timestamp() WHERE id = p_ticket_id RETURNING * INTO v_ticket;
    -- Never put address/PII values into audit metadata.
    PERFORM audit.append_access_log(p_action => '티켓 주소 수정',p_target_type => 'Ticket',
        p_target_id => p_ticket_id::text,p_metadata => pg_catalog.jsonb_build_object(
            'ticket_id',p_ticket_id,'old_version',p_expected_version,'new_version',v_ticket.version));
    RETURN pg_catalog.jsonb_build_object('id',v_ticket.id,'version',v_ticket.version,
        'address',v_ticket.address,'address_detail',v_ticket.address_detail);
END;
$$;

CREATE OR REPLACE FUNCTION public.change_ticket_operator(
    p_ticket_id uuid,p_assign_to_me boolean,p_expected_version integer
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
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
       AND v_actor.role <> 'admin' THEN
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
$$;

CREATE OR REPLACE FUNCTION public.update_my_profile(p_full_name text,p_display_name text,p_job_title text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_actor public.profiles%ROWTYPE;
BEGIN
    v_actor := private.require_management_actor(ARRAY['admin','operator','partner_admin','guest']::text[]);
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
$$;

CREATE OR REPLACE FUNCTION public.mark_notifications_read(p_notification_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_actor public.profiles%ROWTYPE; v_count bigint;
BEGIN
    v_actor := private.require_management_actor(ARRAY['admin','operator','partner_admin']::text[]);
    UPDATE public.notifications SET is_read = true,read_at = pg_catalog.clock_timestamp()
        WHERE recipient_profile_id = v_actor.id AND NOT is_read
          AND (p_notification_id IS NULL OR id = p_notification_id);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    PERFORM audit.append_access_log(p_action => '알림 읽음 처리',p_target_type => 'Notification',
        p_target_id => p_notification_id::text,p_metadata => pg_catalog.jsonb_build_object('count',v_count));
    RETURN pg_catalog.jsonb_build_object('count',v_count);
END;
$$;

-- Read-only bounded access to private audit storage. Never expose the audit schema.
CREATE OR REPLACE FUNCTION public.read_admin_audit(p_kind text,p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_rows jsonb;
BEGIN
    PERFORM private.require_request_app_session(false);
    IF public.current_profile_role() IS DISTINCT FROM 'admin' THEN
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
$$;

ALTER FUNCTION private.lock_mutable_operator_ticket(uuid,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.lock_mutable_operator_ticket(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION public.update_business(uuid,text,text,boolean,timestamptz) OWNER TO postgres;
ALTER FUNCTION public.update_service_partner_terms(uuid,text,numeric,numeric,timestamptz) OWNER TO postgres;
ALTER FUNCTION public.update_ticket_address(uuid,text,text,integer) OWNER TO postgres;
ALTER FUNCTION public.change_ticket_operator(uuid,boolean,integer) OWNER TO postgres;
ALTER FUNCTION public.update_my_profile(text,text,text) OWNER TO postgres;
ALTER FUNCTION public.mark_notifications_read(uuid) OWNER TO postgres;
ALTER FUNCTION public.read_admin_audit(text,integer) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.update_business(uuid,text,text,boolean,timestamptz) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.update_service_partner_terms(uuid,text,numeric,numeric,timestamptz) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.update_ticket_address(uuid,text,text,integer) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.change_ticket_operator(uuid,boolean,integer) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.update_my_profile(text,text,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.mark_notifications_read(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.read_admin_audit(text,integer) FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION public.update_business(uuid,text,text,boolean,timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_service_partner_terms(uuid,text,numeric,numeric,timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_ticket_address(uuid,text,text,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.change_ticket_operator(uuid,boolean,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_my_profile(text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_notifications_read(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.read_admin_audit(text,integer) TO authenticated;

COMMIT;
