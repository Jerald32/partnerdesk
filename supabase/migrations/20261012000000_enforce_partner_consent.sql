-- Restores the original Base44 required signup acknowledgements. No existing identity, receipt or session is rewritten.
BEGIN;
DO $$ BEGIN
 IF (SELECT value FROM public.system_settings WHERE key='privacy_pledge_version') IS DISTINCT FROM 'v1.0' THEN
  RAISE EXCEPTION 'pledge_document_requires_review';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN ('tickets','businesses','activities','service_partners',
    'ticket_attachments','notifications','privacy_consents') AND NOT c.relrowsecurity) THEN
  RAISE EXCEPTION 'row_security_disabled_requires_review';
 END IF;
END $$;

CREATE TABLE public.consent_policy_versions (
 kind text NOT NULL CHECK(kind IN ('privacy_pledge','signup_privacy','signup_delegation','signup_one_account')),
 version text NOT NULL CHECK(btrim(version)<>''), title text NOT NULL, document_text text NOT NULL,
 text_hash text NOT NULL, enabled boolean NOT NULL DEFAULT false, required boolean NOT NULL DEFAULT false,
 -- Signup rollout may explicitly exempt older profiles; never fabricate their agreement.
 required_for_profiles_created_at_or_after timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(kind,version)
);
CREATE UNIQUE INDEX consent_policy_one_enabled_kind ON public.consent_policy_versions(kind) WHERE enabled;
ALTER TABLE public.consent_policy_versions ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION private.protect_consent_document() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'consent_document_immutable'; END IF;
 IF TG_OP='UPDATE' AND (NEW.kind,NEW.version,NEW.title,NEW.document_text,NEW.text_hash,NEW.created_at)
   IS DISTINCT FROM (OLD.kind,OLD.version,OLD.title,OLD.document_text,OLD.text_hash,OLD.created_at) THEN
  RAISE EXCEPTION 'consent_document_immutable';
 END IF;
 NEW.text_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(NEW.document_text,'UTF8')),'hex');
 RETURN NEW;
END $$;
CREATE TRIGGER consent_document_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.consent_policy_versions
 FOR EACH ROW EXECUTE FUNCTION private.protect_consent_document();
INSERT INTO public.consent_policy_versions(kind,version,title,document_text,text_hash,enabled,required) VALUES
 ('privacy_pledge','v1.0','개인정보보호 서약서',$pledge$개인정보보호 서약서

본인은 협력사 임직원으로서 PartnerDesk 시스템을 이용함에 있어, 다음 사항을 성실히 준수할 것을 서약합니다.

1. 개인정보보호법 등 관련 법령 및 회사의 개인정보처리방침을 준수한다.
2. 시스템 내 개인정보를 본인의 업무 수행 목적 외에는 사용하지 않는다.
3. 업무상 알게 된 개인정보를 제3자에게 누설하거나 제공하지 않는다.
4. 시스템 계정 및 비밀번호를 타인에게 공유하거나 대여하지 않는다.
5. 시스템 내 기밀정보를 외부로 유출하지 않는다.
6. 퇴사 또는 업무 종료 시 즉시 시스템 접근 권한을 반납한다.

본 서약을 위반할 경우, 관련 법령에 따라 민·형사상 책임을 질 수 있음을 인지하고 있습니다.$pledge$,'',true,true),
 -- Exact original Base44 signup text and required flags; activation explicitly authorized.
 ('signup_privacy','base44-v1','개인정보 이용·제공 동의','서비스 제공을 위해 개인정보를 수집·이용·제공하는 것에 동의합니다.','',true,true),
 ('signup_delegation','base44-v1','개인정보 처리위탁 동의','서비스 운영을 위해 개인정보 처리를 위탁하는 것에 동의합니다.','',true,true),
 ('signup_one_account','base44-v1','1인 1계정 사용 및 계정공유 금지 확인','본 계정은 본인만 사용하며, 타인과 공유하지 않을 것을 확인합니다.','',true,true);

-- Existing accounts are exempt from newly introduced signup evidence, never auto-consented.
UPDATE public.consent_policy_versions SET required_for_profiles_created_at_or_after=transaction_timestamp()
 WHERE kind<>'privacy_pledge';

