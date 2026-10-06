-- PartnerDesk additional email authentication; Supabase Auth remains the primary auth.
-- Hash creation/verification, expiry checks, activity updates and revocation are deferred.
-- Never import raw Base44 codes/session IDs into these hash columns.
CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE private.mfa_challenges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    email_snapshot text,
    code_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed boolean DEFAULT false NOT NULL,
    fail_count integer DEFAULT 0 NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    legacy_base44_id text,
    CONSTRAINT mfa_challenges_pkey PRIMARY KEY (id),
    CONSTRAINT mfa_challenges_profile_id_fkey FOREIGN KEY (profile_id)
        REFERENCES public.profiles (id) ON DELETE RESTRICT,
    CONSTRAINT mfa_challenges_code_hash_not_blank_check CHECK (btrim(code_hash) <> ''),
    CONSTRAINT mfa_challenges_expires_at_check CHECK (expires_at > created_at),
    CONSTRAINT mfa_challenges_fail_count_check CHECK (fail_count >= 0),
    CONSTRAINT mfa_challenges_legacy_base44_id_key UNIQUE (legacy_base44_id)
);

ALTER TABLE private.mfa_challenges ENABLE ROW LEVEL SECURITY;

-- authenticated_at is the app authentication anchor, including the legacy MFA-disabled path.
-- mfa_verified_at is populated only after actual email code verification.
-- Future trusted paths set expires_at to authenticated_at + 8 hours and enforce
-- last_activity_at + 15 minutes. App reauthentication does not sign out Supabase Auth.
-- New-device authentication can revoke prior sessions through future trusted logic.
CREATE TABLE private.app_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    auth_user_id uuid,
    session_token_hash text NOT NULL,
    authenticated_at timestamptz NOT NULL,
    mfa_verified_at timestamptz,
    expires_at timestamptz NOT NULL,
    last_activity_at timestamptz NOT NULL,
    revoked_at timestamptz,
    device_label text,
    created_at timestamptz DEFAULT now() NOT NULL,
    legacy_base44_id text,
    CONSTRAINT app_sessions_pkey PRIMARY KEY (id),
    CONSTRAINT app_sessions_profile_id_fkey FOREIGN KEY (profile_id)
        REFERENCES public.profiles (id) ON DELETE RESTRICT,
    CONSTRAINT app_sessions_auth_user_id_fkey FOREIGN KEY (auth_user_id)
        REFERENCES auth.users (id) ON DELETE SET NULL,
    CONSTRAINT app_sessions_session_token_hash_key UNIQUE (session_token_hash),
    CONSTRAINT app_sessions_session_token_hash_not_blank_check CHECK (btrim(session_token_hash) <> ''),
    CONSTRAINT app_sessions_expires_at_check CHECK (expires_at > authenticated_at),
    CONSTRAINT app_sessions_last_activity_at_check CHECK (last_activity_at >= authenticated_at),
    CONSTRAINT app_sessions_legacy_base44_id_key UNIQUE (legacy_base44_id)
);

ALTER TABLE private.app_sessions ENABLE ROW LEVEL SECURITY;

CREATE INDEX mfa_challenges_profile_unconsumed_created_at_idx
    ON private.mfa_challenges (profile_id, created_at DESC)
    WHERE consumed = false;

CREATE INDEX mfa_challenges_expires_at_idx
    ON private.mfa_challenges (expires_at);

CREATE INDEX app_sessions_profile_unrevoked_idx
    ON private.app_sessions (profile_id)
    WHERE revoked_at IS NULL;

CREATE INDEX app_sessions_expires_at_idx
    ON private.app_sessions (expires_at);
