BEGIN;

-- Read-only enrichment: preserve immutable events and distinguish historical
-- snapshots from the current identity/organization labels used for lookup.
CREATE FUNCTION public.search_admin_role_audit(
 p_query text DEFAULT '', p_offset integer DEFAULT 0,
 p_from date DEFAULT NULL, p_to date DEFAULT NULL, p_change_type text DEFAULT ''
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s text:=btrim(COALESCE(p_query,'')); result jsonb;
BEGIN
 PERFORM private.require_request_app_session(false);
 IF NOT public.is_company_admin() THEN RAISE EXCEPTION 'role_not_allowed' USING ERRCODE='42501'; END IF;
 IF length(s)>100 OR p_offset IS NULL OR p_offset<0 OR p_offset>1000000
  OR p_change_type IS NULL OR p_change_type NOT IN ('','direct','request_approved')
  OR (p_from IS NOT NULL AND p_to IS NOT NULL AND p_from>p_to)
  OR p_to=date '9999-12-31' THEN
  RAISE EXCEPTION 'invalid_search' USING ERRCODE='22023';
 END IF;
 SELECT jsonb_build_object('rows',COALESCE(jsonb_agg(to_jsonb(page)-'page_number' ORDER BY page_number) FILTER(WHERE page_number<=100),'[]'::jsonb),
  'has_more',COALESCE(bool_or(page_number>100),false)) INTO result FROM (
  SELECT limited.*,row_number() OVER(ORDER BY changed_at DESC,id DESC) AS page_number FROM (
  SELECT enriched.* FROM (
   SELECT l.id,l.changed_at,l.change_type,l.target_profile_id,l.target_user_id,
    l.actor_profile_id,l.actor_id,l.actor_role,l.role_before,l.role_after,
    l.org_type_before,l.org_type_after,l.affiliation_before,l.affiliation_after,
    l.role_request_id,l.source_api,l.actor_ip,
    COALESCE(l.requester_profile_id,r.requester_profile_id) AS requester_profile_id,
    COALESCE(NULLIF(l.requester_name,''),NULLIF(r.requester_name_snapshot,''),NULLIF(requester.display_name,''),NULLIF(requester.full_name,'')) AS requester_name,
    COALESCE(NULLIF(l.requester_email,''),NULLIF(r.requester_email_snapshot,''),requester.email) AS requester_email,
    COALESCE(NULLIF(r.current_affiliation_snapshot,''),requester_org.name) AS requester_organization_name,
    CASE WHEN NULLIF(l.requester_name,'') IS NOT NULL OR NULLIF(l.requester_email,'') IS NOT NULL
      OR NULLIF(r.requester_name_snapshot,'') IS NOT NULL OR NULLIF(r.requester_email_snapshot,'') IS NOT NULL THEN 'snapshot' ELSE 'current' END AS requester_identity_source,
    COALESCE(NULLIF(l.actor_name,''),NULLIF(a.display_name,''),NULLIF(a.full_name,'')) AS actor_name,
    COALESCE(NULLIF(l.actor_email,''),a.email) AS actor_email,
    CASE WHEN NULLIF(l.actor_name,'') IS NOT NULL OR NULLIF(l.actor_email,'') IS NOT NULL THEN 'snapshot' ELSE 'current' END AS actor_identity_source,
    COALESCE(NULLIF(l.target_name,''),NULLIF(t.display_name,''),NULLIF(t.full_name,'')) AS target_name,
    COALESCE(NULLIF(l.target_email,''),t.email) AS target_email,
    CASE WHEN NULLIF(l.target_name,'') IS NOT NULL OR NULLIF(l.target_email,'') IS NOT NULL THEN 'snapshot' ELSE 'current' END AS target_identity_source,
    ob.name AS organization_before_name,oa.name AS organization_after_name,
    actor_org.name AS actor_organization_name,
    COALESCE(l.requested_at,r.created_at) AS requested_at,
    COALESCE(NULLIF(l.request_reason,''),r.justification) AS request_reason,
    r.admin_notes,
    NULLIF(l.issue_reason,'') AS issue_reason
   FROM audit.role_change_logs l
   LEFT JOIN public.profiles a ON a.id=l.actor_profile_id
   LEFT JOIN public.profiles t ON t.id=l.target_profile_id
   LEFT JOIN public.organizations actor_org ON actor_org.id=a.organization_id
   LEFT JOIN public.organizations ob ON ob.id::text=l.affiliation_before
   LEFT JOIN public.organizations oa ON oa.id::text=l.affiliation_after
   LEFT JOIN public.role_requests r ON r.id=l.role_request_id
   LEFT JOIN public.profiles requester ON requester.id=COALESCE(l.requester_profile_id,r.requester_profile_id)
   LEFT JOIN public.organizations requester_org ON requester_org.id=requester.organization_id
   WHERE (p_change_type='' OR l.change_type=p_change_type)
    AND (p_from IS NULL OR l.changed_at >= (p_from::timestamp AT TIME ZONE 'Asia/Seoul'))
    AND (p_to IS NULL OR l.changed_at < ((p_to+1)::timestamp AT TIME ZONE 'Asia/Seoul'))
  ) enriched
  WHERE s='' OR position(lower(s) IN lower(concat_ws(' ',actor_name,actor_email,target_name,target_email,
   actor_profile_id,target_profile_id,actor_id,target_user_id,organization_before_name,organization_after_name,actor_organization_name,
   requester_name,requester_email,requester_organization_name)))>0
  ORDER BY changed_at DESC,id DESC LIMIT 101 OFFSET p_offset
 ) limited) page;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.search_admin_role_audit(text,integer,date,date,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.search_admin_role_audit(text,integer,date,date,text) TO authenticated;
COMMIT;
