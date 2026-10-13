import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const id=n=>`40000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const raw=n=>n.toString(16).padStart(64,'0');
test('lifecycle: retention review and dormant account authorization preserve data',async t=>{
 const db=new PGlite();const q=async(s,a=[]) => (await db.query(s,a)).rows;
 const val=async(s,a=[]) => (await q(s,a))[0].result;
 async function actor(n,fn,withToken=true){await db.exec('BEGIN');try{
  await q("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.headers',$2,true),set_config('request.method','POST',true)",
   [id(n),JSON.stringify(withToken?{'x-partnerdesk-session':raw(n)}:{})]);
  await db.exec('SET LOCAL ROLE authenticated');return await fn();
 }finally{await db.exec('ROLLBACK');}}
 try{
  await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
   CREATE SCHEMA auth;GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
   CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb DEFAULT '{}',encrypted_password text);
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated,service_role;`);
  const files=readdirSync(new URL('../supabase/migrations/',import.meta.url)).sort();
  for(const file of files.filter(f=>f<'20261008000003')){
   let sql=readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');
   if(file==='20261006000015_add_user_role_management.sql')sql=sql.replace("CASE WHEN v_org.type = 'operator' THEN 'operator_company' ELSE 'partner' END THEN","(CASE WHEN v_org.type = 'operator' THEN 'operator_company' ELSE 'partner' END) THEN");
   await db.exec(sql);
  }
  await q("INSERT INTO organizations(id,name,type) VALUES($1,'fixture company','operator'),($2,'fixture partner','partner')",[id(1),id(2)]);
  await q("INSERT INTO partner_details(organization_id,partner_type) VALUES($1,'other')",[id(2)]);
  for(const [n,org,role] of [[11,1,'admin'],[12,1,'operator'],[13,2,'guest']]){
   await q('INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,clock_timestamp())',[id(n),`lifecycle${n}@example.invalid`]);
   await q("UPDATE profiles SET organization_id=$1,role=$2,account_status='active',created_at=clock_timestamp()-interval '400 days',last_login_at=NULL WHERE auth_user_id=$3",[id(org),role,id(n)]);
   await q(`INSERT INTO private.app_sessions(profile_id,auth_user_id,session_token_hash,authenticated_at,expires_at,last_activity_at)
    SELECT id,auth_user_id,encode(sha256(decode($2,'hex')),'hex'),clock_timestamp(),clock_timestamp()+interval '8 hours',clock_timestamp() FROM profiles WHERE auth_user_id=$1`,[id(n),raw(n)]);
  }
  for(const file of files.filter(f=>f>='20261008000003'&&f<'20261015000000'))await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  await q("INSERT INTO system_settings(key,value) VALUES('mfa_enabled','false')");
  await q("INSERT INTO businesses(id,name) VALUES($1,'fixture')",[id(20)]);
  for(const [n,status] of [[21,'new'],[22,'inprogress'],[23,'hold'],[24,'done']])
   await q("INSERT INTO tickets(id,business_id,title,status,created_at,resolved_at) VALUES($1,$2,'fixture',$3,clock_timestamp()-interval '4 years',CASE WHEN $3='done' THEN clock_timestamp() ELSE NULL END)",[id(n),id(20),status]);
  await q("INSERT INTO tickets(id,business_id,title,created_at) VALUES($1,$2,'fresh',clock_timestamp()-interval '2 years')",[id(25),id(20)]);
  await q("INSERT INTO ticket_attachments(ticket_id,object_path,original_name) VALUES($1,'fixture','fixture')",[id(21)]);
  await q("INSERT INTO activities(ticket_id,type,content) VALUES($1,'comment','fixture')",[id(21)]);
  const before=await q('SELECT * FROM tickets ORDER BY id');
  // Production Data API SELECT grants are supplied by the platform defaults.
  await db.exec('GRANT SELECT ON public.tickets,public.profiles TO authenticated');
  await db.exec(readFileSync(new URL('../supabase/migrations/20261015000000_lifecycle_review_only.sql',import.meta.url),'utf8'));
  await t.test('migration preserves records; all four statuses are due by created_at, never resolved_at',async()=>{
   assert.deepEqual(await q('SELECT * FROM tickets ORDER BY id'),before);
   await actor(11,async()=>{const r=await val("SELECT read_lifecycle_review('tickets',0) AS result");
    assert.deepEqual(r.rows.map(x=>x.status),['new','inprogress','hold','done']);
    assert.equal(r.rows[0].attachment_count,1);assert.equal(r.rows[0].activity_count,1);
    assert.equal(r.automatic_disposal_enabled,false);});
  });
  await t.test('old processing RPC is inert; actual Ticket/activity/attachment deletion denied',async()=>{
   assert.equal((await val('SELECT backend_process_ticket_retention(100) AS result')).processed_count,0);
   assert.deepEqual(await q('SELECT * FROM tickets ORDER BY id'),before);
   for(const table of ['tickets','activities','ticket_attachments'])await assert.rejects(q(`DELETE FROM ${table}`),/ticket_disposal_not_enabled/);
   for(const table of ['tickets','activities','ticket_attachments'])await assert.rejects(db.exec(`TRUNCATE ${table} CASCADE`),/ticket_disposal_not_enabled/);
   await assert.rejects(q("UPDATE tickets SET retention_state='anonymized' WHERE id=$1",[id(21)]),/ticket_disposal_not_enabled/);
   await assert.rejects(q('UPDATE tickets SET retention_processed_at=clock_timestamp() WHERE id=$1',[id(21)]),/ticket_disposal_not_enabled/);
  });
  await t.test('manual review is audited, optimistic and preserves dates/content; fresh tickets not eligible',async()=>{
   await actor(11,async()=>{const r=await val("SELECT review_ticket_retention($1,'request_disposal_review',1) AS result",[id(21)]);
    assert.equal(r.retention_state,'disposal_review');
    const after=(await q('SELECT * FROM tickets WHERE id=$1',[id(21)]))[0];
    for(const field of ['created_at','resolved_at','description','title','retention_processed_at'])assert.deepEqual(after[field],before[0][field]);
    const a=await val("SELECT search_admin_access_audit('ticket_retention_review',0) AS result");assert.equal(a.rows[0].metadata.disposal_executed,false);
   });
   await actor(11,()=>assert.rejects(q("SELECT review_ticket_retention($1,'retain',99)",[id(21)]),/stale_ticket_version/));
   await actor(11,()=>assert.rejects(q("SELECT review_ticket_retention($1,'retain',1)",[id(25)]),/ticket_not_review_eligible/));
  });
  await t.test('only Company Admin with a business session may review or configure policy',async()=>{
   for(const n of [12,13])await actor(n,()=>assert.rejects(q("SELECT read_lifecycle_review('accounts',0)"),/company_role_required/));
   await actor(11,()=>assert.rejects(q("SELECT read_lifecycle_review('tickets',0)"),/app_session_required/),false);
   await actor(12,()=>assert.rejects(q('SELECT set_dormancy_review_days(30)'),/role_not_allowed/));
  });
  await t.test('unset criterion never locks; genuine session issuance supplies last login and admin exemption',async()=>{
   await actor(11,async()=>{const r=await val("SELECT read_lifecycle_review('accounts',0) AS result");
    assert.equal(r.dormancy_review_days,null);assert.equal(r.automatic_lock_enabled,false);
    const admin=r.rows.find(p=>p.role==='admin');assert.equal(admin.automatic_lock_exempt,true);assert.ok(admin.last_login_at);
    assert.equal(admin.review_candidate,null);
    await val('SELECT set_dormancy_review_days(90) AS result');
    const next=await val("SELECT read_lifecycle_review('accounts',0) AS result");assert.equal(next.dormancy_review_days,90);assert.equal(next.automatic_lock_enabled,false);
   });
   await q('UPDATE private.app_sessions SET authenticated_at=clock_timestamp()-interval \'200 days\' WHERE auth_user_id=$1',[id(12)]);
   await actor(11,async()=>{await val('SELECT set_dormancy_review_days(90) AS result');const r=await val("SELECT read_lifecycle_review('accounts',0) AS result");
    assert.equal(r.rows.find(p=>p.role==='operator').review_candidate,true);});
  });
  await t.test('manual deactivate/reactivate keeps Ticket/activity/audit and preserves organization and role',async()=>{
   const target=(await q('SELECT * FROM profiles WHERE auth_user_id=$1',[id(12)]))[0];
   await actor(11,async()=>{
    await val('SELECT deactivate_profile($1) AS result',[target.id]);
    const r=await val('SELECT reactivate_profile($1) AS result',[target.id]);assert.equal(r.account_status,'active');
    const p=(await q('SELECT * FROM profiles WHERE id=$1',[target.id]))[0];assert.equal(p.role,target.role);assert.equal(p.organization_id,target.organization_id);
    assert.equal((await q('SELECT count(*)::int AS n FROM tickets'))[0].n,5);
   });
   const admin=(await q('SELECT id FROM profiles WHERE auth_user_id=$1',[id(11)]))[0];
   await actor(11,()=>assert.rejects(q('SELECT deactivate_profile($1)',[admin.id]),/self_deactivation_not_allowed/));
  });
  await t.test('audit failure rolls back retention decisions, configuration and account state',async()=>{
   await db.exec(`CREATE FUNCTION audit.fail_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'audit_failure';END$$;
    CREATE TRIGGER fail_lifecycle BEFORE INSERT ON audit.access_logs FOR EACH ROW EXECUTE FUNCTION audit.fail_lifecycle();`);
   try{
    await actor(11,()=>assert.rejects(q("SELECT review_ticket_retention($1,'retain',1)",[id(21)]),/audit_failure/));
    await actor(11,()=>assert.rejects(q('SELECT set_dormancy_review_days(90)'),/audit_failure/));
    const target=(await q('SELECT id FROM profiles WHERE auth_user_id=$1',[id(12)]))[0];
    await actor(11,()=>assert.rejects(q('SELECT deactivate_profile($1)',[target.id]),/audit_failure/));
   }finally{await db.exec('DROP TRIGGER fail_lifecycle ON audit.access_logs');}
   assert.deepEqual(await q('SELECT * FROM tickets ORDER BY id'),before);
   assert.equal((await q("SELECT value FROM system_settings WHERE key='dormancy_review_days'"))[0].value,'');
   assert.equal((await val('SELECT audit.verify_access_log_chain() AS result')).ok,true);
  });
 }finally{await db.close();}
});
