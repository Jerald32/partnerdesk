BEGIN;
-- Native Auth retains confirmation mail, token cleanup and session revocation.
ALTER TABLE private.password_write_approvals ADD COLUMN approved_hash text;
ALTER TABLE private.password_write_approvals ADD COLUMN signup_email text;
ALTER TABLE private.password_write_approvals ADD COLUMN proof_token uuid DEFAULT gen_random_uuid() NOT NULL;
CREATE UNIQUE INDEX password_reset_one_approval ON private.password_write_approvals(auth_user_id) WHERE operation='reset';
CREATE OR REPLACE FUNCTION public.backend_approve_password_write(p_user_id uuid,p_hash text,p_operation text,p_email text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE token uuid:=gen_random_uuid();
BEGIN
 IF p_user_id IS NULL OR p_hash IS NULL OR p_hash !~ '^\$2[aby]\$10\$[./A-Za-z0-9]{53}$' OR p_operation NOT IN ('signup','reset') OR p_operation IS NULL THEN RAISE EXCEPTION 'invalid_password_approval'; END IF;
 IF p_operation='signup' AND (p_email IS NULL OR length(p_email)>320) THEN RAISE EXCEPTION 'invalid_signup_email'; END IF;
 DELETE FROM private.password_write_approvals WHERE expires_at<clock_timestamp() OR (operation='reset' AND auth_user_id=p_user_id);
 INSERT INTO private.password_write_approvals(auth_user_id,hash_digest,operation,approved_hash,signup_email,proof_token)
 VALUES(p_user_id,encode(sha256(convert_to(p_hash,'UTF8')),'hex'),p_operation,p_hash,lower(p_email),token);
 RETURN jsonb_build_object('ok',true,'proof_token',token);
END $$;
CREATE OR REPLACE FUNCTION private.guard_password_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE approved text;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.encrypted_password IS NOT DISTINCT FROM OLD.encrypted_password THEN RETURN NEW; END IF;
  DELETE FROM private.password_write_approvals WHERE auth_user_id=NEW.id AND operation='reset' AND expires_at>clock_timestamp()
   RETURNING approved_hash INTO approved;
 ELSE
  DELETE FROM private.password_write_approvals WHERE operation='signup' AND signup_email=lower(NEW.email)
   AND proof_token::text=NEW.raw_user_meta_data->>'_partnerdesk_password_approval' AND expires_at>clock_timestamp()
   RETURNING approved_hash INTO approved;
  NEW.raw_user_meta_data:=NEW.raw_user_meta_data-'_partnerdesk_password_approval';
 END IF;
 IF approved IS NOT NULL THEN
  -- Even a racing native request can only store the compliant approved hash.
  NEW.encrypted_password:=approved;
 ELSIF (SELECT enforced FROM private.password_policy_config WHERE id) THEN
  RAISE EXCEPTION 'password_policy_endpoint_required' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
COMMIT;
