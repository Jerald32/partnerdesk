-- One-time migration: ticket support metadata only.
-- Activity note/view records are internal; future writes/imports must set is_internal.
-- Attachment status has no CHECK until its complete allowed values are confirmed.

CREATE TABLE public.activities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_id uuid NOT NULL,
    actor_profile_id uuid,
    actor_name_snapshot text,
    actor_role_snapshot text,
    type text DEFAULT 'comment' NOT NULL,
    content text,
    is_internal boolean DEFAULT false NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    legacy_base44_id text,
    CONSTRAINT activities_pkey PRIMARY KEY (id),
    CONSTRAINT activities_ticket_id_fkey FOREIGN KEY (ticket_id)
        REFERENCES public.tickets (id) ON DELETE RESTRICT,
    CONSTRAINT activities_actor_profile_id_fkey FOREIGN KEY (actor_profile_id)
        REFERENCES public.profiles (id) ON DELETE RESTRICT,
    CONSTRAINT activities_type_check
        CHECK (type IN ('comment', 'status_change', 'note', 'assignment', 'view')),
    CONSTRAINT activities_legacy_base44_id_key UNIQUE (legacy_base44_id)
);

ALTER TABLE public.activities ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recipient_profile_id uuid NOT NULL,
    ticket_id uuid,
    type text DEFAULT 'status_change' NOT NULL,
    message text NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    read_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL,
    legacy_base44_id text,
    CONSTRAINT notifications_pkey PRIMARY KEY (id),
    CONSTRAINT notifications_recipient_profile_id_fkey FOREIGN KEY (recipient_profile_id)
        REFERENCES public.profiles (id) ON DELETE RESTRICT,
    CONSTRAINT notifications_ticket_id_fkey FOREIGN KEY (ticket_id)
        REFERENCES public.tickets (id) ON DELETE RESTRICT,
    CONSTRAINT notifications_type_check
        CHECK (type IN ('sla_warning', 'sla_breach', 'status_change', 'new_comment', 'assignment')),
    CONSTRAINT notifications_legacy_base44_id_key UNIQUE (legacy_base44_id)
);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.ticket_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_id uuid NOT NULL,
    bucket_id text DEFAULT 'ticket-attachments' NOT NULL,
    object_path text NOT NULL,
    original_name text NOT NULL,
    mime_type text,
    size_bytes bigint,
    sha256 text,
    status text DEFAULT 'pending' NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    created_by_profile_id uuid,
    CONSTRAINT ticket_attachments_pkey PRIMARY KEY (id),
    CONSTRAINT ticket_attachments_ticket_id_fkey FOREIGN KEY (ticket_id)
        REFERENCES public.tickets (id) ON DELETE RESTRICT,
    CONSTRAINT ticket_attachments_created_by_profile_id_fkey FOREIGN KEY (created_by_profile_id)
        REFERENCES public.profiles (id) ON DELETE RESTRICT,
    CONSTRAINT ticket_attachments_bucket_object_path_key UNIQUE (bucket_id, object_path),
    CONSTRAINT ticket_attachments_size_bytes_check CHECK (size_bytes >= 0)
);

ALTER TABLE public.ticket_attachments ENABLE ROW LEVEL SECURITY;

CREATE INDEX activities_ticket_created_at_idx
    ON public.activities (ticket_id, created_at DESC);

CREATE INDEX activities_ticket_is_internal_created_at_idx
    ON public.activities (ticket_id, is_internal, created_at DESC);

CREATE INDEX notifications_recipient_created_at_idx
    ON public.notifications (recipient_profile_id, created_at DESC);

CREATE INDEX notifications_recipient_unread_created_at_idx
    ON public.notifications (recipient_profile_id, created_at DESC)
    WHERE is_read = false;

CREATE INDEX ticket_attachments_ticket_status_idx
    ON public.ticket_attachments (ticket_id, status);
