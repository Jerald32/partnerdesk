BEGIN;
-- Enrich labels at read time; never update historical rows or their hashes.
CREATE OR REPLACE FUNCTION public.search_admin_access_audit(p_query text DEFAULT '',p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r jsonb;s text:=btrim(COALESCE(p_query,''));
BEGIN
 PERFORM private.require_request_app_session(false);
 IF NOT public.is_company_admin() THEN RAISE EXCEPTION 'role_not_allowed' USING ERRCODE='42501'; END IF;
 IF length(s)>100 OR p_offset IS NULL OR p_offset<0 OR p_offset>1000000 THEN RAISE EXCEPTION 'invalid_search' USING ERRCODE='22023'; END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY q.accessed_at DESC,q.id DESC),'[]'::jsonb) INTO r FROM (
  SELECT l.id,l.accessed_at,l.actor_profile_id,l.user_id,l.user_name,l.user_email,l.user_role,
   l.metadata->>'organization_id' AS organization_id,l.action,l.target_type,l.target_id,
   l.metadata->>'result' AS result,l.metadata->>'request_id' AS request_id,
   l.user_ip,l.metadata->>'ip_unavailable_reason' AS ip_unavailable_reason,l.metadata,l.seq,
   l.subject_info,l.detail,l.record_hash,l.prev_hash,
   COALESCE(NULLIF(p.display_name,''),NULLIF(p.full_name,'')) AS current_name,p.email AS current_email,
   p.organization_id AS current_organization_id,current_org.name AS current_organization_name,
   recorded_org.name AS recorded_organization_name
  FROM audit.access_logs l LEFT JOIN public.profiles p ON p.id=l.actor_profile_id
  LEFT JOIN public.organizations current_org ON current_org.id=p.organization_id
  LEFT JOIN public.organizations recorded_org ON recorded_org.id::text=l.metadata->>'organization_id'
  WHERE s='' OR position(lower(s) IN lower(concat_ws(' ',l.action,l.target_id,l.actor_profile_id,l.user_id,
   l.user_name,l.user_email,p.display_name,p.full_name,p.email,l.user_ip,recorded_org.name,current_org.name,
   l.metadata->>'organization_id',l.metadata->>'request_id',l.metadata->>'result')))>0
  ORDER BY l.accessed_at DESC,l.id DESC LIMIT 100 OFFSET p_offset
 ) q;
 RETURN jsonb_build_object('rows',r);
END $$;
REVOKE ALL ON FUNCTION public.search_admin_access_audit(text,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.search_admin_access_audit(text,integer) TO authenticated;
COMMIT;
