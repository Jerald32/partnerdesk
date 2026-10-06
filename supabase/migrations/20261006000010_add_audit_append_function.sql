BEGIN;

-- Core SHA-256 needs no extension. Fail deployment if the prerequisite is absent.
DO $$
BEGIN
    IF pg_catalog.to_regprocedure('pg_catalog.sha256(bytea)') IS NULL THEN
        RAISE EXCEPTION 'core_sha256_required';
    END IF;
    IF pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('abc', 'UTF8')), 'hex')
       <> 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' THEN
        RAISE EXCEPTION 'core_sha256_self_test_failed';
    END IF;
END;
$$;

-- v1 hashes all stored fields except record_hash; NULL stays JSON null.
-- Replace session-dependent timestamp strings with fixed UTC microseconds.
CREATE FUNCTION audit.access_log_record_hash(p_record audit.access_logs)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        ((pg_catalog.to_jsonb(p_record) - 'record_hash') || pg_catalog.jsonb_build_object(
            'created_at', pg_catalog.to_char(p_record.created_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'accessed_at', pg_catalog.to_char(p_record.accessed_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        ))::text, 'UTF8')), 'hex');
$$;

-- Internal inspection only. Never silently skip legacy or malformed rows.
CREATE FUNCTION audit.verify_access_log_chain()
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_row audit.access_logs%ROWTYPE;
    v_expected_seq numeric := 1;
    v_prev_hash text := 'GENESIS';
    v_previous_created_at timestamptz;
    v_reason text;
BEGIN
    -- A snapshot taken before waiting for a writer must not be reused.
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION USING ERRCODE = '25000', MESSAGE = 'audit_read_committed_required';
    END IF;
    -- Reserved two-int key for this single global chain; retained until transaction end.
    PERFORM pg_catalog.pg_advisory_xact_lock(20261006, 11);
    FOR v_row IN SELECT l.* FROM audit.access_logs AS l ORDER BY l.seq NULLS FIRST, l.id LOOP
        v_reason := NULL;
        IF v_row.legacy_base44_id IS NOT NULL OR v_row.legacy_record IS NOT NULL THEN
            v_reason := 'legacy_chain_requires_verified_migration';
        ELSIF v_row.seq IS DISTINCT FROM v_expected_seq THEN
            v_reason := 'invalid_sequence';
        ELSIF v_row.prev_hash IS DISTINCT FROM v_prev_hash THEN
            v_reason := 'prev_hash_mismatch';
        ELSIF v_row.record_hash IS DISTINCT FROM audit.access_log_record_hash(v_row) THEN
            v_reason := 'record_hash_mismatch';
        ELSIF v_previous_created_at IS NOT NULL AND v_row.created_at <= v_previous_created_at THEN
            v_reason := 'created_at_order_mismatch';
        END IF;
        IF v_reason IS NOT NULL THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'checked', v_expected_seq - 1,
                'invalid_id', v_row.id, 'invalid_seq', v_row.seq, 'reason', v_reason);
        END IF;
        v_expected_seq := v_expected_seq + 1;
        v_prev_hash := v_row.record_hash;
        v_previous_created_at := v_row.created_at;
    END LOOP;
    RETURN pg_catalog.jsonb_build_object('ok', true, 'checked', v_expected_seq - 1,
        'last_seq', v_expected_seq - 1, 'last_hash', v_prev_hash);
END;
$$;

