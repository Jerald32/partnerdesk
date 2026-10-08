BEGIN;

-- A dedicated holding organization, never a client-selected business affiliation.
-- A conflicting fixed UUID fails the transaction rather than reusing an existing org.
INSERT INTO public.organizations (id, name, type)
VALUES ('10a8e084-c396-4a97-b301-c4ef4aa59d71', '회원가입 승인 대기', 'operator');

CREATE FUNCTION private.provision_signup_profile()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    IF NEW.email IS NULL THEN RETURN NEW; END IF;
    -- Never link a pre-existing profile by email, or trust role/org/status metadata.
    INSERT INTO public.profiles (auth_user_id, organization_id, email, full_name, role, account_status)
    VALUES (NEW.id, '10a8e084-c396-4a97-b301-c4ef4aa59d71', NEW.email,
        pg_catalog.left(NULLIF(pg_catalog.btrim(NEW.raw_user_meta_data ->> 'full_name'), ''), 200),
        'guest', 'pending_login');
    RETURN NEW;
END;
$$;
ALTER FUNCTION private.provision_signup_profile() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.provision_signup_profile() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER partnerdesk_signup_profile AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION private.provision_signup_profile();

-- Guests get only a minimal directory for the existing submit_role_request RPC.
-- All ordinary organization SELECT policies and app-session gates stay unchanged.
CREATE FUNCTION public.list_role_request_organizations()
RETURNS TABLE (id uuid, name text, type text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    PERFORM private.require_request_app_session(false);
    RETURN QUERY SELECT o.id, o.name, o.type FROM public.organizations AS o
    WHERE o.is_active AND o.id <> '10a8e084-c396-4a97-b301-c4ef4aa59d71'
      AND (o.type = 'operator' OR EXISTS (
          SELECT 1 FROM public.partner_details AS d WHERE d.organization_id = o.id))
    ORDER BY o.name, o.id;
END;
$$;
ALTER FUNCTION public.list_role_request_organizations() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_role_request_organizations() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_role_request_organizations() TO authenticated;

-- Auth password changes revoke app credentials in the same DB transaction.
-- Otherwise a recovered account could retain an old PartnerDesk app session.
CREATE FUNCTION private.revoke_sessions_on_password_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_profile_id uuid;
BEGIN
    IF OLD.encrypted_password IS DISTINCT FROM NEW.encrypted_password THEN
        SELECT p.id INTO v_profile_id FROM public.profiles AS p
        WHERE p.auth_user_id = NEW.id FOR UPDATE;
        IF FOUND THEN
            PERFORM private.revoke_profile_sessions(v_profile_id);
            UPDATE public.profiles SET password_changed_at = pg_catalog.clock_timestamp(),
                updated_at = pg_catalog.clock_timestamp() WHERE id = v_profile_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
ALTER FUNCTION private.revoke_sessions_on_password_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.revoke_sessions_on_password_change() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER partnerdesk_password_change AFTER UPDATE OF encrypted_password ON auth.users
    FOR EACH ROW EXECUTE FUNCTION private.revoke_sessions_on_password_change();
COMMIT;
