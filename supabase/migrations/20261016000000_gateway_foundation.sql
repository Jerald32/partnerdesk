BEGIN;
CREATE TABLE private.gateway_config(id boolean PRIMARY KEY DEFAULT true CHECK(id),signing_key bytea,enabled boolean NOT NULL DEFAULT false,mode text NOT NULL DEFAULT 'monitor' CHECK(mode IN ('monitor','enforced')),version bigint NOT NULL DEFAULT 1,pending jsonb);
INSERT INTO private.gateway_config(id) VALUES(true);
CREATE TABLE private.gateway_nonces(id uuid PRIMARY KEY,used_txid bigint NOT NULL,auth_user_id uuid,session_hash text,ip inet,expires_at timestamptz NOT NULL);
CREATE INDEX gateway_nonce_expiry ON private.gateway_nonces(expires_at);
CREATE TABLE private.gateway_recovery(auth_user_id uuid NOT NULL,ip inet NOT NULL,confirmed_at timestamptz NOT NULL,PRIMARY KEY(auth_user_id,ip));
ALTER TABLE private.gateway_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.gateway_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.gateway_recovery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.gateway_config,private.gateway_nonces,private.gateway_recovery FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.consume_gateway_proof(p_payload text,p_signature text,p_user uuid,p_session text,p_path text,p_method text,p_body text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE raw bytea;p jsonb;k bytea;expected bytea;provided bytea;difference integer:=0;i integer;now_seconds bigint:=floor(extract(epoch FROM clock_timestamp()));
BEGIN
 IF length(p_payload)>4096 OR p_signature !~ '^[0-9a-f]{64}$' OR p_payload IS NULL OR p_signature IS NULL THEN RAISE EXCEPTION 'gateway_proof_required' USING ERRCODE='42501'; END IF;
 SELECT signing_key INTO k FROM private.gateway_config WHERE id;
 IF k IS NULL THEN RAISE EXCEPTION 'gateway_not_configured' USING ERRCODE='42501'; END IF;
 raw:=decode(p_payload,'base64');expected:=extensions.hmac(raw,k,'sha256');provided:=decode(p_signature,'hex');
 FOR i IN 0..31 LOOP difference:=difference | (get_byte(expected,i) # get_byte(provided,i)); END LOOP;
 IF difference<>0 THEN RAISE EXCEPTION 'gateway_signature_invalid' USING ERRCODE='42501'; END IF;
 p:=convert_from(raw,'UTF8')::jsonb;
 IF p->>'v'<>'1' OR (p->>'exp')::bigint<=now_seconds OR (p->>'iat')::bigint>now_seconds+2
  OR (p->>'exp')::bigint-(p->>'iat')::bigint<>20 THEN RAISE EXCEPTION 'gateway_proof_expired' USING ERRCODE='42501'; END IF;
 IF (p->>'sub')::uuid IS DISTINCT FROM p_user OR p->>'session' IS DISTINCT FROM p_session
  OR p->>'path' IS DISTINCT FROM p_path OR p->>'method' IS DISTINCT FROM p_method
  OR p->>'body' IS DISTINCT FROM p_body THEN RAISE EXCEPTION 'gateway_binding_invalid' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM private.gateway_config WHERE mode='enforced') AND
  ((p->>'ip') IS NULL OR NOT EXISTS(SELECT 1 FROM public.ip_whitelist WHERE is_active AND (p->>'ip')::inet <<= ip_address::inet)) THEN
  RAISE EXCEPTION 'ip_not_allowed' USING ERRCODE='42501'; END IF;
 DELETE FROM private.gateway_nonces WHERE expires_at<clock_timestamp()-interval '1 minute';
 INSERT INTO private.gateway_nonces(id,used_txid,auth_user_id,session_hash,ip,expires_at)
 VALUES((p->>'id')::uuid,txid_current(),p_user,p_session,(p->>'ip')::inet,to_timestamp((p->>'exp')::bigint));
 PERFORM set_config('partnerdesk.gateway_request_id',p->>'id',true);
 RETURN p;
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'gateway_proof_replayed' USING ERRCODE='42501';
END $$;
CREATE FUNCTION private.has_gateway_context() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT (SELECT enabled FROM private.gateway_config WHERE id) THEN RETURN true; END IF;
 RETURN EXISTS(SELECT 1 FROM private.gateway_nonces WHERE id=NULLIF(current_setting('partnerdesk.gateway_request_id',true),'')::uuid
  AND used_txid=txid_current() AND auth_user_id IS NOT DISTINCT FROM auth.uid());
END $$;
CREATE FUNCTION private.consume_request_gateway(p_request text,p_path text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE h jsonb:=COALESCE(NULLIF(current_setting('request.headers',true),''),'{}')::jsonb;
BEGIN RETURN private.consume_gateway_proof(h->>'x-partnerdesk-proof',h->>'x-partnerdesk-signature',auth.uid(),private.request_app_session_token_hash(),p_path,'POST',encode(sha256(convert_to(p_request,'UTF8')),'hex')); END $$;

-- POST wrapper avoids PostgREST GET read-only transactions: one-time consumption
-- and the business read occur atomically, under the original authenticated role.
CREATE FUNCTION public.gateway_read(p_request text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE q jsonb:=p_request::jsonb;tbl text:=q->>'table';f jsonb;o jsonb;col text;where_sql text:='true';order_sql text:='';values_sql text;rows jsonb;total bigint;lim integer:=(q->>'limit')::integer;off integer:=(q->>'offset')::integer;related text:='';
BEGIN
 PERFORM private.consume_request_gateway(p_request,'rpc/gateway_read');
 BEGIN
 IF tbl NOT IN ('profiles','organizations','partner_details','businesses','service_partners','tickets','activities','ticket_attachments','notifications','role_requests','privacy_consents','system_settings','ip_whitelist') OR tbl IS NULL OR lim NOT BETWEEN 1 AND 1000 OR off NOT BETWEEN 0 AND 1000000 THEN RAISE EXCEPTION 'invalid_gateway_query'; END IF;
 FOR f IN SELECT * FROM jsonb_array_elements(q->'filters') LOOP
  col:=f->>'column';IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=('public.'||tbl)::regclass AND attname=col AND attnum>0 AND NOT attisdropped) THEN RAISE EXCEPTION 'invalid_column'; END IF;
  IF f->>'op'='eq' THEN where_sql:=where_sql||format(' AND to_jsonb(r)->>%L=%L',col,f->>'value');
  ELSIF f->>'op'='in' THEN
   SELECT string_agg(quote_literal(value),',') INTO values_sql FROM jsonb_array_elements_text(f->'values');
   where_sql:=where_sql||CASE WHEN values_sql IS NULL THEN ' AND false' ELSE format(' AND to_jsonb(r)->>%L IN (%s)',col,values_sql) END;
  ELSE RAISE EXCEPTION 'invalid_filter'; END IF;
 END LOOP;
 FOR o IN SELECT * FROM jsonb_array_elements(q->'order') LOOP
  col:=o->>'column';IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=('public.'||tbl)::regclass AND attname=col AND attnum>0 AND NOT attisdropped) OR o->>'direction' NOT IN ('asc','desc') THEN RAISE EXCEPTION 'invalid_order'; END IF;
  order_sql:=order_sql||CASE WHEN order_sql='' THEN '' ELSE ',' END||format('r.%I %s',col,o->>'direction');
 END LOOP;
 IF order_sql='' THEN RAISE EXCEPTION 'order_required'; END IF;
 IF tbl='profiles' THEN related:=', ''organization'',(SELECT to_jsonb(x) FROM public.organizations x WHERE x.id=r.organization_id)';
 ELSIF tbl='organizations' THEN related:=', ''partner_details'',(SELECT to_jsonb(x) FROM public.partner_details x WHERE x.organization_id=r.id)';
 ELSIF tbl='service_partners' THEN related:=', ''business'',(SELECT to_jsonb(x) FROM public.businesses x WHERE x.id=r.business_id)'; END IF;
 EXECUTE format('SELECT count(*) FROM public.%I r WHERE %s',tbl,where_sql) INTO total;
 EXECUTE format('SELECT COALESCE(jsonb_agg(x.value),''[]''::jsonb) FROM (SELECT to_jsonb(r)%s AS value FROM public.%I r WHERE %s ORDER BY %s LIMIT $1 OFFSET $2) x',
  CASE WHEN related='' THEN '' ELSE '||jsonb_build_object('||substring(related FROM 3)||')' END,tbl,where_sql,order_sql) INTO rows USING lim,off;
 RETURN jsonb_build_object('rows',rows,'count',total);
 EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('_gateway_error',jsonb_build_object('code',SQLSTATE,'message','query_rejected')); END;
END $$;

CREATE FUNCTION public.gateway_rpc(p_request text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE q jsonb:=p_request::jsonb;n text:=q->>'name';proc record;args text:='';i integer;arg text;result jsonb;type_name text;
BEGIN
 PERFORM private.consume_request_gateway(p_request,'rpc/gateway_rpc');
 BEGIN
 SELECT p.* INTO proc FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='public' AND p.proname=n AND p.prokind='f'
  AND n NOT LIKE 'backend_%' AND n NOT LIKE 'gateway_%' AND has_function_privilege(current_user,p.oid,'EXECUTE') LIMIT 1;
 IF NOT FOUND OR n IN ('enforce_gateway_route','has_valid_app_session') OR n !~ '^[a-z_]+$' THEN RAISE EXCEPTION 'rpc_not_allowed' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(q->'args')<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(q->'args') k WHERE NOT k=ANY(COALESCE(proc.proargnames,ARRAY[]::text[]))) THEN RAISE EXCEPTION 'invalid_rpc_arguments'; END IF;
 FOR i IN 1..proc.pronargs LOOP
  arg:=proc.proargnames[i];IF NOT (q->'args'?arg) THEN CONTINUE; END IF;
  type_name:=format_type(proc.proargtypes[i-1],NULL);
  args:=args||CASE WHEN args='' THEN '' ELSE ',' END||format('%I => ($1->''args''%s%L)::%s',arg,CASE WHEN type_name IN ('json','jsonb') THEN '->' ELSE '->>' END,arg,type_name);
 END LOOP;
 EXECUTE format('SELECT to_jsonb(public.%I(%s))',n,args) INTO result USING q;
 RETURN result;
 EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('_gateway_error',jsonb_build_object('code',SQLSTATE,'message',CASE WHEN SQLSTATE IN ('42501','40001','28000','P0001') THEN SQLERRM ELSE 'mutation_rejected' END)); END;
END $$;
REVOKE ALL ON FUNCTION private.consume_gateway_proof(text,text,uuid,text,text,text,text),private.has_gateway_context() FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA private TO anon,authenticated;
REVOKE ALL ON FUNCTION private.consume_request_gateway(text,text) FROM PUBLIC,service_role;
GRANT EXECUTE ON FUNCTION private.consume_request_gateway(text,text) TO anon,authenticated;
REVOKE ALL ON FUNCTION public.gateway_read(text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.gateway_read(text) TO authenticated;
REVOKE ALL ON FUNCTION public.gateway_rpc(text) FROM PUBLIC,service_role;
GRANT EXECUTE ON FUNCTION public.gateway_rpc(text) TO anon,authenticated;

CREATE FUNCTION public.enforce_gateway_route() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF current_setting('role',true)='service_role' OR NOT (SELECT enabled FROM private.gateway_config WHERE id) THEN RETURN; END IF;
 IF current_setting('request.method',true)<>'POST' OR current_setting('request.path',true) NOT IN ('rpc/gateway_read','rpc/gateway_rpc') THEN
  RAISE EXCEPTION 'gateway_required' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.enforce_gateway_route() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_gateway_route() TO anon,authenticated,service_role;
-- Phase 1 only: gateway enabled remains false until production smoke verification.
ALTER ROLE authenticator SET pgrst.db_pre_request='public.enforce_gateway_route';
NOTIFY pgrst,'reload config';

CREATE FUNCTION public.backend_gateway_policy() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE cfg private.gateway_config;entries jsonb;r jsonb;
BEGIN
 SELECT * INTO cfg FROM private.gateway_config WHERE id FOR UPDATE;
 IF cfg.pending IS NOT NULL AND (cfg.pending->>'expires_at')::timestamptz<=clock_timestamp() THEN
  UPDATE public.ip_whitelist SET is_active=false WHERE id NOT IN (SELECT (x->>'id')::uuid FROM jsonb_array_elements(COALESCE(cfg.pending->'old_entries','[]')) x);
  FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(cfg.pending->'old_entries','[]')) LOOP
   UPDATE public.ip_whitelist SET ip_address=r->>'ip_address',description=r->>'description',is_active=(r->>'is_active')::boolean WHERE id=(r->>'id')::uuid;
  END LOOP;
  UPDATE private.gateway_config SET mode=COALESCE(cfg.pending->>'old_mode','monitor'),pending=NULL,version=version+1 WHERE id RETURNING * INTO cfg;
  PERFORM audit.append_access_log(p_action=>'ip_policy_transition_rolled_back',p_target_type=>'IPPolicy');
 END IF;
 SELECT COALESCE(jsonb_agg(ip_address),'[]') INTO entries FROM public.ip_whitelist WHERE is_active;
 RETURN jsonb_build_object('mode',cfg.mode,'version',cfg.version,'entries',entries,'gateway_enabled',cfg.enabled);
END $$;
CREATE FUNCTION public.backend_gateway_consume(p_payload text,p_signature text,p_user uuid,p_session text,p_body text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN RETURN private.consume_gateway_proof(p_payload,p_signature,p_user,p_session,'functions/app-auth','POST',p_body); END $$;
CREATE FUNCTION public.backend_gateway_audit(p_user uuid,p_ip text,p_path text,p_verdict text,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE old_sub text:=current_setting('request.jwt.claim.sub',true);
BEGIN
 IF p_verdict NOT IN ('monitor_would_deny','ip_denied') OR length(p_path)>200 THEN RAISE EXCEPTION 'invalid_audit_event'; END IF;
 IF EXISTS(SELECT 1 FROM public.profiles WHERE auth_user_id=p_user) THEN PERFORM set_config('request.jwt.claim.sub',p_user::text,true); ELSE PERFORM set_config('request.jwt.claim.sub','',true); END IF;
 PERFORM audit.append_access_log(p_action=>p_verdict,p_target_type=>'Gateway',p_metadata=>jsonb_build_object('path',p_path,'gateway_request_id',p_request_id,'result',CASE WHEN p_verdict='ip_denied' THEN 'denied' ELSE 'monitor' END),p_trusted_ip=>p_ip);
 PERFORM set_config('request.jwt.claim.sub',COALESCE(old_sub,''),true);
 RETURN jsonb_build_object('ok',true);
END $$;
REVOKE ALL ON FUNCTION public.backend_gateway_policy(),public.backend_gateway_consume(text,text,uuid,text,text),public.backend_gateway_audit(uuid,text,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.backend_gateway_policy(),public.backend_gateway_consume(text,text,uuid,text,text),public.backend_gateway_audit(uuid,text,text,text,uuid) TO service_role;
CREATE FUNCTION public.read_ip_policy() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.profiles;cfg private.gateway_config;rows jsonb;
BEGIN
 actor:=private.require_company_actor(ARRAY['admin']);
 SELECT * INTO cfg FROM private.gateway_config WHERE id;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'ip_address',ip_address,'description',description,'is_active',is_active) ORDER BY created_at,id),'[]') INTO rows FROM public.ip_whitelist;
 RETURN jsonb_build_object('rows',rows,'mode',cfg.mode,'version',cfg.version,'pending',cfg.pending IS NOT NULL,
  'pending_expires_at',cfg.pending->>'expires_at','current_ip',(SELECT host(ip) FROM private.gateway_nonces WHERE id=NULLIF(current_setting('partnerdesk.gateway_request_id',true),'')::uuid),
  'recovery_confirmed',EXISTS(SELECT 1 FROM private.gateway_recovery WHERE auth_user_id=actor.auth_user_id AND confirmed_at>clock_timestamp()-interval '1 day'));
END $$;
CREATE FUNCTION public.save_ip_entry(p_id uuid,p_ip text,p_description text,p_active boolean,p_expected_version bigint) RETURNS jsonb
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
   OR NOT EXISTS(SELECT 1 FROM private.gateway_recovery r WHERE r.auth_user_id=actor.auth_user_id AND r.ip<>current_ip AND r.confirmed_at>clock_timestamp()-interval '1 day'
    AND EXISTS(SELECT 1 FROM public.ip_whitelist w WHERE w.is_active AND r.ip <<= w.ip_address::inet)) THEN RAISE EXCEPTION 'administrator_lockout_risk'; END IF;
 END IF;
 UPDATE private.gateway_config SET version=version+1,pending=CASE WHEN cfg.mode='enforced' THEN jsonb_build_object('old_mode',cfg.mode,'old_entries',COALESCE(old_entries,'[]'),
  'started_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '10 minutes','request_id',current_setting('partnerdesk.gateway_request_id',true)) ELSE NULL END WHERE id;
 PERFORM audit.append_access_log(p_action=>'ip_allowlist_changed',p_target_type=>'IPWhitelist',p_target_id=>entry_id::text,p_metadata=>jsonb_build_object('is_active',p_active,'network',address));
 RETURN jsonb_build_object('id',entry_id,'ip_address',address);
END $$;
CREATE FUNCTION public.confirm_ip_recovery_path() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.profiles;ip inet;
BEGIN
 actor:=private.require_company_actor(ARRAY['admin']);
 SELECT n.ip INTO ip FROM private.gateway_nonces n WHERE id=NULLIF(current_setting('partnerdesk.gateway_request_id',true),'')::uuid;
 IF ip IS NULL OR NOT EXISTS(SELECT 1 FROM public.ip_whitelist w WHERE is_active AND ip <<= ip_address::inet) THEN RAISE EXCEPTION 'recovery_ip_not_allowlisted'; END IF;
 INSERT INTO private.gateway_recovery(auth_user_id,ip,confirmed_at) VALUES(actor.auth_user_id,ip,clock_timestamp()) ON CONFLICT(auth_user_id,ip) DO UPDATE SET confirmed_at=EXCLUDED.confirmed_at;
 PERFORM audit.append_access_log(p_action=>'ip_recovery_path_confirmed',p_target_type=>'IPPolicy',p_trusted_ip=>host(ip));
 RETURN jsonb_build_object('id',gen_random_uuid(),'confirmed',true);
END $$;
CREATE FUNCTION public.request_ip_activation(p_expected_version bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.profiles;cfg private.gateway_config;ip inet;entries jsonb;
BEGIN
 actor:=private.require_company_actor(ARRAY['admin']);
 SELECT * INTO cfg FROM private.gateway_config WHERE id FOR UPDATE;
 IF cfg.version IS DISTINCT FROM p_expected_version OR cfg.pending IS NOT NULL OR cfg.mode<>'monitor' THEN RAISE EXCEPTION 'invalid_transition'; END IF;
 SELECT n.ip INTO ip FROM private.gateway_nonces n WHERE id=NULLIF(current_setting('partnerdesk.gateway_request_id',true),'')::uuid;
 IF ip IS NULL OR NOT EXISTS(SELECT 1 FROM public.ip_whitelist WHERE is_active AND ip <<= ip_address::inet)
  OR NOT EXISTS(SELECT 1 FROM private.gateway_recovery r WHERE r.auth_user_id=actor.auth_user_id AND r.ip<>ip AND r.confirmed_at>clock_timestamp()-interval '1 day'
   AND EXISTS(SELECT 1 FROM public.ip_whitelist w WHERE w.is_active AND r.ip <<= w.ip_address::inet)) THEN RAISE EXCEPTION 'recovery_path_required'; END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(x)),'[]') INTO entries FROM public.ip_whitelist x;
 UPDATE private.gateway_config SET mode='enforced',version=version+1,pending=jsonb_build_object('old_mode','monitor','old_entries',entries,
  'started_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '10 minutes','request_id',current_setting('partnerdesk.gateway_request_id',true)) WHERE id;
 PERFORM audit.append_access_log(p_action=>'ip_policy_activation_requested',p_target_type=>'IPPolicy');
 RETURN jsonb_build_object('id',gen_random_uuid(),'reauthentication_required',true);
END $$;
CREATE FUNCTION public.confirm_ip_transition() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.profiles;cfg private.gateway_config;s private.app_sessions;
BEGIN
 actor:=private.require_company_actor(ARRAY['admin']);
 SELECT * INTO cfg FROM private.gateway_config WHERE id FOR UPDATE;s:=private.require_request_app_session(false);
 IF cfg.pending IS NULL OR (cfg.pending->>'expires_at')::timestamptz<=clock_timestamp() OR s.authenticated_at<(cfg.pending->>'started_at')::timestamptz
  OR cfg.pending->>'request_id'=current_setting('partnerdesk.gateway_request_id',true) THEN RAISE EXCEPTION 'reauthentication_required'; END IF;
 UPDATE private.gateway_config SET pending=NULL,version=version+1 WHERE id;
 PERFORM audit.append_access_log(p_action=>'ip_policy_transition_confirmed',p_target_type=>'IPPolicy');
 RETURN jsonb_build_object('id',gen_random_uuid(),'confirmed',true);
END $$;
REVOKE ALL ON FUNCTION public.read_ip_policy(),public.save_ip_entry(uuid,text,text,boolean,bigint),public.confirm_ip_recovery_path(),public.request_ip_activation(bigint),public.confirm_ip_transition() FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.read_ip_policy(),public.save_ip_entry(uuid,text,text,boolean,bigint),public.confirm_ip_recovery_path(),public.request_ip_activation(bigint),public.confirm_ip_transition() TO authenticated;

COMMIT;
