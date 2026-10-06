-- One-time migration. updated_at automation and write RPCs are deferred.
-- Ticket retention will use created_at + 3 calendar years, regardless of status.

CREATE TABLE public.businesses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    created_by_profile_id uuid,
    legacy_base44_id text,
    name text NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT businesses_pkey PRIMARY KEY (id),
    CONSTRAINT businesses_created_by_profile_id_fkey FOREIGN KEY (created_by_profile_id)
        REFERENCES public.profiles (id) ON DELETE RESTRICT,
    CONSTRAINT businesses_legacy_base44_id_key UNIQUE (legacy_base44_id),
    CONSTRAINT businesses_name_not_blank_check CHECK (btrim(name) <> '')
);

CREATE TABLE public.service_partners (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    created_by_profile_id uuid,
    legacy_base44_id text,
    business_id uuid NOT NULL,
    partner_organization_id uuid NOT NULL,
    access_level text DEFAULT 'service' NOT NULL,
    role_description text,
    sla_response_hours numeric(8,2) DEFAULT 4 NOT NULL,
    sla_resolution_hours numeric(8,2) DEFAULT 24 NOT NULL,
    CONSTRAINT service_partners_pkey PRIMARY KEY (id),
    CONSTRAINT service_partners_created_by_profile_id_fkey FOREIGN KEY (created_by_profile_id)
        REFERENCES public.profiles (id) ON DELETE RESTRICT,
    CONSTRAINT service_partners_legacy_base44_id_key UNIQUE (legacy_base44_id),
    CONSTRAINT service_partners_business_id_fkey FOREIGN KEY (business_id)
        REFERENCES public.businesses (id) ON DELETE RESTRICT,
    CONSTRAINT service_partners_partner_organization_id_fkey FOREIGN KEY (partner_organization_id)
        REFERENCES public.partner_details (organization_id) ON DELETE RESTRICT,
    CONSTRAINT service_partners_access_level_check CHECK (access_level IN ('business', 'service')),
    CONSTRAINT service_partners_sla_response_hours_check CHECK (sla_response_hours >= 0),
    CONSTRAINT service_partners_sla_resolution_hours_check CHECK (sla_resolution_hours >= 0),
    CONSTRAINT service_partners_business_partner_key UNIQUE (business_id, partner_organization_id)
);

CREATE TABLE public.tickets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    created_by_profile_id uuid,
    legacy_base44_id text,
    title text NOT NULL,
    description text,
    request_type text,
    request_detail text,
    business_id uuid NOT NULL,
    assigned_partner_organization_id uuid,
    operator_profile_id uuid,
    operator_name_snapshot text,
    customer_name text,
    customer_company text,
    customer_contact text,
    address text,
    address_detail text,
    status text DEFAULT 'new' NOT NULL,
    priority text DEFAULT 'normal' NOT NULL,
    resolved_at timestamptz,
    retention_processed_at timestamptz,
    retention_state text DEFAULT 'active' NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT tickets_pkey PRIMARY KEY (id),
    CONSTRAINT tickets_created_by_profile_id_fkey FOREIGN KEY (created_by_profile_id)
        REFERENCES public.profiles (id) ON DELETE RESTRICT,
    CONSTRAINT tickets_legacy_base44_id_key UNIQUE (legacy_base44_id),
    CONSTRAINT tickets_title_not_blank_check CHECK (btrim(title) <> ''),
    CONSTRAINT tickets_request_type_check CHECK (request_type IN (
        '장애/고장', '설치 요청', '점검/유지보수', '교체 요청',
        '소프트웨어 오류', '네트워크 문제', '이전/철거', '기타'
    )),
    CONSTRAINT tickets_business_id_fkey FOREIGN KEY (business_id)
        REFERENCES public.businesses (id) ON DELETE RESTRICT,
    -- MATCH SIMPLE permits an unassigned ticket when the partner ID is NULL.
    CONSTRAINT tickets_business_assigned_partner_fkey
        FOREIGN KEY (business_id, assigned_partner_organization_id)
        REFERENCES public.service_partners (business_id, partner_organization_id)
        MATCH SIMPLE ON DELETE RESTRICT,
    CONSTRAINT tickets_operator_profile_id_fkey FOREIGN KEY (operator_profile_id)
        REFERENCES public.profiles (id) ON DELETE RESTRICT,
    CONSTRAINT tickets_status_check CHECK (status IN ('new', 'inprogress', 'hold', 'done')),
    CONSTRAINT tickets_priority_check CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    CONSTRAINT tickets_version_check CHECK (version > 0)
);

CREATE INDEX businesses_is_active_name_idx
    ON public.businesses (is_active, name);

CREATE INDEX service_partners_partner_business_access_level_idx
    ON public.service_partners (partner_organization_id, business_id, access_level);

CREATE INDEX tickets_business_created_at_idx
    ON public.tickets (business_id, created_at DESC);

CREATE INDEX tickets_assigned_partner_created_at_idx
    ON public.tickets (assigned_partner_organization_id, created_at DESC);

CREATE INDEX tickets_operator_status_idx
    ON public.tickets (operator_profile_id, status);

CREATE INDEX tickets_status_priority_created_at_idx
    ON public.tickets (status, priority, created_at);

ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