ALTER TABLE public.privacy_consents ADD COLUMN policy_text_hash text,
 ADD COLUMN policy_text_snapshot text, ADD COLUMN auth_user_id_snapshot uuid,
 ADD COLUMN source text, ADD COLUMN withdrawn_at timestamptz;
-- No signup expiry policy was confirmed. NULL means no time-based expiry for that kind.
ALTER TABLE public.privacy_consents ALTER COLUMN valid_until DROP NOT NULL;
ALTER TABLE public.privacy_consents ADD CONSTRAINT pledge_expiry_required
 CHECK(consent_type IS DISTINCT FROM 'privacy_pledge' OR valid_until IS NOT NULL);
CREATE INDEX privacy_consents_scope_idx ON public.privacy_consents(profile_id,consent_type,pledge_version,consent_date DESC);

-- Pure, owner-only reader: safe in RLS; no FOR UPDATE/touch/status RPC recursion.
CREATE FUNCTION private.consent_requirements(p_profile public.profiles) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' SET timezone='UTC' AS $$
 WITH org AS (SELECT type,is_active FROM public.organizations WHERE id=p_profile.organization_id),
 wanted AS (
  SELECT 'privacy_pledge'::text AS kind,s.value AS version,true AS required
   FROM (SELECT (SELECT value FROM public.system_settings WHERE key='privacy_pledge_version') AS value) s
   WHERE (SELECT type FROM org)='partner' AND p_profile.role IN ('admin','operator')
  UNION ALL
  SELECT d.kind,d.version,d.required FROM public.consent_policy_versions d
   WHERE d.kind<>'privacy_pledge' AND d.enabled AND d.required
    AND NOT ((SELECT type FROM org)='operator' AND p_profile.role IN ('admin','operator')
      AND p_profile.organization_id<>'10a8e084-c396-4a97-b301-c4ef4aa59d71')
    AND (d.required_for_profiles_created_at_or_after IS NULL OR p_profile.created_at>=d.required_for_profiles_created_at_or_after)
 ), evaluated AS (
  SELECT w.*,d.title,d.document_text,d.text_hash,c.id AS receipt_id,c.withdrawn_at,
   CASE WHEN d.kind IS NULL OR NOT d.enabled THEN 'policy_unavailable'
    WHEN c.id IS NULL THEN 'consent_required'
    WHEN c.withdrawn_at IS NOT NULL THEN 'consent_withdrawn'
    WHEN NOT pg_catalog.isfinite(c.consent_date) OR c.consent_date>statement_timestamp()
      OR (w.kind='privacy_pledge' AND NOT pg_catalog.isfinite(c.valid_until)) THEN 'consent_dates_invalid'
    WHEN w.kind='privacy_pledge' AND (c.valid_until<>(c.consent_date+interval '1 year')::date
      OR CURRENT_DATE>c.valid_until) THEN 'consent_expired'
    WHEN c.policy_text_hash IS DISTINCT FROM d.text_hash AND NOT
      (w.kind='privacy_pledge' AND w.version='v1.0' AND c.policy_text_hash IS NULL) THEN 'consent_document_mismatch'
    ELSE 'valid' END AS reason
  FROM wanted w LEFT JOIN public.consent_policy_versions d ON d.kind=w.kind AND d.version=w.version
  LEFT JOIN LATERAL (SELECT r.* FROM public.privacy_consents r
    WHERE r.profile_id=p_profile.id AND r.consent_type=w.kind AND r.pledge_version=w.version
     AND (w.kind<>'privacy_pledge' OR r.organization_id=p_profile.organization_id)
    ORDER BY r.consent_date DESC,r.created_at DESC,r.id DESC LIMIT 1) c ON true
 ) SELECT COALESCE(jsonb_agg(jsonb_build_object('kind',kind,'version',version,'title',title,
    'document_text',document_text,'text_hash',text_hash,'required',required,
    'valid',reason='valid','reason',reason,'receipt_id',receipt_id) ORDER BY kind),'[]'::jsonb) FROM evaluated;
$$;
CREATE FUNCTION public.has_required_privacy_consent() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT COALESCE((SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(private.consent_requirements(p)) e
    WHERE e->>'valid'<>'true') FROM public.profiles p JOIN public.organizations o ON o.id=p.organization_id
   WHERE p.auth_user_id=auth.uid() AND public.has_valid_app_session() AND o.is_active
    AND p.account_status NOT IN ('suspended','disabled')),false);
