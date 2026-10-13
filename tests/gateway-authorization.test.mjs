import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {signProof} from '../server/gateway/security.mjs';
const id=n=>`60000000-0000-4000-8000-${String(n).padStart(12,'0')}`,raw=n=>n.toString(16).padStart(64,'0'),key='12'.repeat(32);
test('gateway: actual PostgreSQL HMAC, nonce use, RLS and policy transition',async t=>{
 const db=new PGlite({extensions:{pgcrypto}});const q=async(s,a=[]) => (await db.query(s,a)).rows;
 const val=async(s,a=[]) => (await q(s,a))[0].result;
 async function request(n,name,body,proofOverride,commit=false){
  const text=JSON.stringify(body),proof=proofOverride||signProof({ip:'192.0.2.1',userId:id(n),sessionToken:raw(n),path:'rpc/'+name,method:'POST',body:text,policyVersion:1},key);
  await db.exec('BEGIN');try{
   await q("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.headers',$2,true),set_config('request.method','POST',true),set_config('request.path',$3,true)",
    [id(n),JSON.stringify({'x-partnerdesk-session':raw(n),'x-partnerdesk-proof':proof.payload,'x-partnerdesk-signature':proof.signature}),'/rpc/'+name]);
   await db.exec('SET LOCAL ROLE authenticated');await q('SELECT enforce_gateway_route()');
   const result=await val(`SELECT ${name}($1) AS result`,[text]);
   if(commit){await db.exec('COMMIT');return {result,proof};}return {result,proof};
  }finally{if(!commit)await db.exec('ROLLBACK');else await db.exec('ROLLBACK').catch(()=>{});}
 }
 try{
  await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;CREATE ROLE authenticator NOLOGIN;
   CREATE SCHEMA extensions;CREATE EXTENSION pgcrypto WITH SCHEMA extensions;CREATE SCHEMA auth;GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
   CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb DEFAULT '{}',encrypted_password text);
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated,service_role;`);
  for(const file of readdirSync(new URL('../supabase/migrations/',import.meta.url)).sort()){
   if(file.startsWith('20261008000003')){
    await q("INSERT INTO organizations(id,name,type) VALUES($1,'fixture company','operator'),($2,'fixture partner','partner')",[id(1),id(2)]);
    await q("INSERT INTO partner_details(organization_id,partner_type) VALUES($1,'other')",[id(2)]);
    for(const [n,org,role]of [[11,1,'admin'],[12,1,'operator'],[13,2,'guest']]){
     await q('INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,clock_timestamp())',[id(n),`gateway${n}@example.invalid`]);
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
  await db.exec('GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated');
  await q("INSERT INTO businesses(id,name) VALUES($1,'fixture')",[id(20)]);
  await q("INSERT INTO tickets(id,business_id,title) VALUES($1,$2,'fixture')",[id(21),id(20)]);
  const read={table:'tickets',filters:[],order:[{column:'id',direction:'asc'}],limit:100,offset:0};
  await t.test('no proof: direct table/GraphQL-equivalent query empty, old business RPC denied',async()=>{
   await db.exec('BEGIN');try{
    await q("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.headers',$2,true),set_config('request.method','POST',true),set_config('request.path','rpc/deactivate_profile',true)",[id(11),JSON.stringify({'x-partnerdesk-session':raw(11)})]);
    await db.exec('SET LOCAL ROLE authenticated');assert.equal((await q('SELECT * FROM tickets')).length,0);
    await assert.rejects(q('SELECT enforce_gateway_route()'),/gateway_required/);
   }finally{await db.exec('ROLLBACK');}
  });
  await t.test('genuine proof permits read with original org/role RLS and supports nested profile fields',async()=>{
   assert.equal((await request(11,'gateway_read',read)).result.rows.length,1);
   assert.equal((await request(13,'gateway_read',read)).result.rows.length,0);
   const profile={table:'profiles',filters:[{column:'auth_user_id',op:'eq',value:id(11)}],order:[{column:'id',direction:'asc'}],limit:1,offset:0};
   const result=(await request(11,'gateway_read',profile)).result;assert.equal(result.rows[0].organization.id,id(1));
  });
  await t.test('modified, expired, wrong-user and wrong-body proof denied',async()=>{
   const proof=signProof({ip:'192.0.2.1',userId:id(11),sessionToken:raw(11),path:'rpc/gateway_read',method:'POST',body:JSON.stringify(read),policyVersion:1},key);
   await assert.rejects(request(11,'gateway_read',read,{...proof,signature:'00'.repeat(32)}),/signature_invalid/);
   await assert.rejects(request(12,'gateway_read',read,proof),/binding_invalid/);
   await assert.rejects(request(11,'gateway_read',{...read,limit:1},proof),/binding_invalid/);
   const expired=signProof({ip:null,userId:id(11),sessionToken:raw(11),path:'rpc/gateway_read',method:'POST',body:JSON.stringify(read),policyVersion:1},key,{now:Date.now()-30000});
   await assert.rejects(request(11,'gateway_read',read,expired),/expired/);
  });
  await t.test('success and failed business requests both consume nonce once across transactions',async()=>{
   const {proof}=await request(11,'gateway_read',read,undefined,true);
   await assert.rejects(request(11,'gateway_read',read,proof),/replayed/);
   const invalid={name:'deactivate_profile',args:{p_profile_id:(await q('SELECT id FROM profiles WHERE auth_user_id=$1',[id(11)]))[0].id}};
   const failure=await request(11,'gateway_rpc',invalid,undefined,true);assert.equal(failure.result._gateway_error.code,'42501');
   await assert.rejects(request(11,'gateway_rpc',invalid,failure.proof),/replayed/);
  });
  await t.test('only Company Admin changes IP/CIDR; empty/recovery-unconfirmed activation rejected',async()=>{
   const save={name:'save_ip_entry',args:{p_id:null,p_ip:'192.0.2.19/24',p_description:'fixture',p_active:true,p_expected_version:1}};
   assert.equal((await request(12,'gateway_rpc',save)).result._gateway_error.code,'42501');
   assert.equal((await request(11,'gateway_rpc',save)).result.ip_address,'192.0.2.0/24');
   const denied=await request(11,'gateway_rpc',{name:'request_ip_activation',args:{p_expected_version:1}});assert.ok(denied.result._gateway_error);
   assert.equal((await q('SELECT mode FROM private.gateway_config'))[0].mode,'monitor');
  });
  await t.test('enforced IP check rejects outside list; expired pending change restores prior policy and list',async()=>{
   await q("UPDATE private.gateway_config SET mode='enforced'");
   await assert.rejects(request(11,'gateway_read',read),/ip_not_allowed/);
   await q("UPDATE private.gateway_config SET pending=jsonb_build_object('old_mode','monitor','old_entries','[]'::jsonb,'expires_at',clock_timestamp()-interval '1 second')");
   const r=await val('SELECT backend_gateway_policy() AS result');assert.equal(r.mode,'monitor');
   assert.equal((await val('SELECT audit.verify_access_log_chain() AS result')).ok,true);
  });
  await t.test('single IP activation requires independent operator verification and explicit Company Admin approval',async()=>{
   await q("INSERT INTO ip_whitelist(ip_address,is_active) VALUES('192.0.2.1/32',true)");
   const version=Number((await q('SELECT version FROM private.gateway_config'))[0].version);
   const activation={name:'request_ip_activation',args:{p_expected_version:version}};
   assert.equal((await request(11,'gateway_rpc',activation)).result._gateway_error.message,'recovery_path_required');
   const verified=await val("SELECT private.verify_ip_operator_recovery('isolated-test') AS result");
   assert.equal((await request(11,'gateway_rpc',activation)).result._gateway_error.message,'recovery_path_required');
   const ack={name:'acknowledge_ip_operator_recovery',args:{p_id:verified.id,p_approved:true}};
   assert.equal((await request(12,'gateway_rpc',ack)).result._gateway_error.code,'42501');
   const noApproval={...ack,args:{...ack.args,p_approved:false}};
   assert.equal((await request(11,'gateway_rpc',noApproval)).result._gateway_error.message,'explicit_approval_required');
   await request(11,'gateway_rpc',ack,undefined,true);
   assert.equal((await request(12,'gateway_rpc',activation)).result._gateway_error.code,'42501');
   const wrong=signProof({ip:'198.51.100.1',userId:id(11),sessionToken:raw(11),path:'rpc/gateway_rpc',method:'POST',body:JSON.stringify(activation),policyVersion:version},key);
   assert.equal((await request(11,'gateway_rpc',activation,wrong)).result._gateway_error.message,'recovery_path_required');
   await request(11,'gateway_rpc',activation,undefined,true);
   const pending=(await q('SELECT mode,pending FROM private.gateway_config'))[0];
   assert.equal(pending.mode,'enforced');assert.equal(pending.pending.old_mode,'monitor');
   assert.equal((await request(11,'gateway_rpc',{name:'confirm_ip_transition',args:{}})).result._gateway_error.message,'reauthentication_required');
   await q("UPDATE private.gateway_config SET pending=jsonb_set(pending,'{expires_at}',to_jsonb(clock_timestamp()-interval '1 second'))");
   assert.equal((await val('SELECT backend_gateway_policy() AS result')).mode,'monitor');
   await q("UPDATE private.ip_operator_recovery SET verified_at=clock_timestamp()-interval '8 days'");
   const latest=Number((await q('SELECT version FROM private.gateway_config'))[0].version);
   assert.equal((await request(11,'gateway_rpc',{name:'request_ip_activation',args:{p_expected_version:latest}})).result._gateway_error.message,'recovery_path_required');
   assert.equal((await q("SELECT has_function_privilege('authenticated','private.verify_ip_operator_recovery(text)','EXECUTE') AS allowed"))[0].allowed,false);
  });
  await t.test('gateway-only session validation keeps verified email, account and no-touch expiry checks with failure audit',async()=>{
   const body={name:'validate_app_session',args:{}};
   const beforeState=(await q('SELECT authenticated_at,last_activity_at,expires_at FROM private.app_sessions WHERE auth_user_id=$1',[id(11)]))[0];
   const before=beforeState.last_activity_at;
   const valid=(await request(11,'gateway_rpc',body)).result;
   assert.equal(valid.success,true);assert.equal(valid.valid,true);
   assert.equal(Number((await q('SELECT last_activity_at FROM private.app_sessions WHERE auth_user_id=$1',[id(11)]))[0].last_activity_at),Number(before));
   await q("UPDATE profiles SET email='mismatch@example.invalid' WHERE auth_user_id=$1",[id(11)]);
   assert.equal((await request(11,'gateway_rpc',body)).result.reason,'email_identity_mismatch');
   await q('UPDATE profiles SET email=(SELECT email FROM auth.users WHERE id=$1) WHERE auth_user_id=$1',[id(11)]);
   await q("UPDATE profiles SET account_status='suspended' WHERE auth_user_id=$1",[id(11)]);
   assert.equal((await request(11,'gateway_rpc',body)).result.reason,'account_suspended');
   await q("UPDATE profiles SET account_status='active' WHERE auth_user_id=$1",[id(11)]);
   await q('UPDATE auth.users SET email_confirmed_at=NULL WHERE id=$1',[id(11)]);
   assert.equal((await request(11,'gateway_rpc',body)).result.reason,'email_not_verified');
   await q('UPDATE auth.users SET email_confirmed_at=clock_timestamp() WHERE id=$1',[id(11)]);
   await q("UPDATE private.app_sessions SET authenticated_at=clock_timestamp()-interval '1 hour',last_activity_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second' WHERE auth_user_id=$1",[id(11)]);
   const invalid=(await request(11,'gateway_rpc',body,undefined,true)).result;
   assert.equal(invalid.success,false);assert.equal(invalid.reason,'absolute_expired');
   assert.ok((await q("SELECT * FROM audit.access_logs WHERE action='session_blocked'")).length>0);
   await q('UPDATE private.app_sessions SET authenticated_at=$2,last_activity_at=$3,expires_at=$4 WHERE auth_user_id=$1',[id(11),beforeState.authenticated_at,beforeState.last_activity_at,beforeState.expires_at]);
   assert.equal((await q("SELECT has_function_privilege('anon','public.validate_app_session()','EXECUTE') AS allowed"))[0].allowed,false);
   assert.equal((await q("SELECT has_function_privilege('service_role','public.validate_app_session()','EXECUTE') AS allowed"))[0].allowed,false);
  });
  await t.test('only Company Admin disables IP enforcement with audit and unchanged gateway boundary',async()=>{
   await q("UPDATE private.gateway_config SET mode='enforced',pending=jsonb_build_object('old_mode','enforced','expires_at',clock_timestamp()+interval '10 minutes')");
   const version=Number((await q('SELECT version FROM private.gateway_config'))[0].version);
   const body={name:'disable_ip_policy',args:{p_expected_version:version}};
   assert.equal((await request(12,'gateway_rpc',body)).result._gateway_error.code,'42501');
   assert.equal((await request(11,'gateway_rpc',{...body,args:{p_expected_version:version-1}})).result._gateway_error.code,'40001');
   await request(11,'gateway_rpc',body,undefined,true);
   const cfg=(await q('SELECT enabled,mode,pending,version FROM private.gateway_config'))[0];
   assert.equal(cfg.mode,'monitor');assert.equal(cfg.enabled,true);assert.equal(cfg.pending,null);
   assert.equal(Number(cfg.version),version+1);
   assert.equal((await q("SELECT count(*)::integer AS count FROM audit.access_logs WHERE action='ip_policy_disabled'"))[0].count,1);
   assert.equal((await val('SELECT audit.verify_access_log_chain() AS result')).ok,true);
  });
  await t.test('documented operator recovery restores business access without removing proof boundary',async()=>{
   await q('UPDATE ip_whitelist SET is_active=false');
   const doc=readFileSync(new URL('../docs/ip-emergency-recovery.md',import.meta.url),'utf8');
   const sql=doc.match(/<!-- recovery-sql-start -->\s*```sql\n([\s\S]*?)```/)[1];
   await q("UPDATE private.gateway_config SET mode='enforced',pending=jsonb_build_object('old_mode','enforced','expires_at',clock_timestamp()-interval '1 second')");
   await assert.rejects(request(11,'gateway_read',read),/ip_not_allowed/);
   const before=(await q('SELECT version,encode(signing_key,\'hex\') AS key FROM private.gateway_config'))[0];
   await db.exec(sql);
   const after=(await q('SELECT enabled,mode,version,pending,encode(signing_key,\'hex\') AS key FROM private.gateway_config'))[0];
   assert.equal(after.enabled,true);assert.equal(after.mode,'monitor');assert.equal(after.pending,null);
   assert.equal(Number(after.version),Number(before.version)+1);assert.equal(after.key,before.key);
   assert.equal((await val('SELECT backend_gateway_policy() AS result')).mode,'monitor');
   assert.equal((await request(11,'gateway_read',read)).result.rows.length,1);
   const logs=await q("SELECT * FROM audit.access_logs WHERE action='ip_policy_emergency_recovered'");
   assert.equal(logs.length,1);assert.equal(logs[0].user_ip,null);
   assert.equal((await val('SELECT audit.verify_access_log_chain() AS result')).ok,true);
   await db.exec('BEGIN');try{
    await q("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.method','GET',true),set_config('request.path','/tickets',true)",[id(11)]);
    await db.exec('SET LOCAL ROLE authenticated');assert.equal((await q('SELECT * FROM tickets')).length,0);
    await assert.rejects(q('SELECT enforce_gateway_route()'),/gateway_required/);
   }finally{await db.exec('ROLLBACK');}
  });
 }finally{await db.close();}
});
