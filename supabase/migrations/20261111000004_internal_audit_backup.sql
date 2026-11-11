BEGIN;
CREATE FUNCTION public.export_access_backup(p_from date,p_to date,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.profiles;export_id uuid:=gen_random_uuid();payload jsonb;raw text;checksum text;counts jsonb;verification jsonb;
BEGIN
 actor:=private.access_review_actor();
 IF NOT public.is_company_admin() THEN RAISE EXCEPTION 'role_not_allowed' USING ERRCODE='42501'; END IF;
 IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to)
  OR p_from<date '2000-01-01' OR p_to<p_from OR p_to-p_from>30
  OR p_to>(clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date
  OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000 THEN
  RAISE EXCEPTION 'invalid_backup_range_or_reason' USING ERRCODE='P0001'; END IF;
 verification:=audit.verify_access_log_chain();
 IF (verification->>'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'audit_chain_not_appendable' USING ERRCODE='55000'; END IF;
 -- All datasets use one MVCC snapshot. No UI search or page filter is applied.
 WITH logs AS MATERIALIZED (
  SELECT * FROM audit.access_logs WHERE accessed_at >= (p_from::timestamp AT TIME ZONE 'Asia/Seoul')
   AND accessed_at < ((p_to+1)::timestamp AT TIME ZONE 'Asia/Seoul') ORDER BY accessed_at,id LIMIT 10001
 ), reviews AS MATERIALIZED (
  SELECT r.* FROM audit.access_reviews r WHERE
   (r.review_month < p_to+1 AND r.review_month+interval '1 month'>p_from)
   OR (r.requested_at >= (p_from::timestamp AT TIME ZONE 'Asia/Seoul') AND r.requested_at < ((p_to+1)::timestamp AT TIME ZONE 'Asia/Seoul'))
   OR EXISTS(SELECT 1 FROM audit.access_review_decisions d WHERE d.review_id=r.id
    AND d.decided_at >= (p_from::timestamp AT TIME ZONE 'Asia/Seoul') AND d.decided_at < ((p_to+1)::timestamp AT TIME ZONE 'Asia/Seoul'))
  ORDER BY r.requested_at,r.id LIMIT 10001
 ), decisions AS MATERIALIZED (
  SELECT d.* FROM audit.access_review_decisions d JOIN reviews r ON r.id=d.review_id ORDER BY d.review_id
 ), items AS MATERIALIZED (
  SELECT i.* FROM audit.access_review_items i JOIN reviews r ON r.id=i.review_id ORDER BY i.review_id,i.log_id LIMIT 100001
 )
 SELECT jsonb_build_object('format','partnerdesk-audit-data-v1','export_id',export_id,'exported_at',clock_timestamp(),
  'requested_by_profile_id',actor.id,'reason',btrim(p_reason),'timezone','Asia/Seoul',
  'period',jsonb_build_object('from',p_from,'to_inclusive',p_to),'source_chain_check',verification,
  'scope',jsonb_build_object('access_logs','all events in the selected KST date range',
   'reviews','reviews for overlapping months or requested/decided in the selected range',
   'review_items','all fixed log ID associations of included reviews; referenced events outside the selected date range are not included'),
  'counts',jsonb_build_object('access_logs',(SELECT count(*) FROM logs),'access_reviews',(SELECT count(*) FROM reviews),
   'access_review_decisions',(SELECT count(*) FROM decisions),'access_review_items',(SELECT count(*) FROM items)),
  'access_logs',COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.accessed_at,l.id) FROM logs l),'[]'::jsonb),
  'access_reviews',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.requested_at,r.id) FROM reviews r),'[]'::jsonb),
  'access_review_decisions',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.review_id) FROM decisions d),'[]'::jsonb),
  'access_review_items',COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.review_id,i.log_id) FROM items i),'[]'::jsonb)) INTO payload;
 counts:=payload->'counts';raw:=payload::text;
 IF (counts->>'access_logs')::integer>10000 OR (counts->>'access_reviews')::integer>10000
  OR (counts->>'access_review_items')::integer>100000 OR octet_length(raw)>2097152 THEN
  RAISE EXCEPTION 'backup_too_large' USING ERRCODE='P0001'; END IF;
 checksum:=encode(sha256(convert_to(raw,'UTF8')),'hex');
 PERFORM audit.append_access_log(p_action=>'audit_backup_exported',p_target_type=>'AuditBackup',p_target_id=>export_id::text,
  p_metadata=>jsonb_build_object('from',p_from,'to',p_to,'sha256',checksum,'counts',counts,'status','file_generated'),p_trusted_ip=>private.access_review_ip());
 RETURN jsonb_build_object('export_id',export_id,'payload_json',raw,'sha256',checksum,'counts',counts);
END $$;

CREATE FUNCTION public.verify_access_backup(p_export_id uuid,p_sha256 text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM private.access_review_actor();
 IF NOT public.is_company_admin() THEN RAISE EXCEPTION 'role_not_allowed' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('verified',EXISTS(SELECT 1 FROM audit.access_logs
  WHERE action='audit_backup_exported' AND target_type='AuditBackup' AND target_id=p_export_id::text AND metadata->>'sha256'=p_sha256));
END $$;

CREATE FUNCTION public.confirm_access_backup_storage(p_export_id uuid,p_sha256 text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.profiles;
BEGIN
 actor:=private.access_review_actor();
 IF NOT public.is_company_admin() THEN RAISE EXCEPTION 'role_not_allowed' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM audit.access_logs WHERE action='audit_backup_exported' AND target_type='AuditBackup'
  AND target_id=p_export_id::text AND actor_profile_id=actor.id AND metadata->>'sha256'=p_sha256) THEN
  RAISE EXCEPTION 'backup_not_available' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_export_id::text,71111004));
 IF EXISTS(SELECT 1 FROM audit.access_logs WHERE action='audit_backup_storage_confirmed' AND target_type='AuditBackup' AND target_id=p_export_id::text) THEN
  RETURN jsonb_build_object('id',p_export_id,'confirmed',true); END IF;
 PERFORM audit.append_access_log(p_action=>'audit_backup_storage_confirmed',p_target_type=>'AuditBackup',p_target_id=>p_export_id::text,
  p_metadata=>jsonb_build_object('sha256',p_sha256,'confirmation_source','requesting_admin_attestation','storage','company_internal','drm','admin_confirmed'),p_trusted_ip=>private.access_review_ip());
 RETURN jsonb_build_object('id',p_export_id,'confirmed',true);
END $$;
REVOKE ALL ON FUNCTION public.export_access_backup(date,date,text),public.verify_access_backup(uuid,text),public.confirm_access_backup_storage(uuid,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.export_access_backup(date,date,text),public.verify_access_backup(uuid,text),public.confirm_access_backup_storage(uuid,text) TO authenticated;
COMMIT;
