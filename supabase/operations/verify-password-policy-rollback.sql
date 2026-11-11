-- Every test write, including the temporary enforcement flag, is rolled back.
BEGIN;
UPDATE private.password_policy_config SET enforced=true WHERE id;
DO $$
DECLARE uid uuid:=gen_random_uuid();a text:='$2a$10$'||repeat('a',53);b text:='$2a$10$'||repeat('b',53);
 email text;proof jsonb;consents jsonb;stored text;
BEGIN
 email:='password-policy-probe-'||uid::text||'@example.invalid';
 SELECT COALESCE(jsonb_agg(jsonb_build_object('kind',kind,'version',version,'text_hash',text_hash,'agreed',true)),'[]') INTO consents
  FROM public.consent_policy_versions WHERE enabled AND kind<>'privacy_pledge';
 BEGIN
  INSERT INTO auth.users(id,email,encrypted_password,raw_user_meta_data) VALUES(uid,email,b,jsonb_build_object('full_name','Rollback probe','signup_consents',consents));
  RAISE EXCEPTION 'unapproved_signup_was_accepted';
 EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM<>'password_policy_endpoint_required' THEN RAISE; END IF; END;
 proof:=public.backend_approve_password_write(uid,a,'signup',email);
 INSERT INTO auth.users(id,email,encrypted_password,raw_user_meta_data) VALUES(uid,email,b,
  jsonb_build_object('full_name','Rollback probe','signup_consents',consents,'_partnerdesk_password_approval',proof->>'proof_token'));
 SELECT encrypted_password INTO stored FROM auth.users WHERE id=uid;
 IF stored<>a THEN RAISE EXCEPTION 'approved_signup_hash_not_stored'; END IF;
 IF EXISTS(SELECT 1 FROM auth.users WHERE id=uid AND raw_user_meta_data?'_partnerdesk_password_approval') THEN RAISE EXCEPTION 'approval_leaked_to_metadata'; END IF;
 BEGIN
  UPDATE auth.users SET encrypted_password=b WHERE id=uid;
  RAISE EXCEPTION 'unapproved_password_update_was_accepted';
 EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM<>'password_policy_endpoint_required' THEN RAISE; END IF; END;
 PERFORM public.backend_approve_password_write(uid,b,'reset',NULL);
 UPDATE auth.users SET encrypted_password=a||'native-salt-differs' WHERE id=uid;
 SELECT encrypted_password INTO stored FROM auth.users WHERE id=uid;
 IF stored<>b THEN RAISE EXCEPTION 'approved_reset_hash_not_stored'; END IF;
 IF EXISTS(SELECT 1 FROM private.password_write_approvals WHERE auth_user_id=uid) THEN RAISE EXCEPTION 'approval_not_consumed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE auth_user_id=uid AND role='guest' AND password_changed_at IS NOT NULL) THEN RAISE EXCEPTION 'profile_or_password_trigger_missing'; END IF;
END $$;
ROLLBACK;
SELECT 'password_guard_checks_passed_and_rolled_back' AS result;
