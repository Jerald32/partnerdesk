import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {signProof} from '../server/gateway/security.mjs';
import {previousReviewMonth,reviewError,reviewStatus} from '../src/lib/accessReview.js';
import {RPCS} from '../server/gateway/transport.mjs';
const id=n=>`71000000-0000-4000-8000-${String(n).padStart(12,'0')}`,raw=n=>n.toString(16).padStart(64,'0'),key='12'.repeat(32);

test('monthly review labels, KST year boundary and gateway allowlist',()=>{
 assert.equal(previousReviewMonth(new Date('2026-12-31T15:00:00Z')),'2026-12');
 assert.equal(previousReviewMonth(new Date('2026-12-31T14:59:59Z')),'2026-11');
 assert.equal(reviewStatus('rejected'),'보완 필요');assert.ok(reviewError({message:'self_approval_forbidden'}));
 for(const name of ['list_access_reviews','read_access_review','request_access_review','decide_access_review'])assert.ok(RPCS.has(name));
});

test('monthly review: real gateway, fixed scope, decisions, notifications and immutable evidence',async t=>{
 const db=new PGlite({extensions:{pgcrypto}}),q=async(s,a=[]) => (await db.query(s,a)).rows;
 const value=async(s,a=[]) => (await q(s,a))[0].result;
 async function call(n,name,args={}) {
  const body=JSON.stringify({name,args}),proof=signProof({ip:'192.0.2.1',userId:id(n),sessionToken:raw(n),path:'rpc/gateway_rpc',method:'POST',body,policyVersion:1},key);
  await db.exec('BEGIN');try{
   await q("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.headers',$2,true),set_config('request.method','POST',true),set_config('request.path','/rpc/gateway_rpc',true)",
    [id(n),JSON.stringify({'x-partnerdesk-session':raw(n),'x-partnerdesk-proof':proof.payload,'x-partnerdesk-signature':proof.signature})]);
   await db.exec('SET LOCAL ROLE authenticated');await q('SELECT enforce_gateway_route()');
   const result=await value('SELECT gateway_rpc($1) AS result',[body]);
   if(result?._gateway_error)throw Object.assign(new Error(result._gateway_error.message),{code:result._gateway_error.code});
   await db.exec('COMMIT');return result;
  }catch(error){await db.exec('ROLLBACK');throw error;}
 }
 try{
  await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;CREATE ROLE authenticator NOLOGIN;
   CREATE SCHEMA extensions;CREATE EXTENSION pgcrypto WITH SCHEMA extensions;CREATE SCHEMA auth;GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
   CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb DEFAULT '{}',encrypted_password text);
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated,service_role;`);
  for(const file of readdirSync(new URL('../supabase/migrations/',import.meta.url)).sort()){
   if(file.startsWith('20261008000003')){
    await q("INSERT INTO organizations(id,name,type) VALUES($1,'Company','operator'),($2,'Partner','partner')",[id(1),id(2)]);
    await q("INSERT INTO partner_details(organization_id,partner_type) VALUES($1,'other')",[id(2)]);
    for(const [n,org,role]of [[11,1,'admin'],[12,1,'operator'],[13,1,'operator'],[14,2,'admin'],[15,1,'guest'],[16,1,'operator']]){
     await q('INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,clock_timestamp())',[id(n),`review${n}@example.invalid`]);
     await q("UPDATE profiles SET organization_id=$1,role=$2,account_status='active' WHERE auth_user_id=$3",[id(org),role,id(n)]);
     await q(`INSERT INTO private.app_sessions(profile_id,auth_user_id,session_token_hash,authenticated_at,expires_at,last_activity_at)
      SELECT id,auth_user_id,encode(sha256(decode($2,'hex')),'hex'),clock_timestamp(),clock_timestamp()+interval '8 hours',clock_timestamp() FROM profiles WHERE auth_user_id=$1`,[id(n),raw(n)]);
    }
   }
   if(file.startsWith('20261017000000'))await q("UPDATE private.gateway_config SET signing_key=decode($1,'hex')",[key]);
   let sql=readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');
   if(file==='20261006000015_add_user_role_management.sql')sql=sql.replace("CASE WHEN v_org.type = 'operator' THEN 'operator_company' ELSE 'partner' END THEN","(CASE WHEN v_org.type = 'operator' THEN 'operator_company' ELSE 'partner' END) THEN");
   await db.exec(sql);
  }
  await db.exec("UPDATE profiles SET account_status='disabled' WHERE email='review16@example.invalid'");
  const profiles=await q('SELECT id,auth_user_id FROM profiles WHERE auth_user_id IS NOT NULL');
  const profile=n=>profiles.find(p=>p.auth_user_id===id(n)).id;
  const month=(await call(11,'list_access_reviews')).previous_month;
  // Construct valid immutable fixture records, preserving the real audit hash chain.
  await db.exec(`CREATE FUNCTION pg_temp.seed_review_log(p_when timestamptz) RETURNS uuid LANGUAGE plpgsql AS $$
   DECLARE r audit.access_logs;tail audit.access_logs;BEGIN
    SELECT * INTO tail FROM audit.access_logs ORDER BY seq DESC LIMIT 1;
    r.id:=gen_random_uuid();r.seq:=COALESCE(tail.seq,0)+1;r.user_id:='system';r.user_role:='system';
    r.action:='fixture_event';r.accessed_at:=p_when;r.created_at:=greatest(clock_timestamp(),tail.created_at+interval '1 microsecond');
    r.metadata:='{}'::jsonb;r.prev_hash:=COALESCE(tail.record_hash,'GENESIS');r.record_hash:=audit.access_log_record_hash(r);
    INSERT INTO audit.access_logs SELECT (r).*;RETURN r.id;END$$;`);
  for(let n=0;n<102;n++)await q("SELECT pg_temp.seed_review_log(($1::date::timestamp AT TIME ZONE 'Asia/Seoul')+interval '1 hour')",[month]);
  const request={p_month:month,p_approver_id:profile(12),p_summary:'월별 접속 점검 완료',p_findings:'특이사항 없음',p_actions:'조치 불필요'};
  await t.test('only global admin requests; candidates exclude self, Partner, Guest and disabled users',async()=>{
   const list=await call(11,'list_access_reviews');assert.deepEqual(list.approvers.map(p=>p.id).sort(),[profile(12),profile(13)].sort());
   await assert.rejects(call(12,'request_access_review',request),/role_not_allowed/);
   await assert.rejects(call(14,'request_access_review',request),/company_member_required/);
   await assert.rejects(call(15,'list_access_reviews'),/company_member_required/);
   await assert.rejects(call(11,'request_access_review',{...request,p_approver_id:profile(11)}),/self_approval_forbidden/);
   for(const n of [14,15,16])await assert.rejects(call(11,'request_access_review',{...request,p_approver_id:profile(n)}),{code:'22023'});
   await assert.rejects(call(11,'request_access_review',{...request,p_summary:'   '}));
   const current=(await q("SELECT date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date::text AS month"))[0].month;
   await assert.rejects(call(11,'request_access_review',{...request,p_month:current}));
  });
  let review;
  await t.test('request fixes all monthly records, sends one notification and blocks duplicate requests',async()=>{
   review=await call(11,'request_access_review',request);assert.equal(review.log_count,102);
   await assert.rejects(call(11,'request_access_review',request),{code:'23505'});
   const notices=await q('SELECT * FROM notifications WHERE access_review_id=$1',[review.id]);assert.equal(notices.length,1);assert.equal(notices[0].recipient_profile_id,profile(12));
   await q("SELECT pg_temp.seed_review_log(($1::date::timestamp AT TIME ZONE 'Asia/Seoul')+interval '2 hours')",[month]);
   const detail=await call(12,'read_access_review',{p_review_id:review.id});assert.equal(detail.log_count,102);assert.equal(detail.rows.length,100);assert.equal(detail.has_more,true);
   assert.equal(detail.review.requester_ip,'192.0.2.1');assert.equal(detail.review.summary,request.p_summary);
   const next=await call(12,'read_access_review',{p_review_id:review.id,p_offset:100});assert.equal(next.rows.length,2);assert.equal(next.has_more,false);
   assert.ok(!next.rows.some(x=>detail.rows.some(y=>x.id===y.id)));
  });
  await t.test('designated operator sees assigned requests only and gains no general audit rights',async()=>{
   assert.equal((await call(12,'list_access_reviews')).rows.length,1);
   assert.equal((await call(13,'list_access_reviews')).rows.length,0);
   await assert.rejects(call(13,'read_access_review',{p_review_id:review.id}),/review_not_available/);
   await assert.rejects(call(14,'read_access_review',{p_review_id:review.id}),/company_member_required/);
   await assert.rejects(call(12,'search_admin_access_audit',{}),/role_not_allowed/);
   await assert.rejects(call(11,'decide_access_review',{p_review_id:review.id,p_outcome:'approved',p_comment:'본인 승인'}),/designated_approver_required/);
   await assert.rejects(call(13,'decide_access_review',{p_review_id:review.id,p_outcome:'approved',p_comment:'무권한 승인'}),/designated_approver_required/);
   await assert.rejects(call(12,'decide_access_review',{p_review_id:review.id,p_outcome:'approved',p_comment:' '}));
  });
  await t.test('rejection and withdrawal preserve old versions; only approval completes the month',async()=>{
   await call(12,'decide_access_review',{p_review_id:review.id,p_outcome:'rejected',p_comment:'조치 내역 보완 요청'});
   assert.equal((await call(11,'list_access_reviews')).previous_month_approved,false);
   await assert.rejects(call(12,'decide_access_review',{p_review_id:review.id,p_outcome:'approved',p_comment:'재처리'}),/review_already_decided/);
   const second=await call(11,'request_access_review',{...request,p_summary:'보완 완료'});
   await assert.rejects(call(12,'decide_access_review',{p_review_id:second.id,p_outcome:'withdrawn',p_comment:'회수'}),/role_not_allowed/);
   await call(11,'decide_access_review',{p_review_id:second.id,p_outcome:'withdrawn',p_comment:'승인자 재지정'});
   const third=await call(11,'request_access_review',request);assert.equal(third.log_count,103);
   await call(12,'decide_access_review',{p_review_id:third.id,p_outcome:'approved',p_comment:'기록과 조치 확인 완료'});
   const detail=await call(12,'read_access_review',{p_review_id:third.id});
   assert.equal(detail.review.status,'approved');assert.equal(detail.review.decision_ip,'192.0.2.1');assert.ok(detail.review.decided_at);
   const list=await call(11,'list_access_reviews');assert.equal(list.previous_month_approved,true);assert.equal(list.rows.length,3);
   await assert.rejects(call(11,'request_access_review',request),{code:'23505'});
  });
  await t.test('recent scope covers exactly three completed review months and all scope retains older requests',async()=>{
   const oldMonth=(await q("SELECT ($1::date-interval '3 months')::date::text AS month",[month]))[0].month;
   const old=await call(11,'request_access_review',{...request,p_month:oldMonth});
   const recent=await call(11,'list_access_reviews');assert.equal(recent.scope,'recent');assert.equal(recent.rows.some(r=>r.id===old.id),false);
   assert.equal(recent.monthly_summary.length,3);assert.equal(recent.monthly_summary[0].review_month,month);
   assert.equal(recent.monthly_summary[0].status,'approved');assert.equal(recent.monthly_summary[1].status,'not_requested');
   assert.deepEqual((await call(12,'list_access_reviews')).monthly_summary,[]);
   assert.equal(recent.range_to,month);
   const all=await call(11,'list_access_reviews',{p_scope:'all'});assert.equal(all.rows.some(r=>r.id===old.id),true);assert.equal(all.range_from,null);
   assert.equal((await call(13,'list_access_reviews',{p_scope:'all'})).rows.length,0);
   await assert.rejects(call(11,'list_access_reviews',{p_scope:'unknown'}),{code:'22023'});
  });
  await t.test('history is immutable, direct access is denied, and audit failures roll back the entire request',async()=>{
   for(const table of ['access_reviews','access_review_items','access_review_decisions']){
    await assert.rejects(db.exec(`DELETE FROM audit.${table}`),/audit_history_immutable/);
    await assert.rejects(db.exec(`TRUNCATE audit.${table} CASCADE`),/audit_history_immutable/);
    assert.equal((await q("SELECT has_table_privilege('authenticated',$1,'SELECT,INSERT,UPDATE,DELETE') AS rights",['audit.'+table]))[0].rights,false);
   }
   await db.exec(`CREATE FUNCTION audit.fail_review_test() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'review_audit_failure';END$$;
    CREATE TRIGGER fail_review_test BEFORE INSERT ON audit.access_logs FOR EACH ROW EXECUTE FUNCTION audit.fail_review_test();`);
   const earlier=(await q("SELECT ($1::date-interval '1 month')::date::text AS month",[month]))[0].month;
   await assert.rejects(call(11,'request_access_review',{...request,p_month:earlier}),/review_audit_failure/);
   assert.equal((await q('SELECT count(*)::integer AS n FROM audit.access_reviews'))[0].n,4);
   await db.exec('DROP TRIGGER fail_review_test ON audit.access_logs');
   assert.equal((await value('SELECT audit.verify_access_log_chain() AS result')).ok,true);
  });
 }finally{await db.close();}
});
