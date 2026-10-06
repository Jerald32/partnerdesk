BEGIN;

-- Only comment/note creation; Ticket fields and version remain unchanged.
CREATE FUNCTION public.add_ticket_activity(
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

    INSERT INTO public.activities (
        ticket_id, actor_profile_id, actor_name_snapshot, actor_role_snapshot,
        type, content, is_internal, created_at
    ) VALUES (
        v_ticket.id, v_actor.id,
        COALESCE(NULLIF(v_actor.display_name, ''), NULLIF(v_actor.full_name, ''), v_actor.email),
        v_actor.role, p_type, v_content, p_type = 'note', pg_catalog.clock_timestamp()
    ) RETURNING * INTO v_activity;

    RETURN pg_catalog.jsonb_build_object('id', v_activity.id, 'ticket_id', v_activity.ticket_id,
        'type', v_activity.type, 'is_internal', v_activity.is_internal,
        'created_at', v_activity.created_at);
END;
$$;

CREATE FUNCTION public.change_ticket_assignment(
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

    RETURN pg_catalog.jsonb_build_object('id', v_ticket.id,
        'assigned_partner_organization_id', v_ticket.assigned_partner_organization_id,
        'version', v_ticket.version, 'updated_at', v_ticket.updated_at);
END;
$$;

ALTER FUNCTION public.add_ticket_activity(uuid, text, text) OWNER TO postgres;
ALTER FUNCTION public.change_ticket_assignment(uuid, uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.add_ticket_activity(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.change_ticket_assignment(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_ticket_activity(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.change_ticket_assignment(uuid, uuid, integer) TO authenticated;

COMMIT;
