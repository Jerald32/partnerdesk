-- One-time migration: core identity tables only.
-- Activation/auth linkage and partner organization type are validated by future RPCs.
-- updated_at automation is intentionally deferred to a later migration.

CREATE TABLE public.organizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    created_by_profile_id uuid,
    legacy_base44_id text,
    CONSTRAINT organizations_pkey PRIMARY KEY (id),
    CONSTRAINT organizations_name_not_blank_check CHECK (btrim(name) <> ''),
    CONSTRAINT organizations_type_check CHECK (type IN ('operator', 'partner')),
    CONSTRAINT organizations_legacy_base44_id_key UNIQUE (legacy_base44_id)
);

CREATE TABLE public.profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    auth_user_id uuid,
    organization_id uuid NOT NULL,
    role text DEFAULT 'guest' NOT NULL,
    email text NOT NULL,
    full_name text,
    display_name text,
    job_title text,
    profile_image_path text,
    account_status text DEFAULT 'pending_login' NOT NULL,
    last_login_at timestamptz,
    mfa_fail_count integer DEFAULT 0 NOT NULL,
    mfa_locked_until timestamptz,
    password_changed_at timestamptz,
    password_reset_requested_at timestamptz,
    disabled_at timestamptz,
    inactive_check_exempt boolean DEFAULT false NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    created_by_profile_id uuid,
    legacy_base44_id text,
    CONSTRAINT profiles_pkey PRIMARY KEY (id),
    CONSTRAINT profiles_auth_user_id_key UNIQUE (auth_user_id),
    CONSTRAINT profiles_auth_user_id_fkey FOREIGN KEY (auth_user_id)
        REFERENCES auth.users (id) ON DELETE SET NULL,
    CONSTRAINT profiles_organization_id_fkey FOREIGN KEY (organization_id)
        REFERENCES public.organizations (id) ON DELETE RESTRICT,
    CONSTRAINT profiles_role_check
        CHECK (role IN ('admin', 'operator', 'partner_admin', 'guest')),
    CONSTRAINT profiles_account_status_check
        CHECK (account_status IN ('pending_login', 'active', 'inactive_warning', 'suspended', 'disabled')),
    CONSTRAINT profiles_mfa_fail_count_check CHECK (mfa_fail_count >= 0),
    CONSTRAINT profiles_created_by_profile_id_fkey FOREIGN KEY (created_by_profile_id)
        REFERENCES public.profiles (id) ON DELETE RESTRICT,
    CONSTRAINT profiles_legacy_base44_id_key UNIQUE (legacy_base44_id)
);

-- Add the reverse reference only after profiles exists.
ALTER TABLE public.organizations
    ADD CONSTRAINT organizations_created_by_profile_id_fkey
    FOREIGN KEY (created_by_profile_id)
    REFERENCES public.profiles (id) ON DELETE RESTRICT;

CREATE TABLE public.partner_details (
    organization_id uuid NOT NULL,
    partner_type text NOT NULL,
    contact_name text,
    contact_email text,
    contact_phone text,
    description text,
    logo_path text,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    created_by_profile_id uuid,
    legacy_base44_id text,
    CONSTRAINT partner_details_pkey PRIMARY KEY (organization_id),
    CONSTRAINT partner_details_organization_id_fkey FOREIGN KEY (organization_id)
        REFERENCES public.organizations (id) ON DELETE RESTRICT,
    CONSTRAINT partner_details_partner_type_check
        CHECK (partner_type IN ('manufacturer', 'maintenance', 'installation', 'support', 'other')),
    CONSTRAINT partner_details_created_by_profile_id_fkey FOREIGN KEY (created_by_profile_id)
        REFERENCES public.profiles (id) ON DELETE RESTRICT,
    CONSTRAINT partner_details_legacy_base44_id_key UNIQUE (legacy_base44_id)
);

CREATE INDEX organizations_type_is_active_idx
    ON public.organizations (type, is_active);

CREATE INDEX profiles_organization_id_idx
    ON public.profiles (organization_id);

CREATE INDEX profiles_account_status_last_login_at_idx
    ON public.profiles (account_status, last_login_at);
