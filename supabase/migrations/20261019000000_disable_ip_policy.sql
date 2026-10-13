BEGIN;
CREATE FUNCTION public.disable_ip_policy(p_expected_version bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.profiles;cfg private.gateway_config;request_id uuid:=gen_random_uuid();
BEGIN
 actor:=private.require_company_actor(ARRAY['admin']);
 SELECT * INTO STRICT cfg FROM private.gateway_config WHERE id FOR UPDATE;
 IF cfg.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'stale_policy' USING ERRCODE='40001'; END IF;
 UPDATE private.gateway_config SET mode='monitor',pending=NULL,version=version+1 WHERE id;
 PERFORM audit.append_access_log(p_action=>'ip_policy_disabled',p_target_type=>'IPPolicy',
 p_metadata=>jsonb_build_object('previous_mode',cfg.mode,'previous_version',cfg.version,'pending_cancelled',cfg.pending IS NOT NULL));
 RETURN jsonb_build_object('id',request_id,'mode','monitor');
END $$;
REVOKE ALL ON FUNCTION public.disable_ip_policy(bigint) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.disable_ip_policy(bigint) TO authenticated;
COMMIT;
