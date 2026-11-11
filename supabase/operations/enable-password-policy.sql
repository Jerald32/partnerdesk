BEGIN;
DO $$ BEGIN
 IF position('NEW.encrypted_password:=approved' in pg_get_functiondef('private.guard_password_write()'::regprocedure))=0 THEN
  RAISE EXCEPTION 'password_policy_binding_not_ready';
 END IF;
END $$;
UPDATE private.password_policy_config SET enforced=true WHERE id;
SELECT audit.append_access_log(p_action=>'password_policy_enforced',p_target_type=>'AuthPolicy',
 p_metadata=>jsonb_build_object('minimum_length',8,'required_classes',4,'forbid_whitespace',true,'forbid_hangul',true));
COMMIT;
