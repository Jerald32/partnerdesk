BEGIN;
-- Activated only after the replacement signup/reset endpoint is deployed.
CREATE TABLE private.password_policy_config(id boolean PRIMARY KEY DEFAULT true CHECK(id),enforced boolean NOT NULL DEFAULT false);
INSERT INTO private.password_policy_config(id) VALUES(true);
CREATE TABLE private.password_write_approvals(
 auth_user_id uuid NOT NULL,hash_digest text PRIMARY KEY,operation text NOT NULL CHECK(operation IN ('signup','reset')),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '2 minutes'
);
CREATE TABLE private.password_request_limits(bucket text PRIMARY KEY,window_at timestamptz NOT NULL,count integer NOT NULL);
ALTER TABLE private.password_policy_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.password_write_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.password_request_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.password_policy_config,private.password_write_approvals,private.password_request_limits FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.consume_password_limit(p_bucket text,p_limit integer,p_seconds integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE n integer;v_now timestamptz:=clock_timestamp();
BEGIN
 INSERT INTO private.password_request_limits(bucket,window_at,count) VALUES(p_bucket,v_now,1)
 ON CONFLICT(bucket) DO UPDATE SET
  window_at=CASE WHEN private.password_request_limits.window_at+make_interval(secs=>p_seconds)<=v_now THEN v_now ELSE private.password_request_limits.window_at END,
  count=CASE WHEN private.password_request_limits.window_at+make_interval(secs=>p_seconds)<=v_now THEN 1 ELSE private.password_request_limits.count+1 END
 RETURNING count INTO n;
 IF n>p_limit THEN RAISE EXCEPTION 'password_request_rate_limited' USING ERRCODE='54000'; END IF;
END $$;
CREATE FUNCTION public.backend_reserve_password_request(p_user_id uuid,p_operation text,p_email text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_user_id IS NULL OR p_operation NOT IN ('signup','reset') OR p_operation IS NULL THEN RAISE EXCEPTION 'invalid_password_request'; END IF;
 IF p_operation='signup' THEN
  IF p_email IS NULL OR length(p_email)>320 THEN RAISE EXCEPTION 'invalid_signup_email'; END IF;
  PERFORM private.consume_password_limit('signup:'||encode(sha256(convert_to(lower(p_email),'UTF8')),'hex'),3,3600);
  PERFORM private.consume_password_limit('signup-global',30,3600);
 ELSE
  IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_user_id) THEN RAISE EXCEPTION 'auth_user_not_found'; END IF;
  PERFORM private.consume_password_limit('reset:'||p_user_id::text,6,3600);
 END IF;
 RETURN jsonb_build_object('ok',true);
END $$;
CREATE FUNCTION public.backend_approve_password_write(p_user_id uuid,p_hash text,p_operation text,p_email text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_user_id IS NULL OR p_hash IS NULL OR p_hash !~ '^\$2[aby]\$12\$[./A-Za-z0-9]{53}$' OR p_operation NOT IN ('signup','reset') OR p_operation IS NULL THEN RAISE EXCEPTION 'invalid_password_approval'; END IF;
 DELETE FROM private.password_write_approvals WHERE expires_at<clock_timestamp();
 INSERT INTO private.password_write_approvals(auth_user_id,hash_digest,operation)
 VALUES(p_user_id,encode(sha256(convert_to(p_hash,'UTF8')),'hex'),p_operation);
 RETURN jsonb_build_object('ok',true);
END $$;
CREATE FUNCTION private.guard_password_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE approved boolean;
BEGIN
 IF NOT (SELECT enforced FROM private.password_policy_config WHERE id) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.encrypted_password IS NOT DISTINCT FROM OLD.encrypted_password THEN RETURN NEW; END IF;
 END IF;
 DELETE FROM private.password_write_approvals
 WHERE auth_user_id=NEW.id AND hash_digest=encode(sha256(convert_to(COALESCE(NEW.encrypted_password,''),'UTF8')),'hex')
  AND operation=CASE WHEN TG_OP='INSERT' THEN 'signup' ELSE 'reset' END AND expires_at>clock_timestamp()
 RETURNING true INTO approved;
 IF approved IS DISTINCT FROM true THEN RAISE EXCEPTION 'password_policy_endpoint_required' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER partnerdesk_password_policy_guard BEFORE INSERT OR UPDATE OF encrypted_password ON auth.users
 FOR EACH ROW EXECUTE FUNCTION private.guard_password_write();
REVOKE ALL ON FUNCTION private.consume_password_limit(text,integer,integer),private.guard_password_write() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.backend_approve_password_write(uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.backend_approve_password_write(uuid,text,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.backend_reserve_password_request(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.backend_reserve_password_request(uuid,text,text) TO service_role;
COMMIT;
