-- Audit storage only. Append-only enforcement and serialized append functions are deferred.
-- No automatic audit retention/deletion or external immutable checkpoints are introduced.
CREATE SCHEMA IF NOT EXISTS audit;

-- Original Base44 IDs/snapshots/hashes are preserved alongside optional Profile mappings.
-- legacy_record preserves original hash inputs, including exact timestamp strings.
-- Legacy logs may lack hashes or share seq values because the old writer had no lock.
-- Future appends use an advisory lock and the latest (created_at, id) row.
CREATE TABLE audit.access_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    seq bigint,
    actor_profile_id uuid,
    user_id text NOT NULL,
    user_name text,
    user_email text,
    user_role text,
    user_ip text,
    user_agent text,
    accessed_at timestamptz NOT NULL,
    action text NOT NULL,
    target_type text,
    target_id text,
    subject_info text,
    detail text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    prev_hash text,
    record_hash text,
    legacy_record jsonb,
    created_at timestamptz DEFAULT now() NOT NULL,
    legacy_base44_id text,
    CONSTRAINT access_logs_pkey PRIMARY KEY (id),
    CONSTRAINT access_logs_actor_profile_id_fkey FOREIGN KEY (actor_profile_id)
        REFERENCES public.profiles (id) ON DELETE RESTRICT,
    CONSTRAINT access_logs_legacy_base44_id_key UNIQUE (legacy_base44_id)
);

ALTER TABLE audit.access_logs ENABLE ROW LEVEL SECURITY;

-- Role/organization/affiliation snapshots remain unrestricted text for historical compatibility.
CREATE TABLE audit.role_change_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    target_profile_id uuid,
    target_user_id text NOT NULL,
    target_name text,
    target_email text,
    change_type text NOT NULL,
    role_request_id uuid,
    request_id text,
    requester_profile_id uuid,
    requester_id text,
    requester_name text,
    requester_email text,
    requested_at timestamptz,
    request_reason text,
    role_before text,
    role_after text,
    org_type_before text,
    org_type_after text,
    affiliation_before text,
    affiliation_after text,
    actor_profile_id uuid,
    actor_id text,
    actor_name text,
    actor_email text,
    actor_role text,
    actor_ip text,
    source_api text,
    issue_reason text,
    changed_at timestamptz NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    legacy_base44_id text,
    CONSTRAINT role_change_logs_pkey PRIMARY KEY (id),
    CONSTRAINT role_change_logs_target_profile_id_fkey FOREIGN KEY (target_profile_id)
        REFERENCES public.profiles (id) ON DELETE RESTRICT,
    CONSTRAINT role_change_logs_role_request_id_fkey FOREIGN KEY (role_request_id)
        REFERENCES public.role_requests (id) ON DELETE RESTRICT,
    CONSTRAINT role_change_logs_requester_profile_id_fkey FOREIGN KEY (requester_profile_id)
        REFERENCES public.profiles (id) ON DELETE RESTRICT,
    CONSTRAINT role_change_logs_actor_profile_id_fkey FOREIGN KEY (actor_profile_id)
        REFERENCES public.profiles (id) ON DELETE RESTRICT,
    CONSTRAINT role_change_logs_change_type_check CHECK (change_type IN ('request_approved', 'direct')),
    CONSTRAINT role_change_logs_legacy_base44_id_key UNIQUE (legacy_base44_id)
);

ALTER TABLE audit.role_change_logs ENABLE ROW LEVEL SECURITY;

-- Ticket retention: created_at + 3 calendar years, regardless of status.
-- Preserve business records; anonymize PII and process related records per future policy.
-- entity_type is open text so future attachment processing is not excluded.
-- Target IDs are snapshots, not FKs to records that may be deleted.
CREATE TABLE audit.data_deletion_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_date timestamptz,
    retention_threshold date,
    entity_type text NOT NULL,
    target_id text,
    method text NOT NULL,
    count bigint NOT NULL,
    actor_profile_id uuid,
    reason text,
    details text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    triggered_by text,
    created_at timestamptz DEFAULT now() NOT NULL,
    legacy_base44_id text,
    CONSTRAINT data_deletion_logs_pkey PRIMARY KEY (id),
    CONSTRAINT data_deletion_logs_actor_profile_id_fkey FOREIGN KEY (actor_profile_id)
        REFERENCES public.profiles (id) ON DELETE RESTRICT,
    CONSTRAINT data_deletion_logs_method_check CHECK (method IN ('anonymized', 'deleted')),
    CONSTRAINT data_deletion_logs_count_check CHECK (count >= 0),
    CONSTRAINT data_deletion_logs_triggered_by_check CHECK (triggered_by IN ('automation', 'manual')),
    CONSTRAINT data_deletion_logs_legacy_base44_id_key UNIQUE (legacy_base44_id)
);

ALTER TABLE audit.data_deletion_logs ENABLE ROW LEVEL SECURITY;

-- Compatibility metadata for masked CSV snapshots; not an immutable external backup.
-- No FK to access_logs: a snapshot remains meaningful independently of its source rows.
CREATE TABLE audit.access_log_backups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_date timestamptz NOT NULL,
    period_start timestamptz,
    period_end timestamptz,
    log_count bigint NOT NULL,
    first_seq bigint,
    last_seq bigint,
    file_name text,
    file_uri text,
    file_hash text,
    integrity_ok boolean,
    integrity_detail text,
    triggered_by text,
    actor_profile_id uuid,
    actor_email text,
    created_at timestamptz DEFAULT now() NOT NULL,
    legacy_base44_id text,
    CONSTRAINT access_log_backups_pkey PRIMARY KEY (id),
    CONSTRAINT access_log_backups_actor_profile_id_fkey FOREIGN KEY (actor_profile_id)
        REFERENCES public.profiles (id) ON DELETE RESTRICT,
    CONSTRAINT access_log_backups_log_count_check CHECK (log_count >= 0),
    CONSTRAINT access_log_backups_triggered_by_check CHECK (triggered_by IN ('automation', 'manual')),
    CONSTRAINT access_log_backups_legacy_base44_id_key UNIQUE (legacy_base44_id)
);

ALTER TABLE audit.access_log_backups ENABLE ROW LEVEL SECURITY;

CREATE INDEX access_logs_accessed_at_idx
    ON audit.access_logs (accessed_at DESC);

CREATE INDEX access_logs_actor_accessed_at_idx
    ON audit.access_logs (actor_profile_id, accessed_at DESC);

CREATE INDEX access_logs_created_at_id_idx
    ON audit.access_logs (created_at DESC, id DESC);

CREATE INDEX access_logs_seq_idx
    ON audit.access_logs (seq);

CREATE INDEX role_change_logs_changed_at_idx
    ON audit.role_change_logs (changed_at DESC);

CREATE INDEX role_change_logs_target_changed_at_idx
    ON audit.role_change_logs (target_profile_id, changed_at DESC);

CREATE INDEX data_deletion_logs_run_date_idx
    ON audit.data_deletion_logs (run_date DESC);

CREATE INDEX access_log_backups_run_date_idx
    ON audit.access_log_backups (run_date DESC);
