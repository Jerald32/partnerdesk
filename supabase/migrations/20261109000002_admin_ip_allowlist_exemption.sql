BEGIN;
-- Approved: both Company Admin and Partner Admin are exempt from the IP list.
-- The verified subject is resolved against current DB membership, never JWT
-- user_metadata, request headers or a caller-supplied role/exemption flag.
CREATE FUNCTION private.is_ip_exempt_admin(p_auth_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(
  SELECT 1 FROM public.profiles p JOIN public.organizations o ON o.id=p.organization_id
   JOIN auth.users u ON u.id=p.auth_user_id
  WHERE p.auth_user_id=p_auth_user_id AND p.role='admin'
   AND p.account_status NOT IN ('suspended','disabled') AND o.is_active
   AND o.type IN ('operator','partner') AND o.id<>'10a8e084-c396-4a97-b301-c4ef4aa59d71'::uuid
   AND u.email_confirmed_at IS NOT NULL AND lower(u.email)=lower(p.email)
 );
$$;
REVOKE ALL ON FUNCTION private.is_ip_exempt_admin(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.backend_gateway_ip_exemption(p_auth_user_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('exempt',private.is_ip_exempt_admin(p_auth_user_id));
$$;
REVOKE ALL ON FUNCTION public.backend_gateway_ip_exemption(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.backend_gateway_ip_exemption(uuid) TO service_role;

-- Preserve every signature, identity binding, nonce and session check in the
-- current proof verifier. Recheck the live role in DB to handle demotion races.
DO $$
DECLARE definition text; needle text:='IF EXISTS(SELECT 1 FROM private.gateway_config WHERE mode=''enforced'') AND';
BEGIN
 definition:=pg_get_functiondef('private.consume_gateway_proof(text,text,uuid,text,text,text,text)'::regprocedure);
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'unexpected_gateway_ip_verifier_definition';
 END IF;
 EXECUTE replace(definition,needle,needle||' NOT private.is_ip_exempt_admin(p_user) AND');
END $$;

CREATE OR REPLACE FUNCTION public.backend_gateway_audit(p_user uuid,p_ip text,p_path text,p_verdict text,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE old_sub text:=current_setting('request.jwt.claim.sub',true);
BEGIN
 IF p_verdict NOT IN ('monitor_would_deny','ip_denied','admin_ip_exempt') OR length(p_path)>200 THEN RAISE EXCEPTION 'invalid_audit_event'; END IF;
 IF p_verdict='admin_ip_exempt' AND NOT private.is_ip_exempt_admin(p_user) THEN RAISE EXCEPTION 'admin_ip_exemption_not_allowed' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM public.profiles WHERE auth_user_id=p_user) THEN PERFORM set_config('request.jwt.claim.sub',p_user::text,true); ELSE PERFORM set_config('request.jwt.claim.sub','',true); END IF;
 PERFORM audit.append_access_log(p_action=>p_verdict,p_target_type=>'Gateway',
  p_metadata=>jsonb_build_object('path',p_path,'gateway_request_id',p_request_id,
   'result',CASE WHEN p_verdict='ip_denied' THEN 'denied' WHEN p_verdict='admin_ip_exempt' THEN 'admin_exempt' ELSE 'monitor' END),p_trusted_ip=>p_ip);
 PERFORM set_config('request.jwt.claim.sub',COALESCE(old_sub,''),true);
 RETURN jsonb_build_object('ok',true);
END $$;
COMMIT;
