BEGIN;

-- Helpers are owned by the trusted table owner to avoid RLS recursion.
-- Identity always comes from auth.uid(); no caller-supplied Profile ID is accepted.
-- Empty search_path and fully qualified references prevent object substitution.
CREATE FUNCTION public.current_profile_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT p.id FROM public.profiles AS p WHERE p.auth_user_id = auth.uid();
$$;

CREATE FUNCTION public.current_profile_role()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT p.role FROM public.profiles AS p WHERE p.auth_user_id = auth.uid();
$$;

CREATE FUNCTION public.current_organization_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT p.organization_id FROM public.profiles AS p WHERE p.auth_user_id = auth.uid();
$$;

CREATE FUNCTION public.can_access_business(p_business_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.profiles AS p
        WHERE p.auth_user_id = auth.uid()
          AND (
              p.role IN ('admin', 'operator')
              OR (
                  p.role = 'partner_admin'
                  AND EXISTS (
                      SELECT 1 FROM public.service_partners AS sp
                      WHERE sp.business_id = p_business_id
                        AND sp.partner_organization_id = p.organization_id
                  )
              )
          )
    );
$$;

CREATE FUNCTION public.can_access_ticket(p_ticket_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.profiles AS p
        JOIN public.tickets AS t ON t.id = p_ticket_id
        WHERE p.auth_user_id = auth.uid()
          AND (
              p.role IN ('admin', 'operator')
              OR (
                  p.role = 'partner_admin'
                  AND EXISTS (
                      SELECT 1 FROM public.service_partners AS sp
                      WHERE sp.business_id = t.business_id
                        AND sp.partner_organization_id = p.organization_id
                        AND (
                            sp.access_level = 'business'
                            OR t.assigned_partner_organization_id = p.organization_id
                        )
                  )
              )
          )
    );
$$;

-- Supabase SQL Editor migrations run through the trusted postgres management role.
-- Explicit ownership makes the required table-owner RLS bypass independent of the creator.
ALTER FUNCTION public.current_profile_id() OWNER TO postgres;
ALTER FUNCTION public.current_profile_role() OWNER TO postgres;
ALTER FUNCTION public.current_organization_id() OWNER TO postgres;
ALTER FUNCTION public.can_access_business(uuid) OWNER TO postgres;
ALTER FUNCTION public.can_access_ticket(uuid) OWNER TO postgres;

-- Only these five helper EXECUTE privileges change; no table/schema grants are added.
REVOKE ALL ON FUNCTION public.current_profile_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.current_profile_role() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.current_organization_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_access_business(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_access_ticket(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.current_profile_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_profile_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_organization_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_business(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_ticket(uuid) TO authenticated;

-- Keep profiles_select_own unchanged. The new policy adds only admin SELECT.
CREATE POLICY profiles_select_admin ON public.profiles
    FOR SELECT TO authenticated
    USING ((SELECT public.current_profile_role()) = 'admin');

-- No guest organization access: the existing auth/request flow does not require it.
CREATE POLICY organizations_select_authorized ON public.organizations
    FOR SELECT TO authenticated
    USING (
        (SELECT public.current_profile_role()) = 'admin'
        OR (
            (SELECT public.current_profile_role()) = 'operator'
            AND (id = (SELECT public.current_organization_id()) OR type = 'partner')
        )
        OR (
            (SELECT public.current_profile_role()) = 'partner_admin'
            AND id = (SELECT public.current_organization_id())
        )
    );

CREATE POLICY partner_details_select_authorized ON public.partner_details
    FOR SELECT TO authenticated
    USING (
        (SELECT public.current_profile_role()) IN ('admin', 'operator')
        OR (
            (SELECT public.current_profile_role()) = 'partner_admin'
            AND organization_id = (SELECT public.current_organization_id())
        )
    );

CREATE POLICY businesses_select_authorized ON public.businesses
    FOR SELECT TO authenticated
    USING (public.can_access_business(id));

CREATE POLICY service_partners_select_authorized ON public.service_partners
    FOR SELECT TO authenticated
    USING (
        (SELECT public.current_profile_role()) IN ('admin', 'operator')
        OR (
            (SELECT public.current_profile_role()) = 'partner_admin'
            AND partner_organization_id = (SELECT public.current_organization_id())
        )
    );

CREATE POLICY tickets_select_authorized ON public.tickets
    FOR SELECT TO authenticated
    USING (public.can_access_ticket(id));

CREATE POLICY activities_select_authorized ON public.activities
    FOR SELECT TO authenticated
    USING (
        public.can_access_ticket(ticket_id)
        AND (
            (SELECT public.current_profile_role()) IN ('admin', 'operator')
            OR (
                (SELECT public.current_profile_role()) = 'partner_admin'
                AND is_internal = false
                AND type NOT IN ('note', 'view')
            )
        )
    );

CREATE POLICY ticket_attachments_select_authorized ON public.ticket_attachments
    FOR SELECT TO authenticated
    USING (public.can_access_ticket(ticket_id));

CREATE POLICY notifications_select_admin_or_own ON public.notifications
    FOR SELECT TO authenticated
    USING (
        (SELECT public.current_profile_role()) = 'admin'
        OR recipient_profile_id = (SELECT public.current_profile_id())
    );

CREATE POLICY role_requests_select_admin_or_own ON public.role_requests
    FOR SELECT TO authenticated
    USING (
        (SELECT public.current_profile_role()) = 'admin'
        OR requester_profile_id = (SELECT public.current_profile_id())
    );

CREATE POLICY privacy_consents_select_admin_or_own ON public.privacy_consents
    FOR SELECT TO authenticated
    USING (
        (SELECT public.current_profile_role()) = 'admin'
        OR profile_id = (SELECT public.current_profile_id())
    );

CREATE POLICY system_settings_select_admin ON public.system_settings
    FOR SELECT TO authenticated
    USING ((SELECT public.current_profile_role()) = 'admin');

CREATE POLICY ip_whitelist_select_admin ON public.ip_whitelist
    FOR SELECT TO authenticated
    USING ((SELECT public.current_profile_role()) = 'admin');

COMMIT;
