BEGIN;
-- Add response metadata only. Keep existing five-attempt/five-minute controls,
-- profile/challenge locks, verification, audit and EXECUTE permissions intact.
DO $$
DECLARE definition text; needle text;
BEGIN
 definition:=pg_get_functiondef('public.backend_reserve_email_mfa_attempt(uuid,uuid,uuid,text)'::regprocedure);
 needle:='jsonb_build_object(''ok'',false,''reason'',''mfa_locked'')';
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>2 THEN RAISE EXCEPTION 'unexpected_mfa_reserve_definition'; END IF;
 EXECUTE replace(definition,needle,'jsonb_build_object(''ok'',false,''reason'',''mfa_locked'',''fail_count'',LEAST(5,p.mfa_fail_count),''max_attempts'',5)');
 definition:=pg_get_functiondef('public.backend_finish_email_mfa(uuid,uuid,uuid,text,uuid,boolean,text,text)'::regprocedure);
 needle:='jsonb_build_object(''ok'',false,''reason'',CASE WHEN p.mfa_fail_count>=5 THEN ''mfa_locked'' ELSE ''code_invalid'' END)';
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'unexpected_mfa_finish_definition'; END IF;
 EXECUTE replace(definition,needle,'jsonb_build_object(''ok'',false,''reason'',CASE WHEN p.mfa_fail_count>=5 THEN ''mfa_locked'' ELSE ''code_invalid'' END,''fail_count'',LEAST(5,p.mfa_fail_count),''max_attempts'',5)');
END $$;
COMMIT;
