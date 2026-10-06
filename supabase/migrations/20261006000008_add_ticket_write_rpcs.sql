BEGIN;

-- No direct-write policies, audit inserts or session/IP enforcement are added.
CREATE FUNCTION public.create_ticket(
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

    RETURN pg_catalog.jsonb_build_object('id', v_ticket.id, 'status', v_ticket.status,
        'version', v_ticket.version, 'assigned_partner_organization_id', v_partner_id);
END;
$$;

CREATE FUNCTION public.change_ticket_status(
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
    RETURN pg_catalog.jsonb_build_object('id', v_ticket.id, 'status', v_ticket.status,
        'version', v_ticket.version, 'resolved_at', v_ticket.resolved_at);
END;
$$;

ALTER FUNCTION public.create_ticket(uuid, text, text, text, text, text, text, text, text, text, text, uuid)
    OWNER TO postgres;
ALTER FUNCTION public.change_ticket_status(uuid, text, integer) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.create_ticket(uuid, text, text, text, text, text, text, text, text, text, text, uuid)
    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.change_ticket_status(uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_ticket(uuid, text, text, text, text, text, text, text, text, text, text, uuid)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.change_ticket_status(uuid, text, integer) TO authenticated;

COMMIT;
