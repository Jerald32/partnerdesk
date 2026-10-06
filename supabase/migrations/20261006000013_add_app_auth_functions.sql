BEGIN;

-- Backend-only contract. Edge must verify the user's Supabase JWT and obtain
-- p_auth_user_id from its verified subject, never from client-supplied identity.
-- Edge also enforces the existing primary-auth verified-email requirement.
-- Edge generates the code, nonce, token and hashes; none of their raw secrets
-- enter SQL. Do not expose the private schema through the Data API.
-- code_hash = hmac-sha256-v1:<32-byte nonce, lowercase hex>:<HMAC, lowercase hex>.
-- HMAC-SHA-256 input (UTF-8): partnerdesk-mfa-v1|<lowercase auth UUID>|<nonce>|<6 digits>.
-- Its key is an Edge secret, not a DB value. Edge must compute candidate hashes
-- itself; it must never accept a precomputed candidate hash from the frontend.
-- Token hashes are lowercase SHA-256 of at least 32 CSPRNG-generated raw bytes.

CREATE FUNCTION private.lock_app_auth_profile(p_auth_user_id uuid)
RETURNS public.profiles
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_profile public.profiles%ROWTYPE;
BEGIN
    IF p_auth_user_id IS NULL OR
       (auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_auth_user_id) THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'auth_identity_mismatch';
    END IF;
    SELECT p.* INTO v_profile FROM public.profiles AS p
    WHERE p.auth_user_id = p_auth_user_id FOR UPDATE;
    RETURN v_profile;
END;
$$;

