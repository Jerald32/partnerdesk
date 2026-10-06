BEGIN;

-- Preserve existing authoritative values, including blank values (fail closed).
INSERT INTO public.system_settings (key, value)
VALUES ('privacy_pledge_version', 'v1.0') ON CONFLICT (key) DO NOTHING;

-- Guest can consent before role approval. No caller-supplied identity is accepted.
CREATE FUNCTION private.require_consent_profile()
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

CREATE FUNCTION public.get_privacy_consent_status()
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
SET timezone = 'UTC'
AS $$
DECLARE
    v_profile public.profiles%ROWTYPE;
    v_required_version text;
    v_consent public.privacy_consents%ROWTYPE;
    v_now timestamptz;
BEGIN
    v_profile := private.require_consent_profile();
    SELECT s.value INTO v_required_version FROM public.system_settings AS s
    WHERE s.key = 'privacy_pledge_version' FOR SHARE;
    IF v_required_version IS NULL OR v_required_version !~ '[^[:space:]]' THEN
        RETURN pg_catalog.jsonb_build_object('valid', false, 'reason', 'pledge_version_unavailable',
            'valid_until', NULL, 'required_pledge_version', NULL);
    END IF;
    v_now := pg_catalog.clock_timestamp();
    -- Select the latest matching history, never another profile or legacy NULL type.
    SELECT c.* INTO v_consent FROM public.privacy_consents AS c
    WHERE c.profile_id = v_profile.id AND c.organization_id = v_profile.organization_id
      AND c.consent_type = 'privacy_pledge' AND c.pledge_version = v_required_version
    ORDER BY c.consent_date DESC, c.created_at DESC, c.id DESC LIMIT 1;
    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('valid', false, 'reason', 'consent_required',
            'valid_until', NULL, 'required_pledge_version', v_required_version);
    END IF;
    IF NOT pg_catalog.isfinite(v_consent.consent_date) OR
       NOT pg_catalog.isfinite(v_consent.valid_until) OR v_consent.consent_date > v_now OR
       v_consent.valid_until <> (v_consent.consent_date + interval '1 year')::date THEN
        RETURN pg_catalog.jsonb_build_object('valid', false, 'reason', 'consent_dates_invalid',
            'valid_until', v_consent.valid_until, 'required_pledge_version', v_required_version);
    END IF;
    -- Inclusive expiration date, in a fixed UTC calendar; no browser dates.
    RETURN pg_catalog.jsonb_build_object('valid', CURRENT_DATE <= v_consent.valid_until,
        'reason', CASE WHEN CURRENT_DATE <= v_consent.valid_until THEN 'valid' ELSE 'consent_expired' END,
        'valid_until', v_consent.valid_until, 'required_pledge_version', v_required_version);
END;
$$;

CREATE FUNCTION public.record_privacy_consent(p_agreed boolean)
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