$$;
CREATE FUNCTION private.require_business_consent() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF NOT public.has_required_privacy_consent() THEN
  RAISE EXCEPTION 'privacy_consent_required' USING ERRCODE='42501';
 END IF;
END $$;
CREATE FUNCTION public.get_my_consent_requirements() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.profiles; requirements jsonb;
BEGIN
 p:=private.require_consent_profile(); requirements:=private.consent_requirements(p);
 RETURN jsonb_build_object('valid',NOT EXISTS(SELECT 1 FROM jsonb_array_elements(requirements) e WHERE e->>'valid'<>'true'),
   'requirements',requirements);
END $$;

CREATE FUNCTION public.record_policy_consent(p_kind text,p_version text,p_text_hash text,p_agreed boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' SET timezone='UTC' AS $$
DECLARE p public.profiles; d public.consent_policy_versions; receipt public.privacy_consents; v_now timestamptz;
BEGIN
 IF p_agreed IS DISTINCT FROM true THEN RAISE EXCEPTION 'explicit_consent_required' USING ERRCODE='22023'; END IF;
 p:=private.require_consent_profile();
 PERFORM private.require_request_app_session(true);
 SELECT * INTO d FROM public.consent_policy_versions WHERE kind=p_kind AND version=p_version AND enabled FOR SHARE;
 IF NOT FOUND OR d.text_hash IS DISTINCT FROM p_text_hash THEN
  RAISE EXCEPTION 'consent_policy_changed' USING ERRCODE='40001';
 END IF;
 IF p_kind='privacy_pledge' THEN
  PERFORM 1 FROM public.system_settings WHERE key='privacy_pledge_version' AND value=p_version FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'consent_policy_changed' USING ERRCODE='40001'; END IF;
 END IF;
 v_now:=clock_timestamp();
 INSERT INTO public.privacy_consents(profile_id,organization_id,consent_type,pledge_version,consent_date,valid_until,
  user_name_snapshot,user_email_snapshot,company_snapshot,policy_text_hash,policy_text_snapshot,auth_user_id_snapshot,source,created_at)
 VALUES(p.id,p.organization_id,d.kind,d.version,v_now,CASE WHEN d.kind='privacy_pledge' THEN (v_now+interval '1 year')::date ELSE NULL END,
  COALESCE(NULLIF(p.display_name,''),NULLIF(p.full_name,''),p.email),p.email,
  (SELECT name FROM public.organizations WHERE id=p.organization_id),d.text_hash,d.document_text,p.auth_user_id,'authenticated_rpc',v_now)
 RETURNING * INTO receipt;
 PERFORM audit.append_access_log(p_action=>'동의 제출',p_target_type=>'PrivacyConsent',p_target_id=>receipt.id::text,
  p_metadata=>jsonb_build_object('kind',d.kind,'version',d.version,'text_hash',d.text_hash));
 RETURN jsonb_build_object('id',receipt.id,'consent_type',d.kind,'pledge_version',d.version,'text_hash',d.text_hash);
END $$;
CREATE FUNCTION public.withdraw_policy_consent(p_consent_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.profiles; receipt public.privacy_consents;
BEGIN
 p:=private.require_consent_profile(); PERFORM private.require_request_app_session(true);
 UPDATE public.privacy_consents SET withdrawn_at=COALESCE(withdrawn_at,clock_timestamp())
  WHERE id=p_consent_id AND profile_id=p.id RETURNING * INTO receipt;
 IF NOT FOUND THEN RAISE EXCEPTION 'consent_not_found_or_forbidden' USING ERRCODE='42501'; END IF;
 PERFORM audit.append_access_log(p_action=>'동의 철회',p_target_type=>'PrivacyConsent',p_target_id=>receipt.id::text,
  p_metadata=>jsonb_build_object('kind',receipt.consent_type,'version',receipt.pledge_version));
 RETURN jsonb_build_object('id',receipt.id,'withdrawn_at',receipt.withdrawn_at);
END $$;
-- Old clients did not bind the displayed document/version. Do not accept guessed consent.
CREATE OR REPLACE FUNCTION public.record_privacy_consent(p_agreed boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$ BEGIN
 PERFORM private.require_consent_profile();
 RAISE EXCEPTION 'consent_document_required' USING ERRCODE='22023';
END $$;
CREATE OR REPLACE FUNCTION public.get_privacy_consent_status() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.profiles; requirements jsonb; item jsonb;
BEGIN
 p:=private.require_consent_profile(); requirements:=private.consent_requirements(p);
 SELECT e INTO item FROM jsonb_array_elements(requirements) e WHERE e->>'kind'='privacy_pledge';
 RETURN jsonb_build_object('valid',COALESCE((item->>'valid')::boolean,true),
  'reason',COALESCE(item->>'reason','not_required'),'required_pledge_version',item->>'version');
END $$;

CREATE OR REPLACE FUNCTION public.can_access_business(p_business_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT public.has_required_privacy_consent() AND EXISTS(SELECT 1 FROM public.businesses b WHERE b.id=p_business_id AND (
  public.is_company_member() OR (public.current_profile_role() IN ('admin','operator')
    AND public.current_organization_type()='partner' AND EXISTS(SELECT 1 FROM public.service_partners sp
     WHERE sp.business_id=b.id AND sp.partner_organization_id=public.current_organization_id()))));
$$;
CREATE OR REPLACE FUNCTION public.can_access_ticket(p_ticket_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT public.has_required_privacy_consent() AND EXISTS(SELECT 1 FROM public.tickets t WHERE t.id=p_ticket_id AND (
  public.is_company_member() OR (public.current_profile_role() IN ('admin','operator')
   AND public.current_organization_type()='partner' AND EXISTS(SELECT 1 FROM public.service_partners sp
    WHERE sp.business_id=t.business_id AND sp.partner_organization_id=public.current_organization_id()
     AND (sp.access_level='business' OR t.assigned_partner_organization_id=sp.partner_organization_id)))));
$$;
CREATE OR REPLACE FUNCTION public.can_manage_organization(p_organization_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT public.is_company_admin() OR (public.has_required_privacy_consent() AND COALESCE(public.current_profile_role()='admin'
   AND public.current_organization_type()='partner' AND public.current_organization_id()=p_organization_id,false));
$$;
CREATE OR REPLACE FUNCTION public.mark_notifications_read(p_notification_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.profiles; v_count bigint;
BEGIN
 p:=private.require_management_actor(ARRAY['admin','operator']); PERFORM private.require_business_consent();
 UPDATE public.notifications SET is_read=true,read_at=clock_timestamp()
  WHERE recipient_profile_id=p.id AND NOT is_read AND (ticket_id IS NULL OR public.can_access_ticket(ticket_id))
   AND (p_notification_id IS NULL OR id=p_notification_id);
 GET DIAGNOSTICS v_count=ROW_COUNT;
 PERFORM audit.append_access_log(p_action=>'알림 읽음 처리',p_target_type=>'Notification',p_target_id=>p_notification_id::text,
  p_metadata=>jsonb_build_object('count',v_count));
 RETURN jsonb_build_object('count',v_count);
END $$;
-- Restrictive AND gates protect direct reads even if a permissive policy drifts.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['businesses','service_partners','tickets','activities','ticket_attachments','notifications','partner_details'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated USING ((SELECT public.has_required_privacy_consent()))',t||'_select_consent_gate',t);
 END LOOP;
END $$;

-- Public registration documents contain no user data. Draft rows stay hidden.
CREATE POLICY consent_policy_read_anon ON public.consent_policy_versions FOR SELECT TO anon
 USING(enabled AND kind<>'privacy_pledge');
CREATE POLICY consent_policy_read_authenticated ON public.consent_policy_versions FOR SELECT TO authenticated
 USING(enabled AND (kind<>'privacy_pledge' OR public.has_valid_app_session()));
GRANT SELECT ON public.consent_policy_versions TO anon,authenticated;
REVOKE INSERT,UPDATE,DELETE ON public.consent_policy_versions FROM anon,authenticated;
CREATE FUNCTION public.list_signup_consent_policies() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object('kind',kind,'version',version,'title',title,'document_text',document_text,
   'text_hash',text_hash,'required',required) ORDER BY kind),'[]'::jsonb)
 FROM public.consent_policy_versions WHERE enabled AND kind<>'privacy_pledge';
$$;
CREATE FUNCTION private.record_signup_consents(p_profile public.profiles,p_entries jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' SET timezone='UTC' AS $$
DECLARE d public.consent_policy_versions; e jsonb; v_now timestamptz:=clock_timestamp();
BEGIN
 IF p_entries IS NOT NULL AND (jsonb_typeof(p_entries)<>'array' OR jsonb_array_length(p_entries)>3) THEN
  RAISE EXCEPTION 'invalid_signup_consents' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_entries,'[]'::jsonb)) x
     WHERE jsonb_typeof(x)<>'object' OR x->>'kind' IS NULL)
  OR (SELECT count(*)<>count(DISTINCT x->>'kind') FROM jsonb_array_elements(COALESCE(p_entries,'[]'::jsonb)) x) THEN
  RAISE EXCEPTION 'invalid_signup_consents' USING ERRCODE='22023';
 END IF;
 FOR d IN SELECT * FROM public.consent_policy_versions WHERE enabled AND kind<>'privacy_pledge' ORDER BY kind FOR SHARE LOOP
  SELECT x INTO e FROM jsonb_array_elements(COALESCE(p_entries,'[]'::jsonb)) x WHERE x->>'kind'=d.kind;
  IF e IS NULL OR e->'agreed' IS DISTINCT FROM 'true'::jsonb THEN
   IF d.required AND (d.required_for_profiles_created_at_or_after IS NULL
     OR p_profile.created_at>=d.required_for_profiles_created_at_or_after) THEN
    RAISE EXCEPTION 'signup_consent_required' USING ERRCODE='22023';
   END IF;
   CONTINUE;
  END IF;
  IF e->>'version' IS DISTINCT FROM d.version OR e->>'text_hash' IS DISTINCT FROM d.text_hash THEN
   RAISE EXCEPTION 'consent_policy_changed' USING ERRCODE='40001';
  END IF;
  INSERT INTO public.privacy_consents(profile_id,organization_id,consent_type,pledge_version,consent_date,valid_until,
   policy_text_hash,policy_text_snapshot,auth_user_id_snapshot,source,user_email_snapshot,created_at)
  VALUES(p_profile.id,p_profile.organization_id,d.kind,d.version,v_now,NULL,
   d.text_hash,d.document_text,p_profile.auth_user_id,'auth_signup',p_profile.email,v_now);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION private.provision_signup_profile() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.profiles;
BEGIN
 IF NEW.email IS NULL THEN RETURN NEW; END IF;
 INSERT INTO public.profiles(auth_user_id,organization_id,email,full_name,role,account_status)
 VALUES(NEW.id,'10a8e084-c396-4a97-b301-c4ef4aa59d71',NEW.email,
  left(NULLIF(btrim(NEW.raw_user_meta_data->>'full_name'),''),200),'guest','pending_login') RETURNING * INTO p;
 PERFORM private.record_signup_consents(p,NEW.raw_user_meta_data->'signup_consents');
 RETURN NEW;
END $$;

-- New helpers have no default PUBLIC grant; unchanged function ACLs stay intact.
ALTER FUNCTION private.protect_consent_document() OWNER TO postgres;
ALTER FUNCTION private.consent_requirements(public.profiles) OWNER TO postgres;
ALTER FUNCTION private.require_business_consent() OWNER TO postgres;
ALTER FUNCTION private.record_signup_consents(public.profiles,jsonb) OWNER TO postgres;
ALTER FUNCTION public.has_required_privacy_consent() OWNER TO postgres;
ALTER FUNCTION public.get_my_consent_requirements() OWNER TO postgres;
ALTER FUNCTION public.record_policy_consent(text,text,text,boolean) OWNER TO postgres;
ALTER FUNCTION public.withdraw_policy_consent(uuid) OWNER TO postgres;
ALTER FUNCTION public.list_signup_consent_policies() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.protect_consent_document(),private.consent_requirements(public.profiles),
 private.require_business_consent(),private.record_signup_consents(public.profiles,jsonb),
 public.has_required_privacy_consent(),public.get_my_consent_requirements(),
 public.record_policy_consent(text,text,text,boolean),public.withdraw_policy_consent(uuid),
 public.list_signup_consent_policies() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.has_required_privacy_consent(),public.get_my_consent_requirements(),
 public.record_policy_consent(text,text,text,boolean),public.withdraw_policy_consent(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_signup_consent_policies() TO anon,authenticated;
COMMIT;