-- Called only with the profile lock held, after verification or the explicit
-- MFA-disabled check. No independently executable backend session-creation RPC.
CREATE FUNCTION private.insert_app_auth_session(
    p_profile public.profiles, p_session_token_hash text,
    p_device_label text, p_mfa_verified boolean
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_session_id uuid;
BEGIN
    IF p_profile.id IS NULL OR p_profile.auth_user_id IS NULL OR
       p_profile.account_status IN ('suspended', 'disabled') OR
       p_session_token_hash IS NULL OR p_session_token_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_app_session_input';
    END IF;
    -- Preserve the old single-device behavior, retaining old rows for history.
    UPDATE private.app_sessions SET revoked_at = v_now
    WHERE profile_id = p_profile.id AND revoked_at IS NULL;
    INSERT INTO private.app_sessions (profile_id, auth_user_id, session_token_hash,
        authenticated_at, mfa_verified_at, expires_at, last_activity_at,
        device_label, created_at)
    VALUES (p_profile.id, p_profile.auth_user_id, p_session_token_hash,
        v_now, CASE WHEN p_mfa_verified THEN v_now ELSE NULL END,
        v_now + interval '8 hours', v_now, p_device_label, v_now)
    ON CONFLICT (session_token_hash) DO NOTHING
    RETURNING id INTO v_session_id;
    IF v_session_id IS NULL THEN
        -- Do not expose a hash through a unique-constraint error detail.
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'session_token_conflict';
    END IF;
    UPDATE public.profiles SET last_login_at = v_now,
        account_status = CASE WHEN account_status IN ('pending_login', 'inactive_warning')
            THEN 'active' ELSE account_status END,
        mfa_fail_count = CASE WHEN p_mfa_verified THEN 0 ELSE mfa_fail_count END,
        mfa_locked_until = CASE WHEN p_mfa_verified THEN NULL ELSE mfa_locked_until END,
        updated_at = v_now
    WHERE id = p_profile.id;
    RETURN pg_catalog.jsonb_build_object('ok', true, 'session_id', v_session_id,
        'authenticated_at', v_now,
        'mfa_verified_at', CASE WHEN p_mfa_verified THEN v_now ELSE NULL END,
        'expires_at', v_now + interval '8 hours', 'last_activity_at', v_now);
END;
$$;

CREATE FUNCTION private.create_mfa_challenge(
    p_auth_user_id uuid, p_code_hash text, p_force boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_profile public.profiles%ROWTYPE;
    v_challenge private.mfa_challenges%ROWTYPE;
    v_now timestamptz;
BEGIN
    v_profile := private.lock_app_auth_profile(p_auth_user_id);
    IF v_profile.id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'profile_not_found');
    END IF;
    IF v_profile.account_status IN ('suspended', 'disabled') THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'account_unavailable');
    END IF;
    v_now := pg_catalog.clock_timestamp();
    IF v_profile.mfa_locked_until > v_now THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'mfa_locked',
            'retry_at', v_profile.mfa_locked_until);
    END IF;
    IF p_code_hash IS NULL OR
       p_code_hash !~ '^hmac-sha256-v1:[0-9a-f]{64}:[0-9a-f]{64}$' OR p_force IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_challenge_input';
    END IF;
    SELECT c.* INTO v_challenge FROM private.mfa_challenges AS c
    WHERE c.profile_id = v_profile.id AND c.consumed = false
    ORDER BY c.created_at DESC, c.id DESC LIMIT 1 FOR UPDATE;
    IF NOT p_force AND v_challenge.id IS NOT NULL AND
       v_challenge.created_at > v_now - interval '1 minute' AND
       v_challenge.expires_at > v_now AND
       v_challenge.email_snapshot IS NOT DISTINCT FROM v_profile.email THEN
        -- Edge must not send its newly generated code when skipped=true.
        RETURN pg_catalog.jsonb_build_object('ok', true, 'skipped', true,
            'challenge_id', v_challenge.id, 'email', v_profile.email,
            'nonce', pg_catalog.split_part(v_challenge.code_hash, ':', 2),
            'expires_at', v_challenge.expires_at);
    END IF;
    -- Replace old unconsumed codes without physically deleting their history.
    UPDATE private.mfa_challenges SET consumed = true
    WHERE profile_id = v_profile.id AND consumed = false;
    INSERT INTO private.mfa_challenges (profile_id, email_snapshot, code_hash,
        expires_at, consumed, fail_count, created_at)
    VALUES (v_profile.id, v_profile.email, p_code_hash,
        v_now + interval '5 minutes', false, 0, v_now)
    RETURNING * INTO v_challenge;
    RETURN pg_catalog.jsonb_build_object('ok', true, 'skipped', false,
        'challenge_id', v_challenge.id, 'email', v_profile.email,
        'nonce', pg_catalog.split_part(v_challenge.code_hash, ':', 2),
        'expires_at', v_challenge.expires_at);
END;
$$;

