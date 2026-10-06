-- One-time migration: policy management data only; no client policies or automation.
-- Legacy affiliation/company values mix company names and Base44 Partner IDs.
-- Preserve those snapshots; populate organization FKs through verified migration/write paths.

CREATE TABLE public.role_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    requester_profile_id uuid NOT NULL,
    requester_name_snapshot text,
    requester_email_snapshot text,
    current_role_snapshot text,
    current_org_type_snapshot text,
    current_affiliation_snapshot text,
    current_organization_id uuid,
    requested_role text NOT NULL,
    requested_org_type text,
    company text,
    requested_organization_id uuid,
    justification text NOT NULL,
    status text DEFAULT 'pending' NOT NULL,
    reviewed_by_profile_id uuid,
    reviewed_at timestamptz,
    admin_notes text,
    consent_agreed boolean,
    consent_agreed_at timestamptz,
    created_by_profile_id uuid,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    legacy_base44_id text,
    CONSTRAINT role_requests_pkey PRIMARY KEY (id),
    CONSTRAINT role_requests_requester_profile_id_fkey FOREIGN KEY (requester_profile_id)
        REFERENCES public.profiles (id) ON DELETE RESTRICT,
    CONSTRAINT role_requests_current_organization_id_fkey FOREIGN KEY (current_organization_id)
        REFERENCES public.organizations (id) ON DELETE RESTRICT,
    CONSTRAINT role_requests_requested_organization_id_fkey FOREIGN KEY (requested_organization_id)
        REFERENCES public.organizations (id) ON DELETE RESTRICT,
    CONSTRAINT role_requests_reviewed_by_profile_id_fkey FOREIGN KEY (reviewed_by_profile_id)
        REFERENCES public.profiles (id) ON DELETE RESTRICT,
    CONSTRAINT role_requests_created_by_profile_id_fkey FOREIGN KEY (created_by_profile_id)
        REFERENCES public.profiles (id) ON DELETE RESTRICT,
    CONSTRAINT role_requests_requested_role_check CHECK (requested_role IN ('operator', 'partner_admin')),
    CONSTRAINT role_requests_requested_org_type_check CHECK (requested_org_type IN ('operator_company', 'partner')),
    CONSTRAINT role_requests_status_check CHECK (status IN ('pending', 'approved', 'denied')),
    CONSTRAINT role_requests_legacy_base44_id_key UNIQUE (legacy_base44_id)
);

ALTER TABLE public.role_requests ENABLE ROW LEVEL SECURITY;

-- Consent history: one-year validity, organization/version changes require re-consent.
-- Enforcement is deferred. Legacy rows have no consent_type or organization UUID.
CREATE TABLE public.privacy_consents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    user_name_snapshot text,
    user_email_snapshot text,
    company_snapshot text,
    organization_id uuid,
    consent_type text,
    pledge_version text,
    consent_date timestamptz NOT NULL,
    valid_until date NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    legacy_base44_id text,
    CONSTRAINT privacy_consents_pkey PRIMARY KEY (id),
    CONSTRAINT privacy_consents_profile_id_fkey FOREIGN KEY (profile_id)
        REFERENCES public.profiles (id) ON DELETE RESTRICT,
    CONSTRAINT privacy_consents_organization_id_fkey FOREIGN KEY (organization_id)
        REFERENCES public.organizations (id) ON DELETE RESTRICT,
    CONSTRAINT privacy_consents_legacy_base44_id_key UNIQUE (legacy_base44_id)
);

ALTER TABLE public.privacy_consents ENABLE ROW LEVEL SECURITY;

-- Existing consumers compare value against the literal strings 'true'/'false'.
CREATE TABLE public.system_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    value text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    legacy_base44_id text,
    CONSTRAINT system_settings_pkey PRIMARY KEY (id),
    CONSTRAINT system_settings_key_key UNIQUE (key),
    CONSTRAINT system_settings_legacy_base44_id_key UNIQUE (legacy_base44_id)
);

ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

-- Preserve exact text matching; no inet/cidr parsing or normalization is introduced.
-- Future IP checks: zero active entries allow access; otherwise use the active list.
-- No FORCE RLS or IP gate is added to the administrative recovery path.
CREATE TABLE public.ip_whitelist (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ip_address text NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_by_profile_id uuid,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    legacy_base44_id text,
    CONSTRAINT ip_whitelist_pkey PRIMARY KEY (id),
    CONSTRAINT ip_whitelist_created_by_profile_id_fkey FOREIGN KEY (created_by_profile_id)
        REFERENCES public.profiles (id) ON DELETE RESTRICT,
    CONSTRAINT ip_whitelist_legacy_base44_id_key UNIQUE (legacy_base44_id)
);

ALTER TABLE public.ip_whitelist ENABLE ROW LEVEL SECURITY;

CREATE INDEX role_requests_requester_status_created_at_idx
    ON public.role_requests (requester_profile_id, status, created_at DESC);

CREATE INDEX role_requests_created_at_idx
    ON public.role_requests (created_at DESC);

CREATE INDEX privacy_consents_profile_consent_date_idx
    ON public.privacy_consents (profile_id, consent_date DESC);

CREATE INDEX ip_whitelist_active_ip_address_idx
    ON public.ip_whitelist (ip_address)
    WHERE is_active = true;
