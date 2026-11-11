BEGIN;

-- Approved 2026-11-09: Partner accounts only. Never alter Company/Guest/exempt accounts.
ALTER TABLE public.profiles ADD COLUMN inactivity_reactivated_at timestamptz;
CREATE TABLE private.inactivity_mail_queue (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN ('warning','suspended')),
 baseline_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','cancelled')),
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_id uuid, leased_until timestamptz, sent_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_error text,
 UNIQUE(profile_id,kind,baseline_at)
);
ALTER TABLE private.inactivity_mail_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.inactivity_mail_queue FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX inactivity_mail_due_idx ON private.inactivity_mail_queue(next_attempt_at) WHERE state IN ('pending','sending');

INSERT INTO public.system_settings(key,value) VALUES
 ('dormancy_auto_lock_enabled','true'),('dormancy_warning_days','23'),('dormancy_suspend_days','30')
ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;

-- Login/recovery cancels undelivered notices. Reactivation starts a grace period,
-- without fabricating a successful login or changing the historical timestamp.
CREATE FUNCTION private.inactivity_profile_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.account_status='active' AND OLD.account_status IN ('suspended','disabled') THEN
  NEW.inactivity_reactivated_at:=clock_timestamp();
 END IF;
 IF NEW.last_login_at IS DISTINCT FROM OLD.last_login_at OR
    (NEW.account_status='active' AND OLD.account_status IS DISTINCT FROM NEW.account_status) OR
    NEW.inactive_check_exempt OR NEW.role='guest' OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
  UPDATE private.inactivity_mail_queue SET state='cancelled',lease_id=NULL,leased_until=NULL
   WHERE profile_id=NEW.id AND state IN ('pending','sending');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inactivity_profile_changed BEFORE UPDATE ON public.profiles
 FOR EACH ROW EXECUTE FUNCTION private.inactivity_profile_changed();
REVOKE ALL ON FUNCTION private.inactivity_profile_changed() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.process_inactive_accounts() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p record; baseline timestamptz; current_time_at timestamptz:=clock_timestamp();
 target_status text; mail_kind text; warned integer:=0; suspended integer:=0;
BEGIN
 IF NOT pg_try_advisory_xact_lock(20261109,1) THEN RETURN jsonb_build_object('busy',true); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.system_settings WHERE key='dormancy_auto_lock_enabled' AND value='true') THEN
  RETURN jsonb_build_object('enabled',false);
 END IF;
 FOR p IN SELECT u.* FROM public.profiles u JOIN public.organizations o ON o.id=u.organization_id
  WHERE o.type='partner' AND o.is_active AND u.role IN ('admin','operator')
   AND NOT u.inactive_check_exempt AND u.auth_user_id IS NOT NULL
   AND u.account_status IN ('active','inactive_warning') AND u.last_login_at IS NOT NULL
  ORDER BY u.id FOR UPDATE OF u SKIP LOCKED
 LOOP
  SELECT GREATEST(p.last_login_at,p.inactivity_reactivated_at,max(s.authenticated_at)) INTO baseline
   FROM private.app_sessions s WHERE s.profile_id=p.id;
  IF baseline<=current_time_at-interval '30 days' THEN
   target_status:='suspended';mail_kind:='suspended';suspended:=suspended+1;
  ELSIF baseline<=current_time_at-interval '23 days' AND p.account_status<>'inactive_warning' THEN
   target_status:='inactive_warning';mail_kind:='warning';warned:=warned+1;
  ELSE CONTINUE; END IF;
  UPDATE public.profiles SET account_status=target_status,updated_at=current_time_at WHERE id=p.id;
  IF target_status='suspended' THEN
   PERFORM private.revoke_profile_sessions(p.id);
   UPDATE private.inactivity_mail_queue SET state='cancelled',lease_id=NULL,leased_until=NULL
    WHERE profile_id=p.id AND kind='warning' AND state IN ('pending','sending');
  END IF;
  INSERT INTO private.inactivity_mail_queue(profile_id,kind,baseline_at) VALUES(p.id,mail_kind,baseline)
   ON CONFLICT(profile_id,kind,baseline_at) DO NOTHING;
  PERFORM audit.append_access_log(p_action=>'inactivity_account_'||mail_kind,p_target_type=>'Profile',p_target_id=>p.id::text,
   p_metadata=>jsonb_build_object('old_account_status',p.account_status,'new_account_status',target_status,'baseline_at',baseline,'automatic',true));
 END LOOP;
 RETURN jsonb_build_object('enabled',true,'warned_count',warned,'suspended_count',suspended,'processed_at',current_time_at);
END $$;
REVOKE ALL ON FUNCTION private.process_inactive_accounts() FROM PUBLIC,anon,authenticated,service_role;