CREATE FUNCTION private.verify_mfa_and_create_app_session(
    p_auth_user_id uuid, p_challenge_id uuid, p_candidate_code_hash text,
    p_session_token_hash text, p_device_label text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_profile public.profiles%ROWTYPE;
    v_challenge private.mfa_challenges%ROWTYPE;
    v_now timestamptz;
    v_fail_count integer;
    v_expected bytea;
    v_candidate bytea;
    v_difference integer := 0;
    v_index integer;
BEGIN
    v_profile := private.lock_app_auth_profile(p_auth_user_id);
    IF v_profile.id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'profile_not_found');
    END IF;
    IF v_profile.account_status IN ('suspended', 'disabled') THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'account_unavailable');
    END IF;
    v_now := pg_catalog.clock_timestamp();
    IF v_profile.mfa_locked_until > v_now THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'mfa_locked',
            'retry_at', v_profile.mfa_locked_until);
    END IF;
    IF p_challenge_id IS NULL OR p_candidate_code_hash IS NULL OR
       p_candidate_code_hash !~ '^hmac-sha256-v1:[0-9a-f]{64}:[0-9a-f]{64}$' OR
       p_session_token_hash IS NULL OR p_session_token_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_verification_input';
    END IF;
    SELECT c.* INTO v_challenge FROM private.mfa_challenges AS c
    WHERE c.id = p_challenge_id AND c.profile_id = v_profile.id FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();
    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'challenge_not_found');
    END IF;
    IF v_challenge.consumed THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'challenge_consumed');
    END IF;
    IF v_challenge.expires_at <= v_now THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'challenge_expired');
    END IF;
    IF v_challenge.email_snapshot IS DISTINCT FROM v_profile.email OR
       v_challenge.code_hash !~ '^hmac-sha256-v1:[0-9a-f]{64}:[0-9a-f]{64}$' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'challenge_invalid');
    END IF;
    -- Fixed-size digest loop, without an early exit on a matching prefix.
    -- This is not a guarantee of constant-time execution by PostgreSQL.
    v_expected := pg_catalog.decode(pg_catalog.split_part(v_challenge.code_hash, ':', 3), 'hex');
    v_candidate := pg_catalog.decode(pg_catalog.split_part(p_candidate_code_hash, ':', 3), 'hex');
    FOR v_index IN 0..31 LOOP
        v_difference := v_difference | (pg_catalog.get_byte(v_expected, v_index)
            # pg_catalog.get_byte(v_candidate, v_index));
    END LOOP;
    IF pg_catalog.split_part(v_challenge.code_hash, ':', 2) IS DISTINCT FROM
       pg_catalog.split_part(p_candidate_code_hash, ':', 2) OR v_difference <> 0 THEN
        v_fail_count := v_profile.mfa_fail_count + 1;
        UPDATE private.mfa_challenges SET fail_count = fail_count + 1
        WHERE id = v_challenge.id;
        UPDATE public.profiles SET
            mfa_fail_count = CASE WHEN v_fail_count >= 5 THEN 0 ELSE v_fail_count END,
            mfa_locked_until = CASE WHEN v_fail_count >= 5
                THEN v_now + interval '5 minutes' ELSE mfa_locked_until END,
            updated_at = v_now
        WHERE id = v_profile.id;
        -- Return a failure value, not an exception: the attempt must commit.
        RETURN pg_catalog.jsonb_build_object('ok', false,
            'reason', CASE WHEN v_fail_count >= 5 THEN 'mfa_locked' ELSE 'code_invalid' END,
            'retry_at', CASE WHEN v_fail_count >= 5 THEN v_now + interval '5 minutes' ELSE NULL END);
    END IF;
    UPDATE private.mfa_challenges SET consumed = true WHERE id = v_challenge.id;
    -- Failure to create the session rolls back consumption too. Success is atomic.
    RETURN private.insert_app_auth_session(v_profile, p_session_token_hash, p_device_label, true);
END;
$$;

CREATE FUNCTION private.activate_app_session_without_mfa(
    p_auth_user_id uuid, p_session_token_hash text, p_device_label text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_profile public.profiles%ROWTYPE;
    v_setting text;
BEGIN
    v_profile := private.lock_app_auth_profile(p_auth_user_id);
    IF v_profile.id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'profile_not_found');
    END IF;
    IF v_profile.account_status IN ('suspended', 'disabled') THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'account_unavailable');
    END IF;
    SELECT s.value INTO v_setting FROM public.system_settings AS s
    WHERE s.key = 'mfa_enabled' FOR SHARE;
    -- Missing settings and all values other than the literal 'false' require MFA.
    IF v_setting IS DISTINCT FROM 'false' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'mfa_required');
    END IF;
    RETURN private.insert_app_auth_session(v_profile, p_session_token_hash, p_device_label, false);
END;
$$;

