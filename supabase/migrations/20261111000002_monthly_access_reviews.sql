BEGIN;
CREATE TABLE audit.access_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), review_month date NOT NULL CHECK(review_month=date_trunc('month',review_month)::date),
 requester_id uuid NOT NULL REFERENCES public.profiles(id), approver_id uuid NOT NULL REFERENCES public.profiles(id),
 summary text NOT NULL CHECK(length(btrim(summary)) BETWEEN 1 AND 4000),
 findings text NOT NULL CHECK(length(btrim(findings)) BETWEEN 1 AND 4000),
 actions text NOT NULL CHECK(length(btrim(actions)) BETWEEN 1 AND 4000),
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(), requester_ip text,
 CHECK(requester_id<>approver_id)
);
CREATE TABLE audit.access_review_items (
 review_id uuid NOT NULL REFERENCES audit.access_reviews(id), log_id uuid NOT NULL REFERENCES audit.access_logs(id),
 PRIMARY KEY(review_id,log_id)
);
CREATE TABLE audit.access_review_decisions (
 review_id uuid PRIMARY KEY REFERENCES audit.access_reviews(id),
 outcome text NOT NULL CHECK(outcome IN ('approved','rejected','withdrawn')),
 actor_id uuid NOT NULL REFERENCES public.profiles(id), comment text NOT NULL CHECK(length(btrim(comment)) BETWEEN 1 AND 2000),
 decided_at timestamptz NOT NULL DEFAULT clock_timestamp(), actor_ip text
);
CREATE INDEX access_reviews_month_idx ON audit.access_reviews(review_month DESC,requested_at DESC,id DESC);
CREATE INDEX access_reviews_approver_idx ON audit.access_reviews(approver_id,requested_at DESC,id DESC);
ALTER TABLE audit.access_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.access_review_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.access_review_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON audit.access_reviews,audit.access_review_items,audit.access_review_decisions FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER access_reviews_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON audit.access_reviews FOR EACH STATEMENT EXECUTE FUNCTION private.reject_audit_mutation();
CREATE TRIGGER access_review_items_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON audit.access_review_items FOR EACH STATEMENT EXECUTE FUNCTION private.reject_audit_mutation();
CREATE TRIGGER access_review_decisions_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON audit.access_review_decisions FOR EACH STATEMENT EXECUTE FUNCTION private.reject_audit_mutation();

CREATE FUNCTION private.access_review_actor() RETURNS public.profiles LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.profiles;
BEGIN
 PERFORM private.require_request_app_session(false);
 SELECT x.* INTO p FROM public.profiles x JOIN public.organizations o ON o.id=x.organization_id
 WHERE x.auth_user_id=auth.uid() AND x.account_status='active' AND x.role IN ('admin','operator')
  AND o.type='operator' AND o.is_active AND o.id<>'10a8e084-c396-4a97-b301-c4ef4aa59d71';
 IF NOT FOUND THEN RAISE EXCEPTION 'company_member_required' USING ERRCODE='42501'; END IF;
 RETURN p;
END $$;
CREATE FUNCTION private.access_review_ip() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT host(n.ip) FROM private.gateway_nonces n
 WHERE n.id=NULLIF(current_setting('partnerdesk.gateway_request_id',true),'')::uuid
 AND n.used_txid=txid_current() AND n.auth_user_id=auth.uid() AND n.session_hash=private.request_app_session_token_hash()
$$;
REVOKE ALL ON FUNCTION private.access_review_actor(),private.access_review_ip() FROM PUBLIC,anon,authenticated,service_role;

ALTER TABLE public.notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK(type IN ('sla_warning','sla_breach','status_change','new_comment','assignment','access_review_requested','access_review_decided'));
ALTER TABLE public.notifications ADD COLUMN access_review_id uuid REFERENCES audit.access_reviews(id);

