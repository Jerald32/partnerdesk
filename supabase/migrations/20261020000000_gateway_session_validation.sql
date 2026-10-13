BEGIN;
-- Read-only validation behind the same one-time proof and user JWT. Reuse the
-- existing validator and its failure audit; do not replace MFA/session issuance.
CREATE FUNCTION public.validate_app_session() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE identity record;r jsonb;token_hash text;
BEGIN
 IF NOT private.has_gateway_context() THEN RAISE EXCEPTION 'gateway_required' USING ERRCODE='42501'; END IF;
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication_required' USING ERRCODE='28000'; END IF;
 SELECT p.email AS profile_email,p.account_status,u.email AS auth_email,u.email_confirmed_at
 INTO identity FROM public.profiles p JOIN auth.users u ON u.id=p.auth_user_id WHERE p.auth_user_id=auth.uid();
 IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'reason','profile_not_found'); END IF;
 IF identity.auth_email IS NULL OR identity.email_confirmed_at IS NULL THEN RETURN jsonb_build_object('success',false,'reason','email_not_verified'); END IF;
 IF identity.account_status IN ('suspended','disabled') THEN RETURN jsonb_build_object('success',false,'reason','account_'||identity.account_status); END IF;
 IF lower(trim(identity.profile_email)) IS DISTINCT FROM lower(trim(identity.auth_email)) THEN RETURN jsonb_build_object('success',false,'reason','email_identity_mismatch'); END IF;
 token_hash:=private.request_app_session_token_hash();
 IF token_hash IS NULL THEN RETURN jsonb_build_object('success',false,'reason','invalid_session_token'); END IF;
 r:=public.backend_validate_and_touch_app_session(auth.uid(),token_hash,false);
 IF (r->>'valid')::boolean IS DISTINCT FROM true THEN RETURN jsonb_build_object('success',false,'reason',r->>'reason'); END IF;
 RETURN jsonb_build_object('success',true,'valid',true,'session_id',r->>'session_id','expires_at',r->>'expires_at','last_activity_at',r->>'last_activity_at');
END $$;
REVOKE ALL ON FUNCTION public.validate_app_session() FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.validate_app_session() TO authenticated;
COMMIT;