CREATE FUNCTION private.validate_and_touch_app_session(
    p_auth_user_id uuid, p_session_token_hash text, p_touch boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_profile public.profiles%ROWTYPE;
    v_session private.app_sessions%ROWTYPE;
    v_now timestamptz;
BEGIN
    v_profile := private.lock_app_auth_profile(p_auth_user_id);
    IF v_profile.id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('valid', false, 'reason', 'profile_not_found');
    END IF;
    IF v_profile.account_status IN ('suspended', 'disabled') THEN
        RETURN pg_catalog.jsonb_build_object('valid', false, 'reason', 'account_unavailable');
    END IF;
    IF p_session_token_hash IS NULL OR p_session_token_hash !~ '^[0-9a-f]{64}$' OR p_touch IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('valid', false, 'reason', 'invalid_session_input');
    END IF;
    SELECT s.* INTO v_session FROM private.app_sessions AS s
    WHERE s.session_token_hash = p_session_token_hash AND s.profile_id = v_profile.id
      AND s.auth_user_id = p_auth_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('valid', false, 'reason', 'session_not_found');
    END IF;
    v_now := pg_catalog.clock_timestamp();
    IF v_session.revoked_at IS NOT NULL THEN
        RETURN pg_catalog.jsonb_build_object('valid', false, 'reason', 'session_revoked');
    END IF;
    IF v_now >= v_session.expires_at THEN
        RETURN pg_catalog.jsonb_build_object('valid', false, 'reason', 'absolute_expired');
    END IF;
    IF v_now >= v_session.last_activity_at + interval '15 minutes' THEN
        RETURN pg_catalog.jsonb_build_object('valid', false, 'reason', 'idle_expired');
    END IF;
    -- As in the existing setting UI, MFA changes apply to new authentication.
    -- An already-issued MFA-disabled session retains its bounded validity;
    -- explicit revocation can require earlier reauthentication.
    -- Edge must use touch=false for background polling; only accepted user
    -- activity should extend idle validity. Never extend absolute expires_at.
    IF p_touch THEN
        UPDATE private.app_sessions SET last_activity_at = GREATEST(last_activity_at, v_now)
        WHERE id = v_session.id RETURNING * INTO v_session;
    END IF;
    RETURN pg_catalog.jsonb_build_object('valid', true, 'session_id', v_session.id,
        'authenticated_at', v_session.authenticated_at,
        'mfa_verified_at', v_session.mfa_verified_at, 'expires_at', v_session.expires_at,
        'last_activity_at', v_session.last_activity_at);
    -- Invalid extra authentication never signs out or modifies Supabase Auth.
END;
$$;

CREATE FUNCTION private.revoke_app_session(p_auth_user_id uuid, p_session_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_profile public.profiles%ROWTYPE;
    v_count integer;
BEGIN
    v_profile := private.lock_app_auth_profile(p_auth_user_id);
    IF v_profile.id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'profile_not_found');
    END IF;
    IF p_session_token_hash IS NULL OR p_session_token_hash !~ '^[0-9a-f]{64}$' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'invalid_session_input');
    END IF;
    -- Revocation remains available to suspended/disabled users; creation does not.
    UPDATE private.app_sessions SET revoked_at = pg_catalog.clock_timestamp()
    WHERE profile_id = v_profile.id AND auth_user_id = p_auth_user_id
      AND session_token_hash = p_session_token_hash AND revoked_at IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN pg_catalog.jsonb_build_object('ok', true, 'revoked_count', v_count);
END;
$$;

-- Administrative/backend security hook. Edge must authorize the administrative
-- operation before supplying a target profile ID; never proxy arbitrary client IDs.
CREATE FUNCTION private.revoke_profile_sessions(p_profile_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_profile_id uuid;
    v_count integer;
BEGIN
    SELECT p.id INTO v_profile_id FROM public.profiles AS p
    WHERE p.id = p_profile_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'profile_not_found');
    END IF;
    UPDATE private.app_sessions SET revoked_at = pg_catalog.clock_timestamp()
    WHERE profile_id = v_profile_id AND revoked_at IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN pg_catalog.jsonb_build_object('ok', true, 'revoked_count', v_count);
END;
$$;

-- Thin service-role-only Data API entry points. Private helpers remain owner-only.
CREATE FUNCTION public.backend_create_mfa_challenge(
    p_auth_user_id uuid, p_code_hash text, p_force boolean DEFAULT false
)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$ SELECT private.create_mfa_challenge(p_auth_user_id, p_code_hash, p_force); $$;

