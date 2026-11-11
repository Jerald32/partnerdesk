import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {auditTime,roleChanges,roleLabel,changeTypeLabel} from '../src/lib/roleAudit.js';

test('role audit renders Korean labels, KST and only actual changes',()=>{
 assert.match(auditTime('2026-11-10T15:30:25Z'),/2026.*11.*11.*00:30:25/);
 assert.equal(auditTime(null),'기록 없음');assert.equal(auditTime('invalid'),'기록 없음');
 assert.equal(roleLabel('admin','partner'),'Partner · 관리자');
 assert.equal(changeTypeLabel('request_approved'),'요청 승인');
 const row={role_before:'operator',role_after:'admin',org_type_before:'partner',org_type_after:'partner',affiliation_before:'a',affiliation_after:'b',organization_before_name:'A사',organization_after_name:'B사'};
 assert.deepEqual(roleChanges(row).map(c=>c.label),['권한','소속']);
 assert.deepEqual(roleChanges({...row,role_after:'operator',affiliation_after:'a'}),[]);
 assert.equal(roleChanges({...row,role_after:'operator',organization_after_name:null})[0].after,'소속명 확인 불가');
});

test('role audit SQL: identity enrichment, filters, pagination, missing history and security',async()=>{
 const db=new PGlite();
 const actor='10000000-0000-4000-8000-000000000001',target='10000000-0000-4000-8000-000000000002';
 const before='20000000-0000-4000-8000-000000000001',after='20000000-0000-4000-8000-000000000002';
 const query=async(args=[]) => (await db.query('SELECT public.search_admin_role_audit($1,$2,$3,$4,$5) AS result',args.length?args:['',0,null,null,''])).rows[0].result;
 try{
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
   CREATE SCHEMA private;CREATE SCHEMA audit;
   CREATE FUNCTION private.require_request_app_session(boolean) RETURNS void LANGUAGE plpgsql AS $$BEGIN
    IF current_setting('test.session',true) IS DISTINCT FROM 'yes' THEN RAISE EXCEPTION 'app_session_required'; END IF;END$$;
   CREATE FUNCTION public.is_company_admin() RETURNS boolean LANGUAGE sql AS $$SELECT current_setting('test.admin',true)='yes'$$;
   CREATE TABLE public.profiles(id uuid,display_name text,full_name text,email text,organization_id uuid);
   CREATE TABLE public.organizations(id uuid,name text);
   CREATE TABLE public.role_requests(id uuid,created_at timestamptz,justification text,admin_notes text,
    requester_profile_id uuid,requester_name_snapshot text,requester_email_snapshot text,current_affiliation_snapshot text);
   CREATE TABLE audit.role_change_logs(id uuid,changed_at timestamptz,change_type text,target_profile_id uuid,target_user_id text,
    actor_profile_id uuid,actor_id text,actor_role text,role_before text,role_after text,org_type_before text,org_type_after text,
    affiliation_before text,affiliation_after text,role_request_id uuid,source_api text,actor_name text,actor_email text,
    target_name text,target_email text,requested_at timestamptz,request_reason text,issue_reason text,actor_ip text,
    requester_profile_id uuid,requester_name text,requester_email text);`);
  await db.exec(readFileSync(new URL('../supabase/migrations/20261111000000_readable_role_audit.sql',import.meta.url),'utf8'));
  await db.query('INSERT INTO profiles VALUES($1,$2,NULL,$3,$7),($4,$5,NULL,$6,$8)',[actor,'김관리','admin@example.invalid',target,'이담당','user@example.invalid',before,after]);
  await db.query('INSERT INTO organizations VALUES($1,$2),($3,$4)',[before,'A사',after,'B사']);
  await db.exec("SELECT set_config('test.session','yes',false),set_config('test.admin','yes',false)");
  await db.query(`INSERT INTO audit.role_change_logs(id,changed_at,change_type,target_profile_id,actor_profile_id,role_before,role_after,
   org_type_before,org_type_after,affiliation_before,affiliation_after)
   SELECT ('30000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'2026-11-10T15:30:00Z'::timestamptz,
   'direct',$1,$2,'operator','admin','partner','partner',$3,$4 FROM generate_series(1,101) n`,[target,actor,before,after]);
  let result=await query();assert.equal(result.rows.length,100);assert.equal(result.has_more,true);
  assert.equal(result.rows[0].actor_name,'김관리');assert.equal(result.rows[0].target_email,'user@example.invalid');
  assert.equal(result.rows[0].actor_organization_name,'A사');assert.equal(result.rows[0].organization_after_name,'B사');
  assert.equal(result.rows[0].organization_before_name,'A사');assert.equal(result.rows[0].actor_identity_source,'current');
  const next=await query(['',100,null,null,'']);assert.equal(next.rows.length,1);assert.equal(next.has_more,false);
  assert.ok(!result.rows.some(r=>r.id===next.rows[0].id));
  assert.equal((await query(['김관리',0,'2026-11-11','2026-11-11','direct'])).rows.length,100);
  assert.equal((await query(['',0,'2026-11-10','2026-11-10',''])).rows.length,0);
  assert.equal((await query(['missing',0,null,null,''])).rows.length,0);
  assert.equal((await query(['',0,null,null,'request_approved'])).rows.length,0);
  const request='40000000-0000-4000-8000-000000000001';
  await db.query("INSERT INTO role_requests VALUES($1,now(),'업무 담당 변경','승인합니다',$2,'신청 당시 이름','requester@example.invalid','신청 당시 소속')",[request,target]);
  await db.query("UPDATE audit.role_change_logs SET change_type='request_approved',role_request_id=$1,actor_name='당시 이름',affiliation_before='legacy-text' WHERE id=$2",[request,next.rows[0].id]);
  result=await query(['당시 이름',0,null,null,'request_approved']);assert.equal(result.rows.length,1);
  assert.equal(result.rows[0].request_reason,'업무 담당 변경');assert.equal(result.rows[0].admin_notes,'승인합니다');
  assert.equal(result.rows[0].requester_name,'신청 당시 이름');assert.equal(result.rows[0].requester_email,'requester@example.invalid');
  assert.equal(result.rows[0].requester_organization_name,'신청 당시 소속');assert.ok(result.rows[0].requested_at);
  assert.equal(result.rows[0].actor_ip,null);assert.equal(result.rows[0].issue_reason,null);
  assert.equal((await query(['requester@example.invalid',0,null,null,''])).rows.length,1);
  await db.query("UPDATE audit.role_change_logs SET actor_ip='203.0.113.8',issue_reason='담당자 변경에 따른 발급' WHERE id=$1",[result.rows[0].id]);
  result=await query(['신청 당시 이름',0,null,null,'']);
  assert.equal(result.rows[0].actor_ip,'203.0.113.8');assert.equal(result.rows[0].issue_reason,'담당자 변경에 따른 발급');
  assert.equal(result.rows[0].actor_identity_source,'snapshot');assert.equal(result.rows[0].organization_before_name,null);
  await assert.rejects(query(['',-1,null,null,'']),/invalid_search/);
  await assert.rejects(query(['',0,'2026-11-12','2026-11-11','']),/invalid_search/);
  await assert.rejects(query(['a'.repeat(101),0,null,null,'']),/invalid_search/);
  const grants=(await db.query("SELECT has_function_privilege('anon','public.search_admin_role_audit(text,integer,date,date,text)','EXECUTE') AS anon,has_function_privilege('authenticated','public.search_admin_role_audit(text,integer,date,date,text)','EXECUTE') AS authenticated")).rows[0];
  assert.equal(grants.anon,false);assert.equal(grants.authenticated,true);
  await db.exec("SELECT set_config('test.admin','no',false)");await assert.rejects(query(),/role_not_allowed/);
  await db.exec("SELECT set_config('test.session','no',false)");await assert.rejects(query(),/app_session_required/);
 }finally{await db.close();}
});

test('role audit IP captures only same-transaction verified gateway identity and session',async()=>{
 const db=new PGlite();
 const user='10000000-0000-4000-8000-000000000001',actor='10000000-0000-4000-8000-000000000002',proof='10000000-0000-4000-8000-000000000003';
 try{
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
   CREATE SCHEMA auth;CREATE SCHEMA private;CREATE SCHEMA audit;
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('test.user',true),'')::uuid$$;
   CREATE FUNCTION private.request_app_session_token_hash() RETURNS text LANGUAGE sql AS $$SELECT 'session-hash'::text$$;
   CREATE TABLE public.profiles(id uuid,auth_user_id uuid);
   CREATE TABLE private.gateway_nonces(id uuid,ip inet,used_txid bigint,auth_user_id uuid,session_hash text);
   CREATE TABLE audit.role_change_logs(actor_profile_id uuid,actor_ip text);`);
  await db.exec(readFileSync(new URL('../supabase/migrations/20261111000001_role_audit_trusted_ip.sql',import.meta.url),'utf8'));
  await db.query('INSERT INTO profiles VALUES($1,$2)',[actor,user]);
  await db.query("SELECT set_config('test.user',$1,false),set_config('partnerdesk.gateway_request_id',$2,false)",[user,proof]);
  const insert=async()=> (await db.query("INSERT INTO audit.role_change_logs VALUES($1,'spoofed-client-value') RETURNING actor_ip",[actor])).rows[0].actor_ip;
  await db.exec('BEGIN');
  await db.query("INSERT INTO private.gateway_nonces VALUES($1,'203.0.113.9',txid_current(),$2,'session-hash')",[proof,user]);
  assert.equal(await insert(),'203.0.113.9');
  await db.exec("UPDATE private.gateway_nonces SET session_hash='wrong-session'");assert.equal(await insert(),null);
  await db.exec("UPDATE private.gateway_nonces SET session_hash='session-hash',used_txid=txid_current()-1");assert.equal(await insert(),null);
  await db.exec('UPDATE private.gateway_nonces SET used_txid=txid_current()');
  await db.query("SELECT set_config('test.user',$1,false)",[actor]);assert.equal(await insert(),null);
  await db.exec('ROLLBACK');
  assert.equal(await insert(),null);
 }finally{await db.close();}
});
