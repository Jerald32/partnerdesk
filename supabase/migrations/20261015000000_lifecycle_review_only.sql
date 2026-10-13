BEGIN;
-- No Ticket/profile/session/history is rewritten. Never adopt legacy 23/30-day
-- automatic suspension as a new, unapproved policy.
INSERT INTO public.system_settings(key,value) VALUES
 ('dormancy_review_days',''),('dormancy_auto_lock_enabled','false'),('ticket_auto_disposal_enabled','false')
ON CONFLICT(key) DO NOTHING;

-- Disable both direct internal and service-wrapper legacy processing paths.
CREATE OR REPLACE FUNCTION private.process_ticket_retention(p_batch_size integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_batch_size IS NULL OR p_batch_size<1 OR p_batch_size>500 THEN RAISE EXCEPTION 'invalid_retention_batch_size'; END IF;
 RETURN jsonb_build_object('processed_at',clock_timestamp(),'processed_count',0,'failed_count',0,
  'activities_anonymized',0,'notifications_deleted',0,'batch_size',p_batch_size,'reason','administrator_review_required');
END $$;

CREATE FUNCTION private.reject_unapproved_ticket_disposal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'ticket_disposal_not_enabled' USING ERRCODE='42501'; END $$;
REVOKE ALL ON FUNCTION private.reject_unapproved_ticket_disposal() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER ticket_disposal_guard BEFORE DELETE ON public.tickets FOR EACH ROW EXECUTE FUNCTION private.reject_unapproved_ticket_disposal();
CREATE TRIGGER activity_disposal_guard BEFORE DELETE ON public.activities FOR EACH ROW EXECUTE FUNCTION private.reject_unapproved_ticket_disposal();
CREATE TRIGGER attachment_disposal_guard BEFORE DELETE ON public.ticket_attachments FOR EACH ROW EXECUTE FUNCTION private.reject_unapproved_ticket_disposal();
CREATE TRIGGER ticket_truncate_guard BEFORE TRUNCATE ON public.tickets FOR EACH STATEMENT EXECUTE FUNCTION private.reject_unapproved_ticket_disposal();
CREATE TRIGGER activity_truncate_guard BEFORE TRUNCATE ON public.activities FOR EACH STATEMENT EXECUTE FUNCTION private.reject_unapproved_ticket_disposal();
CREATE TRIGGER attachment_truncate_guard BEFORE TRUNCATE ON public.ticket_attachments FOR EACH STATEMENT EXECUTE FUNCTION private.reject_unapproved_ticket_disposal();
CREATE FUNCTION private.reject_unapproved_ticket_anonymization() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF (NEW.retention_state='anonymized' AND OLD.retention_state IS DISTINCT FROM NEW.retention_state)
  OR (NEW.retention_processed_at IS NOT NULL AND OLD.retention_processed_at IS DISTINCT FROM NEW.retention_processed_at) THEN
  RAISE EXCEPTION 'ticket_disposal_not_enabled' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.reject_unapproved_ticket_anonymization() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER ticket_anonymization_guard BEFORE UPDATE ON public.tickets FOR EACH ROW EXECUTE FUNCTION private.reject_unapproved_ticket_anonymization();

CREATE FUNCTION public.read_lifecycle_review(p_kind text,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET timezone='UTC' AS $$
DECLARE rows jsonb; days integer; stored text;
BEGIN
 PERFORM private.require_request_app_session(false);
 IF NOT public.is_company_admin() THEN RAISE EXCEPTION 'company_role_required' USING ERRCODE='42501'; END IF;
 IF p_offset IS NULL OR p_offset<0 OR p_offset>1000000 THEN RAISE EXCEPTION 'invalid_offset'; END IF;
 SELECT value INTO stored FROM public.system_settings WHERE key='dormancy_review_days';
 IF stored ~ '^[0-9]{1,5}$' AND stored::integer BETWEEN 1 AND 36500 THEN days:=stored::integer; END IF;
 IF p_kind='tickets' THEN
  SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]'::jsonb) INTO rows FROM (
   SELECT t.id,t.status,t.created_at,t.created_at+interval '3 years' AS review_due_at,t.retention_state,t.version,
    (SELECT count(*) FROM public.activities a WHERE a.ticket_id=t.id) AS activity_count,
    (SELECT count(*) FROM public.ticket_attachments a WHERE a.ticket_id=t.id) AS attachment_count,
    (SELECT count(*) FROM audit.access_logs a WHERE a.target_type='Ticket' AND a.target_id=t.id::text) AS ticket_audit_count
   FROM public.tickets t WHERE t.created_at+interval '3 years'<=clock_timestamp() AND t.retention_state<>'anonymized'
   ORDER BY t.created_at,t.id LIMIT 100 OFFSET p_offset) q;
 ELSIF p_kind='accounts' THEN
  SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]'::jsonb) INTO rows FROM (
   SELECT p.id,p.display_name,p.email,p.organization_id,p.role,p.account_status,p.created_at,
    GREATEST(p.last_login_at,s.last_login) AS last_login_at,
    GREATEST(p.last_login_at,s.last_login) IS NULL AS no_confirmed_login,
    CASE WHEN days IS NULL THEN NULL ELSE
     COALESCE(GREATEST(p.last_login_at,s.last_login),p.created_at)+days*interval '1 day'<=clock_timestamp() END AS review_candidate,
    p.inactive_check_exempt OR (p.role='admin' AND o.type='operator') AS automatic_lock_exempt
   FROM public.profiles p LEFT JOIN public.organizations o ON o.id=p.organization_id
   LEFT JOIN LATERAL (SELECT max(authenticated_at) AS last_login FROM private.app_sessions WHERE profile_id=p.id) s ON true
   ORDER BY COALESCE(GREATEST(p.last_login_at,s.last_login),p.created_at),p.id LIMIT 100 OFFSET p_offset) q;
 ELSE RAISE EXCEPTION 'invalid_review_kind'; END IF;
 PERFORM audit.append_access_log(p_action=>'lifecycle_review_read',p_target_type=>'LifecycleReview',
  p_metadata=>jsonb_build_object('kind',p_kind,'row_count',jsonb_array_length(rows)));
 RETURN jsonb_build_object('rows',rows,'dormancy_review_days',days,'automatic_lock_enabled',false,'automatic_disposal_enabled',false);