-- Trusted internal caller supplies business facts, not actor identity or timestamps.
-- IP/UA arguments are trusted-context slots, never forwarded client body/header values.
CREATE FUNCTION audit.append_access_log(
    p_action text,
    p_target_type text DEFAULT NULL,
    p_target_id text DEFAULT NULL,
    p_subject_info text DEFAULT NULL,
    p_detail text DEFAULT NULL,
    p_metadata jsonb DEFAULT '{}'::jsonb,
    p_trusted_ip text DEFAULT NULL,
    p_trusted_user_agent text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_user_id uuid := auth.uid();
    v_actor public.profiles%ROWTYPE;
    v_row audit.access_logs%ROWTYPE;
    v_previous audit.access_logs%ROWTYPE;
    v_verification jsonb;
    v_max_seq bigint;
    v_now timestamptz;
    v_actor_kind text;
BEGIN
    IF p_action IS NULL OR p_action !~ '[^[:space:]]' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'audit_action_required';
    END IF;
    IF p_metadata IS NULL OR pg_catalog.jsonb_typeof(p_metadata) <> 'object' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'audit_metadata_object_required';
    END IF;
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION USING ERRCODE = '25000', MESSAGE = 'audit_read_committed_required';
    END IF;

    IF v_auth_user_id IS NOT NULL THEN
        SELECT p.* INTO v_actor FROM public.profiles AS p
        WHERE p.auth_user_id = v_auth_user_id FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'profile_not_found';
        END IF;
        v_actor_kind := 'user';
        v_row.actor_profile_id := v_actor.id;
        v_row.user_id := v_actor.id::text;
        v_row.user_name := COALESCE(NULLIF(v_actor.display_name, ''),
            NULLIF(v_actor.full_name, ''), v_actor.email);
        v_row.user_email := v_actor.email;
        v_row.user_role := v_actor.role;
    ELSE
        -- No public EXECUTE grant: only postgres-owned trusted callers reach this path.
        v_actor_kind := 'system';
        v_row.user_id := 'system';
        v_row.user_name := 'system';
        v_row.user_role := 'system';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(20261006, 11);
    v_verification := audit.verify_access_log_chain();
    IF (v_verification ->> 'ok')::boolean IS DISTINCT FROM true THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'audit_chain_not_appendable',
            DETAIL = v_verification::text;
    END IF;
    SELECT l.* INTO v_previous FROM audit.access_logs AS l
    ORDER BY l.created_at DESC, l.id DESC LIMIT 1;
    SELECT pg_catalog.max(l.seq) INTO v_max_seq FROM audit.access_logs AS l;
    IF v_max_seq = 9223372036854775807 THEN
        RAISE EXCEPTION USING ERRCODE = '22003', MESSAGE = 'audit_sequence_exhausted';
    END IF;
    IF v_max_seq IS NOT NULL AND v_previous.seq IS DISTINCT FROM v_max_seq THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'audit_latest_sequence_mismatch';
    END IF;
    v_row.seq := COALESCE(v_max_seq, 0) + 1;
    v_row.prev_hash := CASE WHEN v_max_seq IS NULL THEN 'GENESIS' ELSE v_previous.record_hash END;
    v_now := pg_catalog.clock_timestamp();
    -- Keep the existing (created_at, id) tail ordering valid even if the clock moves back.
    IF v_previous.created_at IS NOT NULL AND v_now <= v_previous.created_at THEN
        v_now := v_previous.created_at + INTERVAL '1 microsecond';
    END IF;
    v_row.id := pg_catalog.gen_random_uuid();
    v_row.created_at := v_now;
    v_row.accessed_at := v_now;
    v_row.action := p_action;
    v_row.target_type := p_target_type;
    v_row.target_id := p_target_id;
    v_row.subject_info := p_subject_info;
    v_row.detail := p_detail;
    v_row.user_ip := p_trusted_ip;
    v_row.user_agent := p_trusted_user_agent;
    -- Server fields overwrite conflicting caller metadata; originals are not actor inputs.
    v_row.metadata := p_metadata || pg_catalog.jsonb_build_object(
        'hash_format', 'partnerdesk-access-log-v1', 'actor_kind', v_actor_kind,
        'auth_user_id', v_auth_user_id, 'organization_id', v_actor.organization_id,
        'organization_type_snapshot', (SELECT o.type FROM public.organizations AS o
            WHERE o.id = v_actor.organization_id),
        'organization_name_snapshot', (SELECT o.name FROM public.organizations AS o
            WHERE o.id = v_actor.organization_id),
        'network_context_source', CASE
            WHEN p_trusted_ip IS NULL AND p_trusted_user_agent IS NULL THEN 'unavailable'
            ELSE 'trusted_internal_caller' END);
    v_row.record_hash := audit.access_log_record_hash(v_row);
    INSERT INTO audit.access_logs SELECT (v_row).*;
    RETURN pg_catalog.jsonb_build_object('id', v_row.id, 'seq', v_row.seq,
        'prev_hash', v_row.prev_hash, 'record_hash', v_row.record_hash,
        'created_at', v_row.created_at);
END;
$$;

ALTER FUNCTION audit.access_log_record_hash(audit.access_logs) OWNER TO postgres;
ALTER FUNCTION audit.verify_access_log_chain() OWNER TO postgres;
ALTER FUNCTION audit.append_access_log(text, text, text, text, text, jsonb, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION audit.access_log_record_hash(audit.access_logs)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION audit.verify_access_log_chain()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION audit.append_access_log(text, text, text, text, text, jsonb, text, text)
    FROM PUBLIC, anon, authenticated, service_role;
-- Preserve management recovery: no blocking trigger and no FORCE RLS.
REVOKE ALL ON TABLE audit.access_logs FROM PUBLIC, anon, authenticated;

COMMIT;