-- Keep only known, type-validated structural Activity values. No snapshots,
-- free text, unknown keys or arbitrary JSON survive. Legacy text is not parsed.
CREATE FUNCTION private.retained_activity_meta(p_type text, p_meta jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT COALESCE(pg_catalog.jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    FROM pg_catalog.jsonb_each(CASE WHEN pg_catalog.jsonb_typeof(p_meta) = 'object'
        THEN p_meta ELSE '{}'::jsonb END) AS e
    WHERE (p_type = 'status_change' AND e.key IN ('old_status', 'new_status')
        AND pg_catalog.jsonb_typeof(e.value) = 'string'
        AND e.value #>> '{}' IN ('new', 'inprogress', 'hold', 'done'))
       OR (p_type IN ('status_change', 'assignment') AND e.key IN ('old_version', 'new_version')
        AND pg_catalog.jsonb_typeof(e.value) = 'number'
        AND e.value::text ~ '^[1-9][0-9]{0,9}$')
       OR (p_type = 'assignment' AND e.key IN ('old_partner_organization_id', 'new_partner_organization_id')
        AND (e.value = 'null'::jsonb OR (pg_catalog.jsonb_typeof(e.value) = 'string'
            AND e.value #>> '{}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')));
$$;

-- Anonymized means this Ticket and its Activity/Notification scope only.
-- ticket_attachments and Storage are intentionally untouched, even if rows exist.
-- Cron contract: postgres calls this function once daily, looping bounded batches
-- in separate transactions until processed_count=0; inspect failed_count and retry.
-- A zero count may mean rows are temporarily locked by another worker.
CREATE FUNCTION private.process_ticket_retention(p_batch_size integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
SET timezone = 'UTC'
AS $$
DECLARE
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_ticket public.tickets%ROWTYPE;
    v_processed integer := 0;
    v_failed integer := 0;
    v_activities bigint := 0;
    v_notifications bigint := 0;
    v_activity_count bigint;
    v_notification_count bigint;
BEGIN
    IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 500 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_retention_batch_size';
    END IF;
    FOR v_ticket IN
        SELECT t.* FROM public.tickets AS t
        WHERE t.retention_state <> 'anonymized'
          AND t.created_at + interval '3 years' <= v_now
        ORDER BY t.created_at, t.id LIMIT p_batch_size FOR UPDATE SKIP LOCKED
    LOOP
        -- Each Ticket is atomic. A row-specific failure rolls back only this block,
        -- leaving other Tickets processable. No original values/errors are returned.
        BEGIN
            UPDATE public.activities AS a SET actor_profile_id = NULL,
                actor_name_snapshot = NULL, content = NULL, legacy_base44_id = NULL,
                actor_role_snapshot = CASE WHEN a.actor_role_snapshot IN
                    ('admin', 'operator', 'partner_admin', 'guest') THEN a.actor_role_snapshot ELSE NULL END,
                meta = private.retained_activity_meta(a.type, a.meta)
            WHERE a.ticket_id = v_ticket.id;
            GET DIAGNOSTICS v_activity_count = ROW_COUNT;
            DELETE FROM public.notifications AS n WHERE n.ticket_id = v_ticket.id;
            GET DIAGNOSTICS v_notification_count = ROW_COUNT;
            UPDATE public.tickets SET title = '[anonymized]', description = NULL,
                request_detail = NULL, customer_name = NULL, customer_company = NULL,
                customer_contact = NULL, address = NULL, address_detail = NULL,
                operator_profile_id = NULL, operator_name_snapshot = NULL,
                created_by_profile_id = NULL, legacy_base44_id = NULL,
                retention_state = 'anonymized', retention_processed_at = v_now
            WHERE id = v_ticket.id;
            INSERT INTO audit.data_deletion_logs (run_date, entity_type, target_id,
                method, count, triggered_by, reason, metadata, created_at)
            VALUES (v_now, 'ticket', v_ticket.id::text, 'anonymized', 1, 'automation',
                'calendar_3_year_retention', pg_catalog.jsonb_build_object(
                    'activities_anonymized', v_activity_count,
                    'notifications_deleted', v_notification_count,
                    'attachments_processed', false), v_now);
            v_processed := v_processed + 1;
            v_activities := v_activities + v_activity_count;
            v_notifications := v_notifications + v_notification_count;
        EXCEPTION WHEN OTHERS THEN
            v_failed := v_failed + 1;
        END;
    END LOOP;
    RETURN pg_catalog.jsonb_build_object('processed_at', v_now, 'processed_count', v_processed,
        'failed_count', v_failed, 'activities_anonymized', v_activities,
        'notifications_deleted', v_notifications, 'batch_size', p_batch_size);
END;
$$;

CREATE FUNCTION public.backend_process_ticket_retention(p_batch_size integer DEFAULT 100)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$ SELECT private.process_ticket_retention(p_batch_size); $$;

ALTER FUNCTION private.require_consent_profile() OWNER TO postgres;
ALTER FUNCTION public.get_privacy_consent_status() OWNER TO postgres;
ALTER FUNCTION public.record_privacy_consent(boolean) OWNER TO postgres;
ALTER FUNCTION private.retained_activity_meta(text, jsonb) OWNER TO postgres;
ALTER FUNCTION private.process_ticket_retention(integer) OWNER TO postgres;
ALTER FUNCTION public.backend_process_ticket_retention(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.require_consent_profile() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_privacy_consent_status() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_privacy_consent(boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.retained_activity_meta(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.process_ticket_retention(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backend_process_ticket_retention(integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_privacy_consent_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_privacy_consent(boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backend_process_ticket_retention(integer) TO service_role;

-- Latest Step 11 write definitions follow, with only a locked-Ticket read-only guard.

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

ALTER FUNCTION public.change_ticket_status(uuid, text, integer) OWNER TO postgres;
ALTER FUNCTION public.add_ticket_activity(uuid, text, text) OWNER TO postgres;
ALTER FUNCTION public.change_ticket_assignment(uuid, uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.change_ticket_status(uuid, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.add_ticket_activity(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.change_ticket_assignment(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.change_ticket_status(uuid, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_ticket_activity(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.change_ticket_assignment(uuid, uuid, integer) TO authenticated;

COMMIT;