END $$;

CREATE FUNCTION public.set_dormancy_review_days(p_days integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.profiles; setting_id uuid; old_value text;
BEGIN
 actor:=private.require_company_actor(ARRAY['admin']);
 IF p_days IS NOT NULL AND (p_days<1 OR p_days>36500) THEN RAISE EXCEPTION 'invalid_dormancy_days'; END IF;
 SELECT value INTO old_value FROM public.system_settings WHERE key='dormancy_review_days' FOR UPDATE;
 UPDATE public.system_settings SET value=COALESCE(p_days::text,'') WHERE key='dormancy_review_days' RETURNING id INTO setting_id;
 PERFORM audit.append_access_log(p_action=>'dormancy_review_policy_changed',p_target_type=>'SystemSetting',p_target_id=>setting_id::text,
  p_metadata=>jsonb_build_object('previous_days',old_value,'new_days',p_days,'automatic_lock_enabled',false));
 RETURN jsonb_build_object('id',setting_id,'dormancy_review_days',p_days,'automatic_lock_enabled',false);
END $$;

CREATE FUNCTION public.review_ticket_retention(p_ticket_id uuid,p_decision text,p_expected_version integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET timezone='UTC' AS $$
DECLARE actor public.profiles; ticket public.tickets; next_state text;
BEGIN
 actor:=private.require_company_actor(ARRAY['admin']);
 IF p_decision NOT IN ('retain','request_disposal_review') OR p_decision IS NULL THEN RAISE EXCEPTION 'invalid_retention_decision'; END IF;
 SELECT * INTO ticket FROM public.tickets WHERE id=p_ticket_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ticket_not_found'; END IF;
 IF p_expected_version IS DISTINCT FROM ticket.version THEN RAISE EXCEPTION 'stale_ticket_version' USING ERRCODE='40001'; END IF;
 IF ticket.retention_state='anonymized' OR ticket.created_at+interval '3 years'>clock_timestamp() THEN RAISE EXCEPTION 'ticket_not_review_eligible'; END IF;
 next_state:=CASE WHEN p_decision='retain' THEN 'retained' ELSE 'disposal_review' END;
 UPDATE public.tickets SET retention_state=next_state,version=version+1,updated_at=clock_timestamp() WHERE id=p_ticket_id;
 PERFORM audit.append_access_log(p_action=>'ticket_retention_review',p_target_type=>'Ticket',p_target_id=>p_ticket_id::text,
  p_metadata=>jsonb_build_object('previous_state',ticket.retention_state,'new_state',next_state,'decision',p_decision,'disposal_executed',false));
 RETURN jsonb_build_object('id',p_ticket_id,'retention_state',next_state,'version',ticket.version+1);
END $$;
REVOKE ALL ON FUNCTION public.read_lifecycle_review(text,integer),public.set_dormancy_review_days(integer),public.review_ticket_retention(uuid,text,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.read_lifecycle_review(text,integer),public.set_dormancy_review_days(integer),public.review_ticket_retention(uuid,text,integer) TO authenticated;
CREATE INDEX tickets_retention_review_created_idx ON public.tickets(created_at,id) WHERE retention_state<>'anonymized';
-- Reactivation is completed below using the existing scoped, audited RPC.
CREATE OR REPLACE FUNCTION public.reactivate_profile(p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_target public.profiles%ROWTYPE;
BEGIN
    v_actor := private.require_user_role_admin();
    SELECT p.* INTO v_target FROM public.profiles AS p WHERE p.id = p_profile_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'profile_not_found';
    END IF;
    IF NOT public.can_manage_organization(v_target.organization_id) THEN
        RAISE EXCEPTION 'organization_management_forbidden' USING ERRCODE='42501';
    END IF;
    IF v_target.account_status NOT IN ('suspended','disabled') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'profile_not_suspended';
    END IF;
    UPDATE public.profiles SET account_status = 'active', updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_profile_id;
    PERFORM private.revoke_profile_sessions(p_profile_id);
    PERFORM audit.append_access_log(p_action => '사용자 상태 변경', p_target_type => 'Profile',
        p_target_id => p_profile_id::text,
        p_metadata => pg_catalog.jsonb_build_object('profile_id', p_profile_id,
            'old_account_status', v_target.account_status, 'new_account_status', 'active'));
    RETURN pg_catalog.jsonb_build_object('id', p_profile_id, 'account_status', 'active');
END;
$function$;
COMMIT;
