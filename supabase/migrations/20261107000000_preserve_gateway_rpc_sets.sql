BEGIN;

-- Preserve the existing proof, caller privileges and RPC execution context.
-- TABLE/SETOF functions must return every row, including [] for an empty set.
-- SELECT ... INTO on the old scalar query silently kept only the first row.
CREATE OR REPLACE FUNCTION public.gateway_rpc(p_request text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
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
 IF proc.proretset THEN
  EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(row)),''[]''::jsonb) FROM public.%I(%s) AS row',n,args) INTO result USING q;
 ELSE
  EXECUTE format('SELECT to_jsonb(public.%I(%s))',n,args) INTO result USING q;
 END IF;
 RETURN result;
 EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('_gateway_error',jsonb_build_object('code',SQLSTATE,'message',CASE WHEN SQLSTATE IN ('42501','40001','28000','P0001') THEN SQLERRM ELSE 'mutation_rejected' END)); END;
END $$;

COMMIT;