CREATE FUNCTION public.request_access_review(p_month date,p_approver_id uuid,p_summary text,p_findings text,p_actions text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.profiles; reviewer public.profiles; new_id uuid; n bigint;
BEGIN
 actor:=private.access_review_actor();
 IF NOT public.is_company_admin() THEN RAISE EXCEPTION 'role_not_allowed' USING ERRCODE='42501'; END IF;
 IF p_month IS NULL OR NOT isfinite(p_month) OR p_month<>date_trunc('month',p_month)::date
  OR p_month<date '2000-01-01' OR p_month>=date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date
  OR p_summary IS NULL OR length(btrim(p_summary)) NOT BETWEEN 1 AND 4000
  OR p_findings IS NULL OR length(btrim(p_findings)) NOT BETWEEN 1 AND 4000
  OR p_actions IS NULL OR length(btrim(p_actions)) NOT BETWEEN 1 AND 4000 THEN
  RAISE EXCEPTION 'invalid_review_input' USING ERRCODE='22023'; END IF;
 IF p_approver_id=actor.id THEN RAISE EXCEPTION 'self_approval_forbidden' USING ERRCODE='42501'; END IF;
 SELECT p.* INTO reviewer FROM public.profiles p JOIN public.organizations o ON o.id=p.organization_id
 WHERE p.id=p_approver_id AND p.account_status='active' AND p.role IN ('admin','operator') AND p.auth_user_id IS NOT NULL
  AND o.type='operator' AND o.is_active AND o.id<>'10a8e084-c396-4a97-b301-c4ef4aa59d71';
 IF NOT FOUND THEN RAISE EXCEPTION 'invalid_review_approver' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(71111002,(p_month-date '2000-01-01')::integer);
 IF EXISTS(SELECT 1 FROM audit.access_reviews r LEFT JOIN audit.access_review_decisions d ON d.review_id=r.id
  WHERE r.review_month=p_month AND (d.review_id IS NULL OR d.outcome='approved')) THEN
  RAISE EXCEPTION 'review_already_open_or_approved' USING ERRCODE='23505'; END IF;
 INSERT INTO audit.access_reviews(review_month,requester_id,approver_id,summary,findings,actions,requester_ip)
 VALUES(p_month,actor.id,p_approver_id,btrim(p_summary),btrim(p_findings),btrim(p_actions),private.access_review_ip()) RETURNING id INTO new_id;
 INSERT INTO audit.access_review_items(review_id,log_id)
 SELECT new_id,id FROM audit.access_logs
 WHERE accessed_at >= (p_month::timestamp AT TIME ZONE 'Asia/Seoul')
 AND accessed_at < ((p_month+interval '1 month')::timestamp AT TIME ZONE 'Asia/Seoul');
 GET DIAGNOSTICS n=ROW_COUNT;
 INSERT INTO public.notifications(recipient_profile_id,type,message,access_review_id)
 VALUES(p_approver_id,'access_review_requested',to_char(p_month,'YYYY-MM')||' 접속기록 점검 승인 요청이 도착했습니다.',new_id);
 PERFORM audit.append_access_log(p_action=>'access_review_requested',p_target_type=>'AccessReview',p_target_id=>new_id::text,
  p_metadata=>jsonb_build_object('month',p_month,'approver_id',p_approver_id,'log_count',n),p_trusted_ip=>private.access_review_ip());
 RETURN jsonb_build_object('id',new_id,'status','pending','log_count',n);
END $$;

CREATE FUNCTION public.decide_access_review(p_review_id uuid,p_outcome text,p_comment text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.profiles;r audit.access_reviews;
BEGIN
 actor:=private.access_review_actor();
 SELECT * INTO r FROM audit.access_reviews WHERE id=p_review_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'review_not_available' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(71111002,(r.review_month-date '2000-01-01')::integer);
 IF p_outcome IS NULL OR p_outcome NOT IN ('approved','rejected','withdrawn') OR p_comment IS NULL
  OR length(btrim(p_comment)) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'invalid_review_decision' USING ERRCODE='22023'; END IF;
 IF p_outcome='withdrawn' THEN
  IF NOT public.is_company_admin() THEN RAISE EXCEPTION 'role_not_allowed' USING ERRCODE='42501'; END IF;
 ELSE
  IF actor.id<>r.approver_id OR actor.id=r.requester_id THEN RAISE EXCEPTION 'designated_approver_required' USING ERRCODE='42501'; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM audit.access_review_decisions WHERE review_id=r.id) THEN RAISE EXCEPTION 'review_already_decided' USING ERRCODE='40001'; END IF;
 INSERT INTO audit.access_review_decisions(review_id,outcome,actor_id,comment,actor_ip)
 VALUES(r.id,p_outcome,actor.id,btrim(p_comment),private.access_review_ip());
 INSERT INTO public.notifications(recipient_profile_id,type,message,access_review_id)
 SELECT recipient,'access_review_decided',to_char(r.review_month,'YYYY-MM')||' 접속기록 점검이 '||
  CASE p_outcome WHEN 'approved' THEN '승인' WHEN 'rejected' THEN '반려' ELSE '회수' END||'되었습니다.',r.id
 FROM (SELECT r.requester_id AS recipient UNION SELECT r.approver_id) users;
 PERFORM audit.append_access_log(p_action=>'access_review_'||p_outcome,p_target_type=>'AccessReview',p_target_id=>r.id::text,
  p_metadata=>jsonb_build_object('month',r.review_month,'requester_id',r.requester_id,'approver_id',r.approver_id),p_trusted_ip=>private.access_review_ip());
 RETURN jsonb_build_object('id',r.id,'status',p_outcome);
END $$;

CREATE FUNCTION public.list_access_reviews(p_offset integer DEFAULT 0,p_scope text DEFAULT 'recent') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.profiles;rows jsonb;approvers jsonb:='[]'::jsonb;monthly jsonb:='[]'::jsonb;prev date;completed boolean:=false;more boolean;
BEGIN
 actor:=private.access_review_actor();
 IF p_offset IS NULL OR p_offset<0 OR p_offset>1000000 THEN RAISE EXCEPTION 'invalid_offset' USING ERRCODE='22023'; END IF;
 IF p_scope IS NULL OR p_scope NOT IN ('recent','all') THEN RAISE EXCEPTION 'invalid_review_scope' USING ERRCODE='22023'; END IF;
 prev:=(date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Seoul')-interval '1 month')::date;
 SELECT COALESCE(jsonb_agg(to_jsonb(page)-'rn' ORDER BY rn) FILTER(WHERE rn<=100),'[]'::jsonb),COALESCE(bool_or(rn>100),false)
 INTO rows,more FROM (
  SELECT limited.*,row_number() OVER(ORDER BY requested_at DESC,id DESC) rn FROM (
   SELECT r.id,r.review_month,r.requested_at,r.requester_id,r.approver_id,COALESCE(d.outcome,'pending') AS status,d.decided_at,
    COALESCE(NULLIF(a.display_name,''),a.full_name,a.email) AS requester_name,a.email AS requester_email,
    COALESCE(NULLIF(b.display_name,''),b.full_name,b.email) AS approver_name,b.email AS approver_email
   FROM audit.access_reviews r LEFT JOIN audit.access_review_decisions d ON d.review_id=r.id
   JOIN public.profiles a ON a.id=r.requester_id JOIN public.profiles b ON b.id=r.approver_id
   WHERE (public.is_company_admin() OR r.approver_id=actor.id OR r.requester_id=actor.id)
    AND (p_scope='all' OR (r.review_month >= (prev-interval '2 months')::date AND r.review_month<=prev))
   ORDER BY r.requested_at DESC,r.id DESC LIMIT 101 OFFSET p_offset
  ) limited
 ) page;
 IF public.is_company_admin() THEN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'name',COALESCE(NULLIF(p.display_name,''),p.full_name,p.email),'email',p.email) ORDER BY p.email),'[]'::jsonb)
  INTO approvers FROM public.profiles p JOIN public.organizations o ON o.id=p.organization_id
  WHERE p.id<>actor.id AND p.account_status='active' AND p.auth_user_id IS NOT NULL AND p.role IN ('admin','operator')
   AND o.type='operator' AND o.is_active AND o.id<>'10a8e084-c396-4a97-b301-c4ef4aa59d71';
  SELECT EXISTS(SELECT 1 FROM audit.access_reviews r JOIN audit.access_review_decisions d ON d.review_id=r.id
   WHERE r.review_month=prev AND d.outcome='approved') INTO completed;
  SELECT jsonb_agg(jsonb_build_object('review_month',m.review_month,'id',r.id,
   'status',COALESCE(d.outcome,CASE WHEN r.id IS NULL THEN 'not_requested' ELSE 'pending' END),
   'requested_at',r.requested_at,'approver_name',COALESCE(NULLIF(p.display_name,''),p.full_name,p.email),'approver_email',p.email,'decided_at',d.decided_at)
   ORDER BY m.review_month DESC) INTO monthly
  FROM (SELECT (prev-n*interval '1 month')::date AS review_month FROM generate_series(0,2) n) m
  LEFT JOIN LATERAL (SELECT x.* FROM audit.access_reviews x WHERE x.review_month=m.review_month ORDER BY x.requested_at DESC,x.id DESC LIMIT 1) r ON true
  LEFT JOIN audit.access_review_decisions d ON d.review_id=r.id LEFT JOIN public.profiles p ON p.id=r.approver_id;
 END IF;
 RETURN jsonb_build_object('rows',rows,'has_more',more,'approvers',approvers,'previous_month',prev,'previous_month_approved',completed,
  'scope',p_scope,'monthly_summary',monthly,'range_from',CASE WHEN p_scope='recent' THEN (prev-interval '2 months')::date END,'range_to',CASE WHEN p_scope='recent' THEN prev END);
