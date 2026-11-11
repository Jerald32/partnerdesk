BEGIN;
-- Capture the IP of this mutation, never the audit viewer's IP or client headers.
CREATE FUNCTION private.capture_role_audit_ip() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 SELECT host(n.ip) INTO NEW.actor_ip
 FROM private.gateway_nonces n
 JOIN public.profiles p ON p.id=NEW.actor_profile_id AND p.auth_user_id=n.auth_user_id
 WHERE n.id=NULLIF(current_setting('partnerdesk.gateway_request_id',true),'')::uuid
  AND n.used_txid=txid_current() AND n.auth_user_id=auth.uid()
  AND n.session_hash=private.request_app_session_token_hash();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.capture_role_audit_ip() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER role_audit_trusted_ip BEFORE INSERT ON audit.role_change_logs
 FOR EACH ROW EXECUTE FUNCTION private.capture_role_audit_ip();
COMMIT;
