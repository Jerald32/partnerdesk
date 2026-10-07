BEGIN;

-- Keep existing linking validation/audit and require an active partner.
CREATE OR REPLACE FUNCTION public.link_service_partner(
    p_business_id uuid, p_partner_organization_id uuid,
    p_access_level text DEFAULT 'service', p_role_description text DEFAULT NULL,
    p_sla_response_hours numeric DEFAULT 4, p_sla_resolution_hours numeric DEFAULT 24
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_relation public.service_partners%ROWTYPE;
BEGIN
    v_actor := private.require_management_actor(ARRAY['admin', 'operator']::text[]);
    IF p_access_level IS NULL OR p_access_level NOT IN ('business', 'service') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_access_level';
    END IF;
    IF p_sla_response_hours IS NULL OR p_sla_resolution_hours IS NULL
       OR p_sla_response_hours < 0 OR p_sla_resolution_hours < 0
       OR p_sla_response_hours::text IN ('NaN', 'Infinity', '-Infinity')
       OR p_sla_resolution_hours::text IN ('NaN', 'Infinity', '-Infinity') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_sla_hours';
    END IF;
    -- Serialize all connection/access-level writes per Business, including first insertion.
    PERFORM 1 FROM public.businesses AS b WHERE b.id = p_business_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'business_not_found';
    END IF;
    PERFORM 1 FROM public.organizations AS o
    WHERE o.id = p_partner_organization_id AND o.type = 'partner' AND o.is_active = true FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'partner_not_found';
    END IF;
    PERFORM 1 FROM public.partner_details AS d
    WHERE d.organization_id = p_partner_organization_id FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'partner_details_not_found';
    END IF;
    IF EXISTS (SELECT 1 FROM public.service_partners AS sp
        WHERE sp.business_id = p_business_id AND sp.partner_organization_id = p_partner_organization_id) THEN
        RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'business_partner_already_linked';
    END IF;
    IF p_access_level = 'business' AND EXISTS (SELECT 1 FROM public.service_partners AS sp
        WHERE sp.business_id = p_business_id AND sp.access_level = 'business') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'business_partner_limit';
    END IF;
    INSERT INTO public.service_partners (business_id, partner_organization_id, access_level,
        role_description, sla_response_hours, sla_resolution_hours, created_by_profile_id)
    VALUES (p_business_id, p_partner_organization_id, p_access_level,
        p_role_description, p_sla_response_hours, p_sla_resolution_hours, v_actor.id)
    RETURNING * INTO v_relation;
    PERFORM audit.append_access_log(p_action => '파트너 연결', p_target_type => 'Business',
        p_target_id => p_business_id::text,
        p_metadata => pg_catalog.jsonb_build_object('service_partner_id', v_relation.id,
            'business_id', p_business_id, 'partner_organization_id', p_partner_organization_id,
            'access_level', v_relation.access_level, 'sla_response_hours', v_relation.sla_response_hours,
            'sla_resolution_hours', v_relation.sla_resolution_hours));
    RETURN pg_catalog.jsonb_build_object('id', v_relation.id);
END;
$$;

-- Do not silently unassign tickets: the existing composite FK also enforces this.
CREATE OR REPLACE FUNCTION public.unlink_service_partner(p_service_partner_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor public.profiles%ROWTYPE;
    v_business_id uuid;
    v_relation public.service_partners%ROWTYPE;
BEGIN
    v_actor := private.require_management_actor(ARRAY['admin', 'operator']::text[]);
    SELECT sp.business_id INTO v_business_id FROM public.service_partners AS sp
    WHERE sp.id = p_service_partner_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'service_partner_not_found';
    END IF;
    -- Same Business -> relation lock order as existing management RPCs.
    PERFORM 1 FROM public.businesses AS b WHERE b.id = v_business_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'business_not_found';
    END IF;
    SELECT sp.* INTO v_relation FROM public.service_partners AS sp
    WHERE sp.id = p_service_partner_id AND sp.business_id = v_business_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'service_partner_not_found';
    END IF;
    IF EXISTS (SELECT 1 FROM public.tickets AS t
        WHERE t.business_id = v_business_id
          AND t.assigned_partner_organization_id = v_relation.partner_organization_id) THEN
        RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'partner_has_assigned_tickets';
    END IF;
    DELETE FROM public.service_partners
    WHERE id = p_service_partner_id AND business_id = v_business_id;
    PERFORM audit.append_access_log(p_action => '파트너 연결 해제', p_target_type => 'Business',
        p_target_id => v_business_id::text,
        p_metadata => pg_catalog.jsonb_build_object('service_partner_id', p_service_partner_id,
            'business_id', v_business_id, 'partner_organization_id', v_relation.partner_organization_id,
            'old_access_level', v_relation.access_level));
    RETURN pg_catalog.jsonb_build_object('id', p_service_partner_id);
END;
$$;

ALTER FUNCTION public.link_service_partner(uuid, uuid, text, text, numeric, numeric) OWNER TO postgres;
ALTER FUNCTION public.unlink_service_partner(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.link_service_partner(uuid, uuid, text, text, numeric, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unlink_service_partner(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_service_partner(uuid, uuid, text, text, numeric, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unlink_service_partner(uuid) TO authenticated;

COMMIT;
