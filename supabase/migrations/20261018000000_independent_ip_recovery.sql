BEGIN;
CREATE TABLE private.ip_operator_recovery(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),auth_user_id uuid NOT NULL REFERENCES auth.users(id),
 verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),verified_by text NOT NULL,
 incident_reference text NOT NULL,acknowledged_at timestamptz
);
ALTER TABLE private.ip_operator_recovery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.ip_operator_recovery FROM PUBLIC,anon,authenticated,service_role;

-- Only the SQL Editor postgres role can attest; no public RPC or service key path.
CREATE FUNCTION private.verify_ip_operator_recovery(p_reference text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE admin_user uuid;record_id uuid;cfg private.gateway_config;
BEGIN
 IF current_user<>'postgres' OR NOT has_table_privilege(current_user,'private.gateway_config','UPDATE') THEN RAISE EXCEPTION 'operator_permission_required' USING ERRCODE='42501'; END IF;
 IF p_reference IS NULL OR length(trim(p_reference)) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'reference_required'; END IF;
 SELECT * INTO STRICT cfg FROM private.gateway_config WHERE id FOR UPDATE;
 IF NOT cfg.enabled OR cfg.mode<>'monitor' OR cfg.pending IS NOT NULL THEN RAISE EXCEPTION 'monitor_without_pending_required'; END IF;
 SELECT p.auth_user_id INTO STRICT admin_user FROM public.profiles p JOIN public.organizations o ON o.id=p.organization_id
 WHERE p.role='admin' AND p.account_status='active' AND o.type='operator';
 -- Exercise the same write privilege and audit path used by emergency recovery.
 -- No policy value, version, pending snapshot, RLS or user status is changed.
 UPDATE private.gateway_config SET mode=mode,pending=pending,version=version WHERE id;
 INSERT INTO private.ip_operator_recovery(auth_user_id,verified_by,incident_reference)
 VALUES(admin_user,session_user,trim(p_reference)) RETURNING id INTO record_id;
 PERFORM audit.append_access_log(p_action=>'ip_operator_recovery_verified',p_target_type=>'IPPolicy',p_target_id=>record_id::text,
 p_metadata=>jsonb_build_object('source','supabase_sql_editor','db_session_user',session_user,'incident_reference',trim(p_reference),
 'ip_unavailable_reason','sql_editor_has_no_verified_gateway_client_ip'));
 RETURN jsonb_build_object('id',record_id,'verified',true,'valid_until',clock_timestamp()+interval '7 days');
END $$;
REVOKE ALL ON FUNCTION private.verify_ip_operator_recovery(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION private.verify_ip_operator_recovery(text) TO postgres;

CREATE FUNCTION public.acknowledge_ip_operator_recovery(p_id uuid,p_approved boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.profiles;
BEGIN
 actor:=private.require_company_actor(ARRAY['admin']);
 IF p_approved IS DISTINCT FROM true THEN RAISE EXCEPTION 'explicit_approval_required'; END IF;
 UPDATE private.ip_operator_recovery SET acknowledged_at=clock_timestamp()
 WHERE id=p_id AND auth_user_id=actor.auth_user_id AND verified_at>clock_timestamp()-interval '7 days';
 IF NOT FOUND THEN RAISE EXCEPTION 'operator_recovery_not_verified'; END IF;
 PERFORM audit.append_access_log(p_action=>'ip_operator_recovery_acknowledged',p_target_type=>'IPPolicy',p_target_id=>p_id::text);
 RETURN jsonb_build_object('id',p_id,'acknowledged',true);
END $$;
REVOKE ALL ON FUNCTION public.acknowledge_ip_operator_recovery(uuid,boolean) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.acknowledge_ip_operator_recovery(uuid,boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.read_ip_policy() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.profiles;cfg private.gateway_config;rows jsonb;
BEGIN
 actor:=private.require_company_actor(ARRAY['admin']);
 SELECT * INTO cfg FROM private.gateway_config WHERE id;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'ip_address',ip_address,'description',description,'is_active',is_active) ORDER BY created_at,id),'[]') INTO rows FROM public.ip_whitelist;
 RETURN jsonb_build_object('rows',rows,'mode',cfg.mode,'version',cfg.version,'pending',cfg.pending IS NOT NULL,
  'pending_expires_at',cfg.pending->>'expires_at','current_ip',(SELECT host(ip) FROM private.gateway_nonces WHERE id=NULLIF(current_setting('partnerdesk.gateway_request_id',true),'')::uuid),
  'operator_recovery',(SELECT jsonb_build_object('id',r.id,'verified_at',r.verified_at,'expires_at',r.verified_at+interval '7 days',
 'acknowledged',r.acknowledged_at>clock_timestamp()-interval '1 day') FROM private.ip_operator_recovery r
 WHERE r.auth_user_id=actor.auth_user_id AND r.verified_at>clock_timestamp()-interval '7 days' ORDER BY r.verified_at DESC LIMIT 1),
 'operator_recovery_ready',EXISTS(SELECT 1 FROM private.ip_operator_recovery r WHERE r.auth_user_id=actor.auth_user_id AND r.verified_at>clock_timestamp()-interval '7 days' AND r.acknowledged_at>clock_timestamp()-interval '1 day'),'recovery_confirmed',EXISTS(SELECT 1 FROM private.gateway_recovery WHERE auth_user_id=actor.auth_user_id AND confirmed_at>clock_timestamp()-interval '1 day'));
END $$;

CREATE OR REPLACE FUNCTION public.save_ip_entry(p_id uuid,p_ip text,p_description text,p_active boolean,p_expected_version bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.profiles;cfg private.gateway_config;entry_id uuid;address text;old_entries jsonb;current_ip inet;
BEGIN
 actor:=private.require_company_actor(ARRAY['admin']);
 address:=network(p_ip::inet)::text;
 IF p_active IS NULL OR length(COALESCE(p_description,''))>200 THEN RAISE EXCEPTION 'invalid_ip_entry'; END IF;
 SELECT * INTO cfg FROM private.gateway_config WHERE id FOR UPDATE;
 IF cfg.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'stale_policy' USING ERRCODE='40001'; END IF;
 IF cfg.pending IS NOT NULL THEN RAISE EXCEPTION 'policy_confirmation_required'; END IF;
 SELECT jsonb_agg(to_jsonb(x)) INTO old_entries FROM public.ip_whitelist x;
 IF p_id IS NULL THEN INSERT INTO public.ip_whitelist(ip_address,description,is_active,created_by_profile_id) VALUES(address,p_description,p_active,actor.id) RETURNING id INTO entry_id;
 ELSE UPDATE public.ip_whitelist SET ip_address=address,description=p_description,is_active=p_active,updated_at=clock_timestamp() WHERE id=p_id RETURNING id INTO entry_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'entry_not_found'; END IF;
 END IF;
 SELECT ip INTO current_ip FROM private.gateway_nonces WHERE id=NULLIF(current_setting('partnerdesk.gateway_request_id',true),'')::uuid;
 IF cfg.mode='enforced' THEN
  IF current_ip IS NULL OR NOT EXISTS(SELECT 1 FROM public.ip_whitelist WHERE is_active AND current_ip <<= ip_address::inet)
   OR NOT (EXISTS(SELECT 1 FROM private.ip_operator_recovery r WHERE r.auth_user_id=actor.auth_user_id AND r.verified_at>clock_timestamp()-interval '7 days' AND r.acknowledged_at>clock_timestamp()-interval '1 day') OR EXISTS(SELECT 1 FROM private.gateway_recovery r WHERE r.auth_user_id=actor.auth_user_id AND r.ip<>current_ip AND r.confirmed_at>clock_timestamp()-interval '1 day'
    AND EXISTS(SELECT 1 FROM public.ip_whitelist w WHERE w.is_active AND r.ip <<= w.ip_address::inet))) THEN RAISE EXCEPTION 'administrator_lockout_risk'; END IF;
 END IF;
 UPDATE private.gateway_config SET version=version+1,pending=CASE WHEN cfg.mode='enforced' THEN jsonb_build_object('old_mode',cfg.mode,'old_entries',COALESCE(old_entries,'[]'),
  'started_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '10 minutes','request_id',current_setting('partnerdesk.gateway_request_id',true)) ELSE NULL END WHERE id;
 PERFORM audit.append_access_log(p_action=>'ip_allowlist_changed',p_target_type=>'IPWhitelist',p_target_id=>entry_id::text,p_metadata=>jsonb_build_object('is_active',p_active,'network',address));
 RETURN jsonb_build_object('id',entry_id,'ip_address',address);
END $$;

CREATE OR REPLACE FUNCTION public.request_ip_activation(p_expected_version bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.profiles;cfg private.gateway_config;v_ip inet;entries jsonb;
BEGIN
 actor:=private.require_company_actor(ARRAY['admin']);
 SELECT * INTO cfg FROM private.gateway_config WHERE id FOR UPDATE;
 IF cfg.version IS DISTINCT FROM p_expected_version OR cfg.pending IS NOT NULL OR cfg.mode<>'monitor' THEN RAISE EXCEPTION 'invalid_transition'; END IF;
 SELECT n.ip INTO v_ip FROM private.gateway_nonces n WHERE id=NULLIF(current_setting('partnerdesk.gateway_request_id',true),'')::uuid;
 IF v_ip IS NULL OR NOT EXISTS(SELECT 1 FROM public.ip_whitelist WHERE is_active AND v_ip <<= ip_address::inet)
  OR NOT (EXISTS(SELECT 1 FROM private.ip_operator_recovery r WHERE r.auth_user_id=actor.auth_user_id AND r.verified_at>clock_timestamp()-interval '7 days' AND r.acknowledged_at>clock_timestamp()-interval '1 day') OR EXISTS(SELECT 1 FROM private.gateway_recovery r WHERE r.auth_user_id=actor.auth_user_id AND r.ip<>v_ip AND r.confirmed_at>clock_timestamp()-interval '1 day'
   AND EXISTS(SELECT 1 FROM public.ip_whitelist w WHERE w.is_active AND r.ip <<= w.ip_address::inet))) THEN RAISE EXCEPTION 'recovery_path_required'; END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(x)),'[]') INTO entries FROM public.ip_whitelist x;
 UPDATE private.gateway_config SET mode='enforced',version=version+1,pending=jsonb_build_object('old_mode','monitor','old_entries',entries,
  'started_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '10 minutes','request_id',current_setting('partnerdesk.gateway_request_id',true)) WHERE id;
 PERFORM audit.append_access_log(p_action=>'ip_policy_activation_requested',p_target_type=>'IPPolicy');
 RETURN jsonb_build_object('id',gen_random_uuid(),'reauthentication_required',true);
END $$;

COMMIT;