-- Worker receives only valid, leased messages. Leases recover after a crashed worker.
CREATE FUNCTION public.backend_claim_inactivity_mail() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item record; lease uuid; messages jsonb:='[]'; baseline timestamptz;
BEGIN
 FOR item IN SELECT q.*,p.email,p.account_status,p.role,p.inactive_check_exempt,p.last_login_at,p.inactivity_reactivated_at,o.type,o.is_active
  FROM private.inactivity_mail_queue q JOIN public.profiles p ON p.id=q.profile_id JOIN public.organizations o ON o.id=p.organization_id
  WHERE (q.state='pending' AND q.next_attempt_at<=clock_timestamp()) OR
        (q.state='sending' AND q.leased_until<=clock_timestamp())
  ORDER BY q.next_attempt_at,q.id LIMIT 10 FOR UPDATE OF q SKIP LOCKED
 LOOP
  SELECT GREATEST(item.last_login_at,item.inactivity_reactivated_at,max(authenticated_at)) INTO baseline
   FROM private.app_sessions WHERE profile_id=item.profile_id;
  IF item.type<>'partner' OR NOT item.is_active OR item.role NOT IN ('admin','operator') OR item.inactive_check_exempt OR
    baseline IS DISTINCT FROM item.baseline_at OR item.account_status<>(CASE WHEN item.kind='warning' THEN 'inactive_warning' ELSE 'suspended' END) THEN
   UPDATE private.inactivity_mail_queue SET state='cancelled',lease_id=NULL,leased_until=NULL WHERE id=item.id;CONTINUE;
  END IF;
  lease:=gen_random_uuid();
  UPDATE private.inactivity_mail_queue SET state='sending',attempts=attempts+1,lease_id=lease,leased_until=clock_timestamp()+interval '5 minutes' WHERE id=item.id;
  messages:=messages||jsonb_build_array(jsonb_build_object('id',item.id,'lease_id',lease,'email',item.email,'kind',item.kind));
 END LOOP;
 RETURN jsonb_build_object('messages',messages);
END $$;

CREATE FUNCTION public.backend_finish_inactivity_mail(p_id uuid,p_lease_id uuid,p_sent boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item private.inactivity_mail_queue; changed integer;
BEGIN
 SELECT * INTO item FROM private.inactivity_mail_queue WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR item.state<>'sending' OR item.lease_id IS DISTINCT FROM p_lease_id THEN RETURN jsonb_build_object('ok',false); END IF;
 UPDATE private.inactivity_mail_queue SET state=CASE WHEN p_sent THEN 'sent' ELSE 'pending' END,
  sent_at=CASE WHEN p_sent THEN clock_timestamp() ELSE NULL END,
  next_attempt_at=clock_timestamp()+make_interval(mins=>LEAST(60,GREATEST(1,item.attempts*5))),
  last_error=CASE WHEN p_sent THEN NULL ELSE 'smtp_delivery_failed' END,lease_id=NULL,leased_until=NULL WHERE id=p_id;
 PERFORM audit.append_access_log(p_action=>CASE WHEN p_sent THEN 'inactivity_mail_sent' ELSE 'inactivity_mail_failed' END,
  p_target_type=>'Profile',p_target_id=>item.profile_id::text,p_metadata=>jsonb_build_object('mail_id',p_id,'kind',item.kind,'attempt',item.attempts));
 RETURN jsonb_build_object('ok',true);
END $$;
REVOKE ALL ON FUNCTION public.backend_claim_inactivity_mail(),public.backend_finish_inactivity_mail(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.backend_claim_inactivity_mail(),public.backend_finish_inactivity_mail(uuid,uuid,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.read_lifecycle_review(p_kind text,p_offset integer DEFAULT 0) RETURNS jsonb
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
    p.inactive_check_exempt OR o.type<>'partner' OR p.role='guest' OR p.last_login_at IS NULL AS automatic_lock_exempt
   FROM public.profiles p LEFT JOIN public.organizations o ON o.id=p.organization_id
   LEFT JOIN LATERAL (SELECT max(authenticated_at) AS last_login FROM private.app_sessions WHERE profile_id=p.id) s ON true
   ORDER BY COALESCE(GREATEST(p.last_login_at,s.last_login),p.created_at),p.id LIMIT 100 OFFSET p_offset) q;
 ELSE RAISE EXCEPTION 'invalid_review_kind'; END IF;
 PERFORM audit.append_access_log(p_action=>'lifecycle_review_read',p_target_type=>'LifecycleReview',
  p_metadata=>jsonb_build_object('kind',p_kind,'row_count',jsonb_array_length(rows)));
 RETURN jsonb_build_object('rows',rows,'dormancy_review_days',days,'automatic_lock_enabled',EXISTS(SELECT 1 FROM public.system_settings WHERE key='dormancy_auto_lock_enabled' AND value='true'),'automatic_disposal_enabled',false);
END $$;


COMMIT;
