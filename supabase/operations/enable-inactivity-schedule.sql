-- Run only after the migration, SMTP secrets and inactivity-mail deployment.
-- Vault must contain inactivity_mail_url and inactivity_cron_secret.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
DO $$ BEGIN
 IF COALESCE(current_setting('cron.timezone',true),'GMT') NOT IN ('GMT','UTC','Etc/UTC') THEN
  RAISE EXCEPTION 'cron_timezone_must_be_utc';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM vault.decrypted_secrets WHERE name='inactivity_mail_url') OR
    NOT EXISTS(SELECT 1 FROM vault.decrypted_secrets WHERE name='inactivity_cron_secret') THEN
  RAISE EXCEPTION 'inactivity_scheduler_secrets_missing';
 END IF;
END $$;
CREATE OR REPLACE FUNCTION private.dispatch_inactivity_mail() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE request_id bigint; endpoint text; secret text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM private.inactivity_mail_queue WHERE
  (state='pending' AND next_attempt_at<=clock_timestamp()) OR (state='sending' AND leased_until<=clock_timestamp())) THEN RETURN NULL; END IF;
 SELECT decrypted_secret INTO STRICT endpoint FROM vault.decrypted_secrets WHERE name='inactivity_mail_url';
 SELECT decrypted_secret INTO STRICT secret FROM vault.decrypted_secrets WHERE name='inactivity_cron_secret';
 SELECT net.http_post(url:=endpoint,headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||secret),
  body:='{}'::jsonb,timeout_milliseconds:=60000) INTO request_id;
 RETURN request_id;
END $$;
REVOKE ALL ON FUNCTION private.dispatch_inactivity_mail() FROM PUBLIC,anon,authenticated,service_role;
-- pg_cron runs in UTC: 17:00 UTC = 02:00 Asia/Seoul on the next calendar date.
SELECT cron.schedule('partner-inactivity-daily','0 17 * * *','SELECT private.process_inactive_accounts()');
SELECT cron.schedule('partner-inactivity-mail','* * * * *','SELECT private.dispatch_inactivity_mail()');
COMMIT;