CREATE FUNCTION public.backend_verify_mfa_and_create_app_session(
    p_auth_user_id uuid, p_challenge_id uuid, p_candidate_code_hash text,
    p_session_token_hash text, p_device_label text DEFAULT NULL
)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$ SELECT private.verify_mfa_and_create_app_session(
    p_auth_user_id, p_challenge_id, p_candidate_code_hash, p_session_token_hash, p_device_label); $$;

CREATE FUNCTION public.backend_activate_app_session_without_mfa(
    p_auth_user_id uuid, p_session_token_hash text, p_device_label text DEFAULT NULL
)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$ SELECT private.activate_app_session_without_mfa(
    p_auth_user_id, p_session_token_hash, p_device_label); $$;

CREATE FUNCTION public.backend_validate_and_touch_app_session(
    p_auth_user_id uuid, p_session_token_hash text, p_touch boolean DEFAULT true
)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$ SELECT private.validate_and_touch_app_session(p_auth_user_id, p_session_token_hash, p_touch); $$;

CREATE FUNCTION public.backend_revoke_app_session(p_auth_user_id uuid, p_session_token_hash text)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$ SELECT private.revoke_app_session(p_auth_user_id, p_session_token_hash); $$;

CREATE FUNCTION public.backend_revoke_profile_sessions(p_profile_id uuid)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$ SELECT private.revoke_profile_sessions(p_profile_id); $$;

ALTER FUNCTION private.lock_app_auth_profile(uuid) OWNER TO postgres;
ALTER FUNCTION private.insert_app_auth_session(public.profiles, text, text, boolean) OWNER TO postgres;
ALTER FUNCTION private.create_mfa_challenge(uuid, text, boolean) OWNER TO postgres;
ALTER FUNCTION private.verify_mfa_and_create_app_session(uuid, uuid, text, text, text) OWNER TO postgres;
ALTER FUNCTION private.activate_app_session_without_mfa(uuid, text, text) OWNER TO postgres;
ALTER FUNCTION private.validate_and_touch_app_session(uuid, text, boolean) OWNER TO postgres;
ALTER FUNCTION private.revoke_app_session(uuid, text) OWNER TO postgres;
ALTER FUNCTION private.revoke_profile_sessions(uuid) OWNER TO postgres;
ALTER FUNCTION public.backend_create_mfa_challenge(uuid, text, boolean) OWNER TO postgres;
ALTER FUNCTION public.backend_verify_mfa_and_create_app_session(uuid, uuid, text, text, text) OWNER TO postgres;
ALTER FUNCTION public.backend_activate_app_session_without_mfa(uuid, text, text) OWNER TO postgres;
ALTER FUNCTION public.backend_validate_and_touch_app_session(uuid, text, boolean) OWNER TO postgres;
ALTER FUNCTION public.backend_revoke_app_session(uuid, text) OWNER TO postgres;
ALTER FUNCTION public.backend_revoke_profile_sessions(uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION private.lock_app_auth_profile(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.insert_app_auth_session(public.profiles, text, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.create_mfa_challenge(uuid, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.verify_mfa_and_create_app_session(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.activate_app_session_without_mfa(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.validate_and_touch_app_session(uuid, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.revoke_app_session(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.revoke_profile_sessions(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backend_create_mfa_challenge(uuid, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backend_verify_mfa_and_create_app_session(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backend_activate_app_session_without_mfa(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backend_validate_and_touch_app_session(uuid, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backend_revoke_app_session(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backend_revoke_profile_sessions(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.backend_create_mfa_challenge(uuid, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.backend_verify_mfa_and_create_app_session(uuid, uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.backend_activate_app_session_without_mfa(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.backend_validate_and_touch_app_session(uuid, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.backend_revoke_app_session(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.backend_revoke_profile_sessions(uuid) TO service_role;

-- No audit here: failed-attempt persistence must not depend on hash-chain writes.
-- Future Edge audit must exclude codes, hashes, tokens and email bodies.
COMMIT;
