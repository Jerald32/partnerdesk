BEGIN;
-- Additive rollout: no existing profile, consent, ticket or session is rewritten.
CREATE TABLE private.email_mfa_challenges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES public.profiles(id),
 password_session_id uuid NOT NULL, nonce text NOT NULL CHECK(nonce ~ '^[0-9a-f]{64}$'),
 email_snapshot text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL, delivery text NOT NULL DEFAULT 'pending' CHECK(delivery IN ('pending','accepted','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5), attempt_id uuid,
 consumed boolean NOT NULL DEFAULT false
);
ALTER TABLE private.email_mfa_challenges ENABLE ROW LEVEL SECURITY;
CREATE INDEX email_mfa_profile_created ON private.email_mfa_challenges(profile_id,created_at DESC);
REVOKE ALL ON private.email_mfa_challenges FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.email_mfa_audit(p_user uuid,p_event text,p_challenge uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE old_subject text:=current_setting('request.jwt.claim.sub',true);
BEGIN
 IF p_event NOT IN ('requested','delivery_accepted','delivery_failed','attempt','verified','failed','locked','rate_limited') THEN
  RAISE EXCEPTION 'invalid_mfa_event';
 END IF;
 -- Called exclusively by fixed, owner-only auth functions, never a browser RPC.
 PERFORM set_config('request.jwt.claim.sub',p_user::text,true);
 PERFORM audit.append_access_log(p_action=>'이메일 MFA '||p_event,p_target_type=>'Authentication',
  p_target_id=>p_challenge::text,p_metadata=>jsonb_build_object('event',p_event,'provider','supabase_auth_otp'));
 PERFORM set_config('request.jwt.claim.sub',COALESCE(old_subject,''),true);
END $$;

CREATE FUNCTION private.email_mfa_profile(p_user uuid) RETURNS public.profiles
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.profiles;
BEGIN
 p:=private.lock_app_auth_profile(p_user);
 IF p.id IS NULL OR p.account_status IN ('suspended','disabled') OR
  NOT EXISTS(SELECT 1 FROM public.organizations o WHERE o.id=p.organization_id AND o.is_active) OR
  NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=p_user AND u.email_confirmed_at IS NOT NULL
   AND lower(btrim(u.email))=lower(btrim(p.email))) THEN
  RAISE EXCEPTION 'account_unavailable' USING ERRCODE='42501';
 END IF;
 -- Guest may complete authentication for approval/consent/account recovery.
 -- Its role is never changed here; existing RLS denies all business access.
 RETURN p;
END $$;

CREATE FUNCTION public.backend_begin_email_mfa(p_auth_user_id uuid,p_password_session_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.profiles; c private.email_mfa_challenges; v_now timestamptz:=clock_timestamp();
BEGIN
 p:=private.email_mfa_profile(p_auth_user_id);
 IF p_password_session_id IS NULL THEN RAISE EXCEPTION 'password_session_required'; END IF;
 IF p.mfa_locked_until>v_now THEN RETURN jsonb_build_object('ok',false,'reason','mfa_locked'); END IF;
 -- Conservative shared quota when the Edge cannot attest a client IP. Never
 -- derive a bypassable rate-limit key from user supplied forwarding headers.
 PERFORM pg_advisory_xact_lock(20261013,1);
 IF EXISTS(SELECT 1 FROM private.email_mfa_challenges WHERE profile_id=p.id AND created_at>v_now-interval '1 minute') OR
  (SELECT count(*) FROM private.email_mfa_challenges WHERE profile_id=p.id AND created_at>v_now-interval '15 minutes')>=5 OR
  (SELECT count(*) FROM private.email_mfa_challenges WHERE created_at>v_now-interval '10 minutes')>=60 THEN
  PERFORM private.email_mfa_audit(p_auth_user_id,'rate_limited');
  RETURN jsonb_build_object('ok',false,'reason','mfa_rate_limited');
 END IF;
 UPDATE private.email_mfa_challenges SET consumed=true WHERE profile_id=p.id AND NOT consumed;
 INSERT INTO private.email_mfa_challenges(profile_id,password_session_id,nonce,email_snapshot,expires_at)
 VALUES(p.id,p_password_session_id,replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''),p.email,v_now+interval '5 minutes') RETURNING * INTO c;
 PERFORM private.email_mfa_audit(p_auth_user_id,'requested',c.id);
 RETURN jsonb_build_object('ok',true,'challenge_id',c.id,'nonce',c.nonce,'expires_at',c.expires_at);
END $$;

CREATE FUNCTION public.backend_email_mfa_delivery(p_auth_user_id uuid,p_password_session_id uuid,p_challenge_id uuid,p_delivered boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.profiles; c private.email_mfa_challenges;
BEGIN
 p:=private.email_mfa_profile(p_auth_user_id);
 UPDATE private.email_mfa_challenges SET delivery=CASE WHEN p_delivered IS TRUE THEN 'accepted' ELSE 'failed' END
 WHERE id=p_challenge_id AND profile_id=p.id AND password_session_id=p_password_session_id AND delivery='pending' AND NOT consumed RETURNING * INTO c;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','challenge_invalid'); END IF;
 PERFORM private.email_mfa_audit(p_auth_user_id,CASE WHEN p_delivered IS TRUE THEN 'delivery_accepted' ELSE 'delivery_failed' END,c.id);
 RETURN jsonb_build_object('ok',true);
END $$;

CREATE FUNCTION public.backend_reserve_email_mfa_attempt(p_auth_user_id uuid,p_password_session_id uuid,p_challenge_id uuid,p_nonce text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.profiles; c private.email_mfa_challenges; ticket uuid:=gen_random_uuid(); v_now timestamptz:=clock_timestamp();
BEGIN
 p:=private.email_mfa_profile(p_auth_user_id);
 IF p.mfa_locked_until>v_now THEN RETURN jsonb_build_object('ok',false,'reason','mfa_locked'); END IF;
 IF p.mfa_locked_until IS NOT NULL AND p.mfa_locked_until<=v_now THEN
  UPDATE public.profiles SET mfa_fail_count=0,mfa_locked_until=NULL WHERE id=p.id;
  p.mfa_fail_count:=0;
 END IF;
 SELECT * INTO c FROM private.email_mfa_challenges WHERE id=p_challenge_id AND profile_id=p.id FOR UPDATE;
 IF NOT FOUND OR c.password_session_id IS DISTINCT FROM p_password_session_id OR c.nonce IS DISTINCT FROM p_nonce
  OR c.email_snapshot IS DISTINCT FROM p.email OR c.delivery<>'accepted' THEN
  RETURN jsonb_build_object('ok',false,'reason','challenge_invalid'); END IF;
 IF c.consumed THEN RETURN jsonb_build_object('ok',false,'reason','challenge_consumed'); END IF;
 IF c.expires_at<=v_now THEN RETURN jsonb_build_object('ok',false,'reason','challenge_expired'); END IF;
 IF c.attempts>=5 OR p.mfa_fail_count>=5 THEN RETURN jsonb_build_object('ok',false,'reason','mfa_locked'); END IF;
 UPDATE private.email_mfa_challenges SET attempts=attempts+1,attempt_id=ticket WHERE id=c.id;
 UPDATE public.profiles SET mfa_fail_count=mfa_fail_count+1,
  mfa_locked_until=CASE WHEN mfa_fail_count+1>=5 THEN v_now+interval '5 minutes' ELSE mfa_locked_until END WHERE id=p.id;
 PERFORM private.email_mfa_audit(p_auth_user_id,'attempt',c.id);
 RETURN jsonb_build_object('ok',true,'attempt_id',ticket);
END $$;

CREATE FUNCTION public.backend_finish_email_mfa(p_auth_user_id uuid,p_password_session_id uuid,p_challenge_id uuid,p_nonce text,
 p_attempt_id uuid,p_verified boolean,p_session_token_hash text,p_device_label text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.profiles; c private.email_mfa_challenges; result jsonb;
BEGIN
 p:=private.email_mfa_profile(p_auth_user_id);
 SELECT * INTO c FROM private.email_mfa_challenges WHERE id=p_challenge_id AND profile_id=p.id FOR UPDATE;
 IF NOT FOUND OR c.password_session_id IS DISTINCT FROM p_password_session_id OR c.nonce IS DISTINCT FROM p_nonce
  OR c.attempt_id IS DISTINCT FROM p_attempt_id OR p_attempt_id IS NULL OR c.consumed
  OR c.email_snapshot IS DISTINCT FROM p.email OR c.expires_at<=clock_timestamp() THEN
  RETURN jsonb_build_object('ok',false,'reason','challenge_invalid'); END IF;
 UPDATE private.email_mfa_challenges SET attempt_id=NULL WHERE id=c.id;
 IF p_verified IS DISTINCT FROM true THEN
  PERFORM private.email_mfa_audit(p_auth_user_id,CASE WHEN p.mfa_fail_count>=5 THEN 'locked' ELSE 'failed' END,c.id);
  RETURN jsonb_build_object('ok',false,'reason',CASE WHEN p.mfa_fail_count>=5 THEN 'mfa_locked' ELSE 'code_invalid' END);
 END IF;
 result:=private.insert_app_auth_session(p,p_session_token_hash,p_device_label,true);
 UPDATE private.email_mfa_challenges SET consumed=true WHERE id=c.id;
 PERFORM private.email_mfa_audit(p_auth_user_id,'verified',c.id);
 RETURN result;
END $$;

ALTER FUNCTION private.email_mfa_audit(uuid,text,uuid) OWNER TO postgres;
ALTER FUNCTION private.email_mfa_profile(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.email_mfa_audit(uuid,text,uuid),private.email_mfa_profile(uuid) FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION public.backend_begin_email_mfa(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.backend_email_mfa_delivery(uuid,uuid,uuid,boolean) OWNER TO postgres;
ALTER FUNCTION public.backend_reserve_email_mfa_attempt(uuid,uuid,uuid,text) OWNER TO postgres;
ALTER FUNCTION public.backend_finish_email_mfa(uuid,uuid,uuid,text,uuid,boolean,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.backend_begin_email_mfa(uuid,uuid),public.backend_email_mfa_delivery(uuid,uuid,uuid,boolean),
 public.backend_reserve_email_mfa_attempt(uuid,uuid,uuid,text),public.backend_finish_email_mfa(uuid,uuid,uuid,text,uuid,boolean,text,text)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.backend_begin_email_mfa(uuid,uuid),public.backend_email_mfa_delivery(uuid,uuid,uuid,boolean),
 public.backend_reserve_email_mfa_attempt(uuid,uuid,uuid,text),public.backend_finish_email_mfa(uuid,uuid,uuid,text,uuid,boolean,text,text) TO service_role;
-- mfa_enabled is intentionally unchanged. Existing sessions remain valid for
-- their original 8h absolute / 15m idle limits; MFA applies to new logins.
COMMIT;
