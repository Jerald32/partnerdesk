import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const id=n=>`90000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('inactivity: PostgreSQL transitions, durable mail, exclusions and recovery',async t=>{
 const db=new PGlite(); const q=async(s,a=[]) => (await db.query(s,a)).rows;
 const val=async(s,a=[]) => (await q(s,a))[0].result;
 const migration=name=>readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
 try {
  await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
   CREATE SCHEMA auth;GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
   CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb DEFAULT '{}',encrypted_password text);
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated,service_role;`);
  for(const file of readdirSync(new URL('../supabase/migrations/',import.meta.url)).sort().filter(f=>f<'20261016000000')){
   if(file.startsWith('20261008000003')) {
    await q("INSERT INTO organizations(id,name,type) VALUES($1,'company','operator'),($2,'partner','partner')",[id(1),id(2)]);
    await q("INSERT INTO partner_details(organization_id,partner_type) VALUES($1,'other')",[id(2)]);
    await q("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'admin@example.invalid',clock_timestamp())",[id(14)]);
    await q("UPDATE profiles SET organization_id=$1,role='admin',account_status='active' WHERE auth_user_id=$2",[id(1),id(14)]);
    for(const n of [11,12,13,15,16,17,18]) await q('INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,clock_timestamp())',[id(n),`inactivity${n}@example.invalid`]);
   }
   let sql=migration(file);
   if(file==='20261006000015_add_user_role_management.sql') sql=sql.replace("CASE WHEN v_org.type = 'operator' THEN 'operator_company' ELSE 'partner' END THEN","(CASE WHEN v_org.type = 'operator' THEN 'operator_company' ELSE 'partner' END) THEN");
   await db.exec(sql);
  }
  for(const [n,days,org,role,exempt] of [[11,22,2,'operator',false],[12,23,2,'operator',false],[13,30,2,'admin',false],
   [14,90,1,'admin',false],[15,90,2,'operator',true],[16,90,2,'guest',false],[17,null,2,'operator',false],[18,90,1,'operator',false]]){
   await q('INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,clock_timestamp()) ON CONFLICT(id) DO NOTHING',[id(n),`inactivity${n}@example.invalid`]);
   await q("UPDATE profiles SET organization_id=$1,role=$2,account_status='active',inactive_check_exempt=$3,last_login_at=CASE WHEN $4::int IS NULL THEN NULL ELSE clock_timestamp()-make_interval(days=>$4::int) END WHERE auth_user_id=$5",[id(org),role,exempt,days,id(n)]);
  }
  const target=(await q('SELECT * FROM profiles WHERE auth_user_id=$1',[id(13)]))[0];
  await q(`INSERT INTO private.app_sessions(profile_id,auth_user_id,session_token_hash,authenticated_at,expires_at,last_activity_at)
   VALUES($1,$2,$3,clock_timestamp()-interval '31 days',clock_timestamp()+interval '1 day',clock_timestamp())`,[target.id,id(13),'ab'.repeat(32)]);
  await db.exec(migration('20261109000000_partner_inactivity_automation.sql'));
  await t.test('23/30-day transitions and exclusions; active sessions revoked; audit chain valid',async()=>{
   const r=await val('SELECT private.process_inactive_accounts() AS result');assert.equal(r.warned_count,1);assert.equal(r.suspended_count,1);
   for(const n of [11,14,15,16,17,18]) assert.equal((await q('SELECT account_status FROM profiles WHERE auth_user_id=$1',[id(n)]))[0].account_status,'active');
   assert.equal((await q('SELECT account_status FROM profiles WHERE auth_user_id=$1',[id(12)]))[0].account_status,'inactive_warning');
   assert.equal((await q('SELECT account_status FROM profiles WHERE auth_user_id=$1',[id(13)]))[0].account_status,'suspended');
   assert.ok((await q('SELECT revoked_at FROM private.app_sessions WHERE profile_id=$1',[target.id]))[0].revoked_at);
   assert.equal((await val('SELECT audit.verify_access_log_chain() AS result')).ok,true);
   const repeated=await val('SELECT private.process_inactive_accounts() AS result');assert.equal(repeated.warned_count+repeated.suspended_count,0);
   assert.equal((await q('SELECT * FROM private.inactivity_mail_queue')).length,2);
  });
  await t.test('expired leases retry, stale ack rejected, SMTP failures retained',async()=>{
   const claimed=await val('SELECT backend_claim_inactivity_mail() AS result');assert.equal(claimed.messages.length,2);
   assert.equal((await val('SELECT backend_claim_inactivity_mail() AS result')).messages.length,0);
   const warning=claimed.messages.find(x=>x.kind==='warning');
   assert.equal((await val('SELECT backend_finish_inactivity_mail($1,$2,false) AS result',[warning.id,warning.lease_id])).ok,true);
   assert.equal((await q('SELECT state FROM private.inactivity_mail_queue WHERE id=$1',[warning.id]))[0].state,'pending');
   const suspended=claimed.messages.find(x=>x.kind==='suspended');
   await q("UPDATE private.inactivity_mail_queue SET leased_until=clock_timestamp()-interval '1 second' WHERE id=$1",[suspended.id]);
   const retry=(await val('SELECT backend_claim_inactivity_mail() AS result')).messages[0];
   assert.equal(retry.id,suspended.id);assert.notEqual(retry.lease_id,suspended.lease_id);
   assert.equal((await val('SELECT backend_finish_inactivity_mail($1,$2,true) AS result',[suspended.id,suspended.lease_id])).ok,false);
   assert.equal((await val('SELECT backend_finish_inactivity_mail($1,$2,true) AS result',[retry.id,retry.lease_id])).ok,true);
  });
  await t.test('real login clears warning and cancels stale notice; blocked MFA rejected',async()=>{
   const p=(await q('SELECT * FROM profiles WHERE auth_user_id=$1',[id(12)]))[0];
   await q("SELECT private.insert_app_auth_session(p,$2,NULL,true) FROM profiles p WHERE auth_user_id=$1",[id(12),'bc'.repeat(32)]);
   const after=(await q('SELECT * FROM profiles WHERE auth_user_id=$1',[id(12)]))[0];assert.equal(after.account_status,'active');assert.ok(new Date(after.last_login_at)>new Date(p.last_login_at));
   assert.equal((await q("SELECT state FROM private.inactivity_mail_queue WHERE profile_id=$1 AND kind='warning'",[p.id]))[0].state,'cancelled');
   assert.equal((await val('SELECT backend_verify_mfa_and_create_app_session($1,$2,$3,$4,NULL) AS result',[id(13),id(99),'invalid','cd'.repeat(32)])).ok,false);
  });
  await t.test('recovery retains login history, cancels notices and grants grace without immediate relock',async()=>{
   const before=(await q('SELECT last_login_at FROM profiles WHERE id=$1',[target.id]))[0];
   await q("UPDATE profiles SET account_status='active' WHERE id=$1",[target.id]);
   const after=(await q('SELECT * FROM profiles WHERE id=$1',[target.id]))[0];assert.deepEqual(after.last_login_at,before.last_login_at);assert.ok(after.inactivity_reactivated_at);
   await val('SELECT private.process_inactive_accounts() AS result');
   assert.equal((await q('SELECT account_status FROM profiles WHERE id=$1',[target.id]))[0].account_status,'active');
  });
  await t.test('public/browser roles cannot process accounts or read/ack email queue',async()=>{
   for(const role of ['anon','authenticated']){
    for(const sql of ['SELECT private.process_inactive_accounts()','SELECT backend_claim_inactivity_mail()',"SELECT backend_finish_inactivity_mail(gen_random_uuid(),gen_random_uuid(),true)",'SELECT * FROM private.inactivity_mail_queue']){
     await db.exec('BEGIN');try{await db.exec('SET LOCAL ROLE '+role);await assert.rejects(db.exec(sql),/permission denied/);}finally{await db.exec('ROLLBACK');}
    }
   }
  });
  await t.test('audit failure rolls back state, session revocation and notice enqueue together',async()=>{
   await q("UPDATE profiles SET last_login_at=clock_timestamp()-interval '31 days',inactivity_reactivated_at=NULL WHERE auth_user_id=$1",[id(11)]);
   await db.exec(`CREATE FUNCTION audit.fail_inactivity() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'audit_failure';END$$;
    CREATE TRIGGER fail_inactivity BEFORE INSERT ON audit.access_logs FOR EACH ROW EXECUTE FUNCTION audit.fail_inactivity();`);
   try {await assert.rejects(q('SELECT private.process_inactive_accounts()'),/audit_failure/);}
   finally {await db.exec('DROP TRIGGER fail_inactivity ON audit.access_logs');}
   assert.equal((await q('SELECT account_status FROM profiles WHERE auth_user_id=$1',[id(11)]))[0].account_status,'active');
   assert.equal((await q('SELECT count(*)::int AS n FROM private.inactivity_mail_queue WHERE profile_id=(SELECT id FROM profiles WHERE auth_user_id=$1)',[id(11)]))[0].n,0);
  });
 }finally{await db.close();}
});
