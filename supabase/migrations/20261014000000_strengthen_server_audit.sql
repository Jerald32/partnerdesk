BEGIN;
CREATE OR REPLACE FUNCTION audit.append_access_log(
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
        -- Identity is already captured by immutable profile/auth IDs. New
        -- entries do not duplicate names or email addresses; old rows are intact.
        v_row.user_name := NULL;
        v_row.user_email := NULL;
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
    v_row.metadata := p_metadata || pg_catalog.jsonb_build_object('request_id', pg_catalog.gen_random_uuid(), 'result', COALESCE(p_metadata->>'result','success'), 'ip_unavailable_reason', CASE WHEN p_trusted_ip IS NULL THEN 'trusted_request_ip_not_available' ELSE NULL END,
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

-- The append function is prepended below during construction; historical migrations remain intact.

CREATE FUNCTION private.auth_event_audit(p_user uuid,p_action text,p_success boolean,p_target uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE old_subject text:=current_setting('request.jwt.claim.sub',true);
BEGIN
 IF p_action NOT IN ('login_session','session_blocked','logout') THEN RAISE EXCEPTION 'invalid_auth_event'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE auth_user_id=p_user) THEN RETURN; END IF;
 PERFORM set_config('request.jwt.claim.sub',p_user::text,true);
 PERFORM audit.append_access_log(p_action=>p_action,p_target_type=>'Authentication',p_target_id=>p_target::text,
   p_metadata=>jsonb_build_object('result',CASE WHEN p_success THEN 'success' ELSE 'denied' END));
 PERFORM set_config('request.jwt.claim.sub',COALESCE(old_subject,''),true);
END $$;
REVOKE ALL ON FUNCTION private.auth_event_audit(uuid,text,boolean,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.backend_activate_app_session_without_mfa(p_auth_user_id uuid,p_session_token_hash text,p_device_label text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r jsonb;
BEGIN
 r:=private.activate_app_session_without_mfa(p_auth_user_id,p_session_token_hash,p_device_label);
 PERFORM private.auth_event_audit(p_auth_user_id,'login_session',COALESCE((r->>'ok')::boolean,false),(r->>'session_id')::uuid);
 RETURN r;
END $$;
CREATE OR REPLACE FUNCTION public.backend_validate_and_touch_app_session(p_auth_user_id uuid,p_session_token_hash text,p_touch boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r jsonb;
BEGIN
 r:=private.validate_and_touch_app_session(p_auth_user_id,p_session_token_hash,p_touch);
 IF (r->>'valid')::boolean IS DISTINCT FROM true THEN
  PERFORM private.auth_event_audit(p_auth_user_id,'session_blocked',false);
 END IF;
 RETURN r;
END $$;
CREATE OR REPLACE FUNCTION public.backend_revoke_app_session(p_auth_user_id uuid,p_session_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r jsonb;
BEGIN
 r:=private.revoke_app_session(p_auth_user_id,p_session_token_hash);
 PERFORM private.auth_event_audit(p_auth_user_id,'logout',COALESCE((r->>'ok')::boolean,false));
 RETURN r;
END $$;

-- Keep existing MFA actions and fixed event allowlist; enrich only new entries.
CREATE OR REPLACE FUNCTION private.email_mfa_audit(p_user uuid,p_event text,p_challenge uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE old_subject text:=current_setting('request.jwt.claim.sub',true);
BEGIN
 IF p_event NOT IN ('requested','delivery_accepted','delivery_failed','attempt','verified','failed','locked','rate_limited') THEN
  RAISE EXCEPTION 'invalid_mfa_event'; END IF;
 PERFORM set_config('request.jwt.claim.sub',p_user::text,true);
 PERFORM audit.append_access_log(p_action=>'이메일 MFA '||p_event,p_target_type=>'Authentication',p_target_id=>p_challenge::text,
  p_metadata=>jsonb_build_object('event',p_event,'provider','supabase_auth_otp','result',
   CASE WHEN p_event IN ('delivery_failed','failed','locked','rate_limited') THEN 'denied' ELSE 'success' END));
 IF p_event='verified' THEN PERFORM private.auth_event_audit(p_user,'login_session',true); END IF;
 PERFORM set_config('request.jwt.claim.sub',COALESCE(old_subject,''),true);
END $$;

-- Audited detail endpoint returns only the existing screen projection, after the
-- same app-session, organization and consent authorization as ticket RLS.
CREATE FUNCTION public.read_ticket_detail_audited(p_ticket_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r jsonb;
BEGIN
 PERFORM private.require_request_app_session(true);
 IF NOT public.can_access_ticket(p_ticket_id) THEN RETURN NULL; END IF;
 SELECT to_jsonb(q) INTO r FROM (SELECT id,title,description,request_type,request_detail,business_id,
  customer_name,customer_company,customer_contact,address,address_detail,status,priority,operator_profile_id,
  operator_name_snapshot,assigned_partner_organization_id,created_at,resolved_at,version,retention_state
  FROM public.tickets WHERE id=p_ticket_id) q;
 IF r IS NOT NULL THEN
  PERFORM audit.append_access_log(p_action=>'ticket_detail_read',p_target_type=>'Ticket',p_target_id=>p_ticket_id::text,
    p_metadata=>jsonb_build_object('contains_personal_fields',true));
 END IF;
 RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.read_ticket_detail_audited(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.read_ticket_detail_audited(uuid) TO authenticated;

-- RPCs already audit creates/edits/status/assignment atomically. Cover deletion
-- and attachment metadata at the table boundary without duplicate write logs.
CREATE FUNCTION private.audit_ticket_boundary_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE object_id uuid; ticket_id uuid;
BEGIN
 IF TG_OP='DELETE' THEN object_id:=OLD.id; ELSE object_id:=NEW.id; END IF;
 IF TG_TABLE_NAME='ticket_attachments' THEN
  IF TG_OP='DELETE' THEN ticket_id:=OLD.ticket_id; ELSE ticket_id:=NEW.ticket_id; END IF;
 END IF;
 PERFORM audit.append_access_log(p_action=>lower(TG_TABLE_NAME||'_'||TG_OP),
  p_target_type=>CASE WHEN TG_TABLE_NAME='tickets' THEN 'Ticket' ELSE 'TicketAttachment' END,
  p_target_id=>object_id::text,p_metadata=>jsonb_build_object('ticket_id',ticket_id,'source','database_trigger'));
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
REVOKE ALL ON FUNCTION private.audit_ticket_boundary_change() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER ticket_delete_audit AFTER DELETE ON public.tickets FOR EACH ROW EXECUTE FUNCTION private.audit_ticket_boundary_change();
CREATE TRIGGER attachment_metadata_audit AFTER INSERT OR UPDATE OR DELETE ON public.ticket_attachments FOR EACH ROW EXECUTE FUNCTION private.audit_ticket_boundary_change();

CREATE FUNCTION private.reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'audit_history_immutable' USING ERRCODE='42501'; END $$;
REVOKE ALL ON FUNCTION private.reject_audit_mutation() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER access_log_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON audit.access_logs
FOR EACH STATEMENT EXECUTE FUNCTION private.reject_audit_mutation();
CREATE TRIGGER role_log_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON audit.role_change_logs
FOR EACH STATEMENT EXECUTE FUNCTION private.reject_audit_mutation();
CREATE TRIGGER deletion_log_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON audit.data_deletion_logs
FOR EACH STATEMENT EXECUTE FUNCTION private.reject_audit_mutation();
REVOKE ALL ON audit.access_logs,audit.role_change_logs,audit.data_deletion_logs FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.search_admin_access_audit(p_query text DEFAULT '',p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r jsonb; s text:=btrim(COALESCE(p_query,''));
BEGIN
 PERFORM private.require_request_app_session(false);
 IF NOT public.is_company_admin() THEN RAISE EXCEPTION 'role_not_allowed' USING ERRCODE='42501'; END IF;
 IF length(s)>100 OR p_offset IS NULL OR p_offset<0 OR p_offset>1000000 THEN RAISE EXCEPTION 'invalid_search' USING ERRCODE='22023'; END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]'::jsonb) INTO r FROM (
  SELECT id,accessed_at,actor_profile_id,metadata->>'organization_id' AS organization_id,
   action,target_type,target_id,metadata->>'result' AS result,metadata->>'request_id' AS request_id,
   user_ip,metadata->>'ip_unavailable_reason' AS ip_unavailable_reason,metadata,seq
  FROM audit.access_logs WHERE s='' OR position(lower(s) in lower(action))>0
   OR position(lower(s) in lower(COALESCE(target_id,'')))>0
   OR position(lower(s) in lower(COALESCE(actor_profile_id::text,'')))>0
   OR position(lower(s) in lower(COALESCE(metadata->>'organization_id','')))>0
   OR position(lower(s) in lower(COALESCE(metadata->>'request_id','')))>0
   OR position(lower(s) in lower(COALESCE(metadata->>'result','')))>0
  ORDER BY accessed_at DESC,id DESC LIMIT 100 OFFSET p_offset) q;
 RETURN jsonb_build_object('rows',r);
END $$;
REVOKE ALL ON FUNCTION public.search_admin_access_audit(text,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.search_admin_access_audit(text,integer) TO authenticated;
CREATE OR REPLACE FUNCTION public.backend_reserve_email_mfa_attempt(p_auth_user_id uuid,p_password_session_id uuid,p_challenge_id uuid,p_nonce text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.profiles; c private.email_mfa_challenges; ticket uuid:=gen_random_uuid(); v_now timestamptz:=clock_timestamp();
BEGIN
 p:=private.email_mfa_profile(p_auth_user_id);
 IF p.mfa_locked_until>v_now THEN PERFORM private.email_mfa_audit(p_auth_user_id,'failed',c.id); RETURN jsonb_build_object('ok',false,'reason','mfa_locked'); END IF;
 IF p.mfa_locked_until IS NOT NULL AND p.mfa_locked_until<=v_now THEN
  UPDATE public.profiles SET mfa_fail_count=0,mfa_locked_until=NULL WHERE id=p.id;
  p.mfa_fail_count:=0;
 END IF;
 SELECT * INTO c FROM private.email_mfa_challenges WHERE id=p_challenge_id AND profile_id=p.id FOR UPDATE;
 IF NOT FOUND OR c.password_session_id IS DISTINCT FROM p_password_session_id OR c.nonce IS DISTINCT FROM p_nonce
  OR c.email_snapshot IS DISTINCT FROM p.email OR c.delivery<>'accepted' THEN
  PERFORM private.email_mfa_audit(p_auth_user_id,'failed',c.id); RETURN jsonb_build_object('ok',false,'reason','challenge_invalid'); END IF;
 IF c.consumed THEN PERFORM private.email_mfa_audit(p_auth_user_id,'failed',c.id); RETURN jsonb_build_object('ok',false,'reason','challenge_consumed'); END IF;
 IF c.expires_at<=v_now THEN PERFORM private.email_mfa_audit(p_auth_user_id,'failed',c.id); RETURN jsonb_build_object('ok',false,'reason','challenge_expired'); END IF;
 IF c.attempts>=5 OR p.mfa_fail_count>=5 THEN PERFORM private.email_mfa_audit(p_auth_user_id,'failed',c.id); RETURN jsonb_build_object('ok',false,'reason','mfa_locked'); END IF;
 UPDATE private.email_mfa_challenges SET attempts=attempts+1,attempt_id=ticket WHERE id=c.id;
 UPDATE public.profiles SET mfa_fail_count=mfa_fail_count+1,
  mfa_locked_until=CASE WHEN mfa_fail_count+1>=5 THEN v_now+interval '5 minutes' ELSE mfa_locked_until END WHERE id=p.id;
 PERFORM private.email_mfa_audit(p_auth_user_id,'attempt',c.id);
 RETURN jsonb_build_object('ok',true,'attempt_id',ticket);
END $$;

COMMIT;
