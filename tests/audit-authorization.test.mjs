import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const id=n=>`30000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const raw=n=>n.toString(16).padStart(64,'0');
test('server audit: authorization, immutable history and transactional failure',async t=>{
 const db=new PGlite(); const q=async(s,a=[]) => (await db.query(s,a)).rows;
 const value=async(s,a=[]) => (await q(s,a))[0].result;
 async function actor(n,fn,withToken=true){
  await db.exec('BEGIN');
  try{
   await q("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.headers',$2,true),set_config('request.method','POST',true)",
    [id(n),JSON.stringify(withToken?{'x-partnerdesk-session':raw(n)}:{})]);
   await db.exec('SET LOCAL ROLE authenticated');return await fn();
  }finally{await db.exec('ROLLBACK');}
 }
 try{
  await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
   CREATE SCHEMA auth;GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
   CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb DEFAULT '{}',encrypted_password text);
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated,service_role;`);
  // Stage 3 baseline: stage 4 deliberately blocks all disposal, tested separately.
  const files=readdirSync(new URL('../supabase/migrations/',import.meta.url)).sort().filter(f=>f<'20261015000000');
  for(const file of files.filter(f=>f<'20261008000003')){
   let s=readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');
   if(file==='20261006000015_add_user_role_management.sql')s=s.replace("CASE WHEN v_org.type = 'operator' THEN 'operator_company' ELSE 'partner' END THEN","(CASE WHEN v_org.type = 'operator' THEN 'operator_company' ELSE 'partner' END) THEN");
   await db.exec(s);
  }
  await q("INSERT INTO organizations(id,name,type) VALUES($1,'fixture company','operator'),($2,'fixture partner','partner')",[id(1),id(2)]);
  await q("INSERT INTO partner_details(organization_id,partner_type) VALUES($1,'other')",[id(2)]);
  for(const [n,org,role] of [[11,1,'admin'],[12,1,'operator'],[13,2,'guest']]){
   await q("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,clock_timestamp())",[id(n),`audit${n}@example.invalid`]);
   await q("UPDATE profiles SET organization_id=$1,role=$2,account_status='active' WHERE auth_user_id=$3",[id(org),role,id(n)]);
   await q(`INSERT INTO private.app_sessions(profile_id,auth_user_id,session_token_hash,authenticated_at,expires_at,last_activity_at)
    SELECT id,auth_user_id,encode(sha256(decode($2,'hex')),'hex'),clock_timestamp(),clock_timestamp()+interval '8 hours',clock_timestamp()
    FROM profiles WHERE auth_user_id=$1`,[id(n),raw(n)]);
  }
  for(const file of files.filter(f=>f>='20261008000003')){
   await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  }
  await q("INSERT INTO system_settings(key,value) VALUES('mfa_enabled','false')");
  await q("INSERT INTO businesses(id,name) VALUES($1,'fixture business')",[id(20)]);
  await q("INSERT INTO tickets(id,business_id,title,customer_contact) VALUES($1,$2,'fixture ticket','private fixture value')",[id(21),id(20)]);
  await t.test('authorized detail read creates server evidence without copying personal data or spoofed IP',async()=>actor(11,async()=>{
   const r=await value('SELECT read_ticket_detail_audited($1) AS result',[id(21)]);assert.equal(r.id,id(21));
   const logs=await value("SELECT search_admin_access_audit('ticket_detail_read',0) AS result");
   assert.equal(logs.rows.length,1);const log=logs.rows[0];
   assert.equal(log.user_ip,null);assert.equal(log.ip_unavailable_reason,'trusted_request_ip_not_available');
   assert.match(log.request_id,/^[0-9a-f-]{36}$/);assert.equal(log.organization_id,id(1));
   assert.equal(log.result,'success');assert.ok(!JSON.stringify(log).includes('private fixture value'));
  }));
  await t.test('JWT alone and Guest cannot use detail endpoint; operator cannot read audit',async()=>{
   await actor(11,()=>assert.rejects(q('SELECT read_ticket_detail_audited($1)',[id(21)]),/app_session_required/),false);
   await actor(13,async()=>assert.equal(await value('SELECT read_ticket_detail_audited($1) AS result',[id(21)]),null));
   await actor(12,()=>assert.rejects(q('SELECT search_admin_access_audit()'),/role_not_allowed/));
  });
  await t.test('ordinary users cannot access audit storage or invoke private append/auth writers',async()=>{
   const p=await q(`SELECT has_table_privilege('authenticated','audit.access_logs','INSERT,UPDATE,DELETE,SELECT') AS rights,
    has_function_privilege('authenticated','private.auth_event_audit(uuid,text,boolean,uuid)','EXECUTE') AS writer`);
   assert.equal(p[0].rights,false);assert.equal(p[0].writer,false);
   await actor(11,()=>assert.rejects(q('SELECT * FROM audit.access_logs'),/permission denied/));
  });
  await t.test('attachment create/edit/delete and ticket deletion record only metadata identifiers',async()=>{
   await q("INSERT INTO ticket_attachments(id,ticket_id,object_path,original_name) VALUES($1,$2,'private path','private file')",[id(30),id(21)]);
   await q("UPDATE ticket_attachments SET original_name='another private file' WHERE id=$1",[id(30)]);
   await q('DELETE FROM ticket_attachments WHERE id=$1',[id(30)]);
   const logs=await q("SELECT action,metadata FROM audit.access_logs WHERE target_type='TicketAttachment'");
   assert.deepEqual(logs.map(x=>x.action),['ticket_attachments_insert','ticket_attachments_update','ticket_attachments_delete']);
   assert.ok(!JSON.stringify(logs).includes('private file'));
   await db.exec('BEGIN');try{await q('DELETE FROM tickets WHERE id=$1',[id(21)]);
    assert.equal((await q("SELECT count(*)::int AS n FROM audit.access_logs WHERE action='tickets_delete'"))[0].n,1);
   }finally{await db.exec('ROLLBACK');}
  });
  await t.test('owner cannot mutate or truncate history',async()=>{
   for(const table of ['access_logs','role_change_logs','data_deletion_logs']){
    await assert.rejects(db.exec(`DELETE FROM audit.${table}`),/audit_history_immutable/);
    await assert.rejects(db.exec(`TRUNCATE audit.${table}`),/audit_history_immutable/);
   }
  });
  await t.test('session issuance, rejected session and logout are audited without tokens',async()=>{
   await db.exec('BEGIN');try{
   const h='ef'.repeat(32);
   assert.equal((await value('SELECT backend_activate_app_session_without_mfa($1,$2,NULL) AS result',[id(11),h])).ok,true);
   assert.equal((await value('SELECT backend_validate_and_touch_app_session($1,$2,false) AS result',[id(11),'ff'.repeat(32)])).valid,false);
   assert.equal((await value('SELECT backend_revoke_app_session($1,$2) AS result',[id(11),h])).ok,true);
   const logs=await q("SELECT action,metadata FROM audit.access_logs WHERE target_type='Authentication'");
   assert.deepEqual(logs.map(x=>x.action),['login_session','session_blocked','logout']);
   assert.equal(logs[1].metadata.result,'denied');assert.ok(!JSON.stringify(logs).includes(h));
   }finally{await db.exec('ROLLBACK');}
  });
  await t.test('audit write failure rolls back business change and session issuance',async()=>{
   await db.exec(`CREATE FUNCTION audit.simulate_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'simulated_audit_failure';END$$;
    CREATE TRIGGER simulate_failure BEFORE INSERT ON audit.access_logs FOR EACH ROW EXECUTE FUNCTION audit.simulate_failure();`);
   try{
    await assert.rejects(q("INSERT INTO ticket_attachments(ticket_id,object_path,original_name) VALUES($1,'failed path','fixture')",[id(21)]),/simulated_audit_failure/);
    assert.equal((await q("SELECT count(*)::int AS n FROM ticket_attachments WHERE object_path='failed path'"))[0].n,0);
    await assert.rejects(q('DELETE FROM tickets WHERE id=$1',[id(21)]),/simulated_audit_failure/);
    assert.equal((await q('SELECT count(*)::int AS n FROM tickets WHERE id=$1',[id(21)]))[0].n,1);
    await assert.rejects(value('SELECT backend_activate_app_session_without_mfa($1,$2,NULL) AS result',[id(11),'fa'.repeat(32)]),/simulated_audit_failure/);
    assert.equal((await q("SELECT count(*)::int AS n FROM private.app_sessions WHERE session_token_hash=$1",['fa'.repeat(32)]))[0].n,0);
    await actor(11,()=>assert.rejects(q('SELECT read_ticket_detail_audited($1)',[id(21)]),/simulated_audit_failure/));
   }finally{await db.exec('DROP TRIGGER simulate_failure ON audit.access_logs');}
   assert.equal((await value('SELECT audit.verify_access_log_chain() AS result')).ok,true);
   assert.equal((await q("SELECT value FROM system_settings WHERE key='mfa_enabled'"))[0].value,'false');
  });
 }finally{await db.close();}
});
