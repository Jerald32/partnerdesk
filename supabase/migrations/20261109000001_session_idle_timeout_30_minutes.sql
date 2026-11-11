BEGIN;
-- Change only the idle interval in the existing guarded definitions. Preserve
-- production gateway, account, identity, absolute expiry, audit and ACL rules.
DO $$
DECLARE signature text; definition text;
BEGIN
 FOREACH signature IN ARRAY ARRAY[
  'private.validate_and_touch_app_session(uuid,text,boolean)',
  'private.find_valid_request_app_session()',
  'private.require_request_app_session(boolean)'
 ] LOOP
  definition:=pg_get_functiondef(signature::regprocedure);
  IF (length(definition)-length(replace(definition,'''15 minutes''','')))/length('''15 minutes''')<>1 THEN
   RAISE EXCEPTION 'unexpected_idle_timeout_definition: %',signature;
  END IF;
  EXECUTE replace(definition,'''15 minutes''','''30 minutes''');
 END LOOP;
END $$;
COMMIT;