END $$;

CREATE FUNCTION public.read_access_review(p_review_id uuid,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.profiles; r audit.access_reviews;info jsonb;logs jsonb;more boolean;n bigint;
BEGIN
 actor:=private.access_review_actor();
 SELECT * INTO r FROM audit.access_reviews WHERE id=p_review_id;
 IF NOT FOUND OR NOT(public.is_company_admin() OR r.approver_id=actor.id OR r.requester_id=actor.id) THEN
  RAISE EXCEPTION 'review_not_available' USING ERRCODE='42501'; END IF;
 IF p_offset IS NULL OR p_offset<0 OR p_offset>1000000 THEN RAISE EXCEPTION 'invalid_offset' USING ERRCODE='22023'; END IF;
 SELECT to_jsonb(r)||jsonb_build_object('status',COALESCE(d.outcome,'pending'),'comment',d.comment,'decided_at',d.decided_at,
  'decision_actor_id',d.actor_id,'decision_actor_name',COALESCE(NULLIF(c.display_name,''),c.full_name,c.email),'decision_actor_email',c.email,
  'decision_ip',d.actor_ip,'requester_name',COALESCE(NULLIF(a.display_name,''),a.full_name,a.email),
  'requester_email',a.email,'approver_name',COALESCE(NULLIF(b.display_name,''),b.full_name,b.email),'approver_email',b.email)
 INTO info FROM public.profiles a JOIN public.profiles b ON b.id=r.approver_id
 LEFT JOIN audit.access_review_decisions d ON d.review_id=r.id
 LEFT JOIN public.profiles c ON c.id=d.actor_id WHERE a.id=r.requester_id;
 SELECT count(*) INTO n FROM audit.access_review_items WHERE review_id=r.id;
 SELECT COALESCE(jsonb_agg(to_jsonb(page)-'rn' ORDER BY rn) FILTER(WHERE rn<=100),'[]'::jsonb),COALESCE(bool_or(rn>100),false)
 INTO logs,more FROM (
  SELECT limited.*,row_number() OVER(ORDER BY accessed_at,id) rn FROM (
   SELECT l.id,l.accessed_at,l.actor_profile_id,l.user_role,l.action,l.target_type,l.target_id,l.user_ip,l.metadata->>'result' AS result,l.seq,l.record_hash
   FROM audit.access_review_items i JOIN audit.access_logs l ON l.id=i.log_id
   WHERE i.review_id=r.id ORDER BY l.accessed_at,l.id LIMIT 101 OFFSET p_offset
  ) limited
 ) page;
 PERFORM audit.append_access_log(p_action=>'access_review_viewed',p_target_type=>'AccessReview',p_target_id=>r.id::text,
  p_metadata=>jsonb_build_object('offset',p_offset),p_trusted_ip=>private.access_review_ip());
 RETURN jsonb_build_object('review',info,'rows',logs,'has_more',more,'log_count',n);
END $$;

REVOKE ALL ON FUNCTION public.request_access_review(date,uuid,text,text,text),public.decide_access_review(uuid,text,text),public.list_access_reviews(integer,text),public.read_access_review(uuid,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.request_access_review(date,uuid,text,text,text),public.decide_access_review(uuid,text,text),public.list_access_reviews(integer,text),public.read_access_review(uuid,integer) TO authenticated;
COMMIT;
