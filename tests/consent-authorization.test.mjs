import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// Local PostgreSQL/RLS only. No network, real credentials, Auth changes or remote SQL.
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const token = n => n.toString(16).padStart(64, '0');
const company=id(1),bp=id(2),sp=id(3),other=id(4),a=id(11),b=id(12),ta=id(21),tb=id(22),tc=id(23);
const actors=[{n:101,org:company,role:'admin'},{n:102,org:company,role:'operator'},
  {n:103,org:bp,role:'admin'},{n:104,org:bp,role:'operator'},
  {n:105,org:sp,role:'admin'},{n:106,org:sp,role:'operator'},
  {n:107,org:bp,role:'guest'},{n:108,org:other,role:'admin'}];

test('consent migration: real local PostgreSQL RLS, RPC and Auth trigger', async t => {
  const db=new PGlite();
  const q=async(sql,args=[]) => (await db.query(sql,args)).rows;
  async function as(n,fn,{withToken=true}={}) {
    await db.exec('BEGIN');
    try {
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.headers',$2,true),set_config('request.method','POST',true)",
        [id(n+1000),JSON.stringify(withToken?{'x-partnerdesk-session':token(n)}:{})]);
      await db.exec('SET LOCAL ROLE authenticated');
      return await fn();
    } finally { await db.exec('ROLLBACK'); }
  }
  const value=async(sql,args=[]) => (await q(sql,args))[0].result;
  const deny=async(n,sql,args=[],pattern=/forbidden|consent|role_not_allowed|company_role_required/) =>
    as(n,()=>assert.rejects(db.query(sql,args),pattern));
  // Match the policy's explicit UTC timezone, including near local midnight.
  const legacy=async(n,org=actors.find(p=>p.n===n).org) => q(`WITH fixture AS (SELECT clock_timestamp()-interval '1 day' AS signed_at)
    INSERT INTO privacy_consents(profile_id,organization_id,consent_type,pledge_version,consent_date,valid_until)
    SELECT $1,$2,'privacy_pledge','v1.0',signed_at,((signed_at AT TIME ZONE 'UTC')+interval '1 year')::date FROM fixture RETURNING id`,[id(n),org]);
  try {
    await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
      CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,raw_user_meta_data jsonb DEFAULT '{}',encrypted_password text);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated,service_role;`);
    const files=readdirSync(new URL('../supabase/migrations/',import.meta.url)).sort();
    for(const file of files.filter(f=>f<'20261008000003')) {
      let sql=readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');
      // Match the already inspected historical production baseline, in memory only.
      if(file==='20261006000015_add_user_role_management.sql')sql=sql.replace(
        "CASE WHEN v_org.type = 'operator' THEN 'operator_company' ELSE 'partner' END THEN",
        "(CASE WHEN v_org.type = 'operator' THEN 'operator_company' ELSE 'partner' END) THEN");
      await db.exec(sql);
    }
    for(const [org,type] of [[company,'operator'],[bp,'partner'],[sp,'partner'],[other,'partner']]){
      await q('INSERT INTO organizations(id,name,type) VALUES($1,$2,$3)',[org,'fixture '+org,type]);
      if(type==='partner')await q("INSERT INTO partner_details(organization_id,partner_type) VALUES($1,'other')",[org]);
    }
    for(const p of actors){
      await q('INSERT INTO auth.users(id,email) VALUES($1,$2)',[id(p.n+1000),`fixture${p.n}@example.invalid`]);
      await q("UPDATE profiles SET id=$1,organization_id=$2,role=$3,account_status='active' WHERE auth_user_id=$4",[id(p.n),p.org,p.role==='admin'&&p.org!==company?'partner_admin':p.role,id(p.n+1000)]);
      await q(`INSERT INTO private.app_sessions(profile_id,auth_user_id,session_token_hash,authenticated_at,expires_at,last_activity_at)
        VALUES($1,$2,encode(sha256(decode($3,'hex')),'hex'),clock_timestamp()-interval '1 second',clock_timestamp()+interval '8 hours',clock_timestamp()-interval '1 second')`,[id(p.n),id(p.n+1000),token(p.n)]);
    }
    for(const business of [a,b])await q('INSERT INTO businesses(id,name) VALUES($1,$2)',[business,'fixture '+business]);
    for(const [business,partner,level] of [[a,bp,'business'],[a,sp,'service'],[b,other,'business']])
      await q('INSERT INTO service_partners(business_id,partner_organization_id,access_level) VALUES($1,$2,$3)',[business,partner,level]);
    for(const [tid,business,partner] of [[ta,a,sp],[tb,b,other],[tc,a,null]]){
      await q("INSERT INTO tickets(id,business_id,assigned_partner_organization_id,title) VALUES($1,$2,$3,'fixture')",[tid,business,partner]);
      await q("INSERT INTO activities(ticket_id,content) VALUES($1,'fixture')",[tid]);
      await q("INSERT INTO ticket_attachments(ticket_id,object_path,original_name) VALUES($1,$2,'fixture')",[tid,tid]);
      for(const actor of actors)await q("INSERT INTO notifications(ticket_id,recipient_profile_id,message) VALUES($1,$2,'fixture')",[tid,id(actor.n)]);
    }
    await legacy(108);
    await db.exec(readFileSync(new URL('../supabase/migrations/20261008000003_separate_organization_roles.sql',import.meta.url),'utf8'));
    const original={};for(const table of ['profiles','organizations','businesses','tickets','private.app_sessions'])original[table]=await q(`SELECT * FROM ${table} ORDER BY id`);
    const oldReceipts=await q('SELECT id,profile_id,organization_id,consent_type,pledge_version,consent_date,valid_until FROM privacy_consents ORDER BY id');
    await db.exec(readFileSync(new URL('../supabase/migrations/20261012000000_enforce_partner_consent.sql',import.meta.url),'utf8'));
    await db.exec('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO authenticated;');
    const policy=(await q("SELECT * FROM consent_policy_versions WHERE kind='privacy_pledge' AND version='v1.0'"))[0];
    const record=()=>value("SELECT record_policy_consent('privacy_pledge','v1.0',$1,true) AS result",[policy.text_hash]);

    await t.test('migration preserves profiles, memberships, tickets, sessions and historical receipts',async()=>{
      for(const table of Object.keys(original))assert.deepEqual(await q(`SELECT * FROM ${table} ORDER BY id`),original[table]);
      assert.deepEqual(await q('SELECT id,profile_id,organization_id,consent_type,pledge_version,consent_date,valid_until FROM privacy_consents ORDER BY id'),oldReceipts);
    });
    await t.test('original pledge and three required signup documents are active, exact and anonymously readable',async()=>{
      const old=readFileSync(new URL('../src/pages/PrivacyConsent.jsx',import.meta.url),'utf8');
      assert.ok(!old.includes('const PLEDGE_TEXT'));
      assert.equal(policy.text_hash,'ede2ccc4852891da8683dc544640f9ada6ec9f3ac91226b5d82b530b8a0171b1');
      const signup=await q("SELECT * FROM consent_policy_versions WHERE kind<>'privacy_pledge' AND enabled AND required");assert.equal(signup.length,3);assert.ok(signup.every(d=>d.required_for_profiles_created_at_or_after));
      const originalRegister=readFileSync(new URL('../legacy/base44/src/pages/Register.jsx',import.meta.url),'utf8');for(const d of signup){assert.ok(originalRegister.includes(d.document_text));assert.ok(originalRegister.includes('[\uD544\uC218] '+d.title));}
      await db.exec('BEGIN; SET LOCAL ROLE anon;');
      try { assert.equal((await value('SELECT list_signup_consent_policies() AS result')).length,3);assert.equal((await q('SELECT * FROM consent_policy_versions')).length,3); }
      finally { await db.exec('ROLLBACK'); }
    });
    for(const n of [103,104,105,106])await t.test(`unconsented Partner ${n}: all business tables/direct ID/aggregate hidden`,()=>as(n,async()=>{
      assert.equal(await value('SELECT has_required_privacy_consent() AS result'),false);
      for(const table of ['tickets','businesses','service_partners','activities','ticket_attachments','notifications','partner_details'])assert.equal((await q(`SELECT * FROM ${table}`)).length,0,table);
      assert.equal((await q('SELECT id FROM tickets WHERE id=$1',[ta])).length,0);
      assert.equal(Number((await q('SELECT count(*) AS count FROM tickets'))[0].count),0);
      assert.equal((await q('SELECT * FROM profiles')).length,1);
      assert.equal((await q('SELECT * FROM organizations')).length,1);
    }));
    for(const n of [103,104,105,106])await t.test(`unconsented Partner ${n}: mutation RPCs blocked`,async()=>{
      for(const [sql,args] of [["SELECT change_ticket_status($1,'hold',1)",[ta]],
        ["SELECT add_ticket_activity($1,'comment','denied')",[ta]],
        ["SELECT update_ticket_address($1,'denied',NULL,1)",[ta]],
        ['SELECT change_ticket_operator($1,true,1)',[ta]],['SELECT change_ticket_assignment($1,NULL,1)',[ta]],
        ["SELECT create_ticket($1,'denied')",[a]],['SELECT mark_notifications_read(NULL)',[]]])await deny(n,sql,args);
    });
    await t.test('unconsented Partner can read requirements and update own account without idle polling touch',async()=>{
      const before=await q('SELECT last_activity_at FROM private.app_sessions WHERE profile_id=$1',[id(104)]);
      await as(104,async()=>{
        const status=await value('SELECT get_my_consent_requirements() AS result');
        assert.equal(status.valid,false);assert.equal(status.requirements[0].reason,'consent_required');
      });
      assert.deepEqual(await q('SELECT last_activity_at FROM private.app_sessions WHERE profile_id=$1',[id(104)]),before);
      await as(104,async()=>assert.equal((await value("SELECT update_my_profile('Name','Display',NULL) AS result")).id,id(104)));
      await as(104,async()=>assert.equal((await value("SELECT submit_role_request('operator',$1,'request',true) AS result",[bp])).status,'pending'));
    });
    await t.test('new evidence records caller, immutable document/version/hash and server time',()=>as(104,async()=>{
      const receipt=await record();
      const row=(await q('SELECT * FROM privacy_consents WHERE id=$1',[receipt.id]))[0];
      assert.equal(row.profile_id,id(104));assert.equal(row.auth_user_id_snapshot,id(1104));assert.equal(row.organization_id,bp);
      assert.equal(row.policy_text_snapshot,policy.document_text);assert.equal(row.policy_text_hash,policy.text_hash);
      assert.equal(row.source,'authenticated_rpc');assert.equal(row.withdrawn_at,null);
      assert.equal(await value('SELECT has_required_privacy_consent() AS result'),true);
      assert.deepEqual((await q('SELECT id FROM tickets ORDER BY id')).map(r=>r.id),[ta,tc]);
      assert.equal((await value("SELECT change_ticket_status($1,'hold',1) AS result",[ta])).version,2);
    }));
    await t.test('legacy valid typed v1 receipt stays valid without fabricated text hash',()=>as(108,async()=>{
      assert.equal(await value('SELECT has_required_privacy_consent() AS result'),true);
      assert.deepEqual((await q('SELECT id FROM tickets ORDER BY id')).map(r=>r.id),[tb]);
      assert.equal((await q('SELECT policy_text_hash FROM privacy_consents'))[0].policy_text_hash,null);
    }));
    for(const n of [103,104,105,106])await t.test(`consented Partner ${n}: original BP/SP scope remains unchanged`,()=>as(n,async()=>{
      await record();
      assert.deepEqual((await q('SELECT id FROM tickets ORDER BY id')).map(r=>r.id),n<105?[ta,tc]:[ta]);
      assert.equal((await q('SELECT id FROM tickets WHERE id=$1',[tb])).length,0);
    }));
    await t.test('withdrawal immediately denies mutation RPC despite the same still-valid app session',async()=>{
      await as(104,async()=>{
        const receipt=await record();await value('SELECT withdraw_policy_consent($1) AS result',[receipt.id]);
        await assert.rejects(db.query("SELECT change_ticket_status($1,'hold',1)",[ta]),/forbidden/);
      });
    });
    await t.test('unconsented Partner Admin cannot edit its organization business details',async()=>{
      await deny(103,"SELECT update_partner($1,'changed','other')",[bp]);
      await deny(103,"SELECT change_profile_role_organization($1,'admin',$2)",[id(104),bp]);
      await deny(103,'SELECT deactivate_profile($1)',[id(104)]);
    });
    await t.test('withdrawal denies the next read/write, preserves evidence, and reconsent restores scope',()=>as(104,async()=>{
      const first=await record();const second=await record();
      await value('SELECT withdraw_policy_consent($1) AS result',[second.id]);
      assert.equal(await value('SELECT has_required_privacy_consent() AS result'),false);
      assert.equal((await q('SELECT * FROM tickets')).length,0);
      const originalRow=(await q('SELECT * FROM privacy_consents WHERE id=$1',[second.id]))[0];
      assert.equal(originalRow.policy_text_hash,policy.text_hash);assert.ok(originalRow.withdrawn_at);
      assert.ok(first.id!==second.id); // No fallback to the older valid receipt.
      await record();assert.equal(await value('SELECT has_required_privacy_consent() AS result'),true);
    }));
    await t.test('false, old endpoint, forged document and other-person withdrawal rejected',async()=>{
      await deny(104,"SELECT record_policy_consent('privacy_pledge','v1.0',$1,false)",[policy.text_hash],/explicit_consent/);
      await deny(104,"SELECT record_policy_consent('privacy_pledge','v1.0','forged',true)",[],/consent_policy_changed/);
      await deny(104,'SELECT record_privacy_consent(true)',[],/consent_document_required/);
      await deny(104,'SELECT withdraw_policy_consent($1)',[oldReceipts[0].id],/forbidden/);
    });
    await t.test('expired, future-dated, wrong organization and untyped legacy records never grant access',async()=>{
      for(const variant of ['expired','future','wrong_org','untyped']){
        await db.exec('BEGIN');
        try{
          const date=variant==='expired'?"clock_timestamp()-interval '2 years'":variant==='future'?"clock_timestamp()+interval '1 day'":"clock_timestamp()-interval '1 day'";
          await q(`INSERT INTO privacy_consents(profile_id,organization_id,consent_type,pledge_version,consent_date,valid_until)
            VALUES($1,$2,$3,'v1.0',${date},(${date}+interval '1 year')::date)`,[id(104),variant==='wrong_org'?sp:bp,variant==='untyped'?null:'privacy_pledge']);
          await q("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.headers',$2,true)",[id(1104),JSON.stringify({'x-partnerdesk-session':token(104)})]);
          await db.exec('SET LOCAL ROLE authenticated');assert.equal(await value('SELECT has_required_privacy_consent() AS result'),false,variant);
        } finally{await db.exec('ROLLBACK');}
      }
    });
    await t.test('policy version changes block Partner, preserve Company access, stale submissions fail',async()=>{
      await db.exec('BEGIN');
      try{
        await q("INSERT INTO consent_policy_versions(kind,version,title,document_text,text_hash) VALUES('privacy_pledge','v2','fixture','new fixture','')");
        await q("UPDATE consent_policy_versions SET enabled=false WHERE kind='privacy_pledge' AND version='v1.0'");
        await q("UPDATE consent_policy_versions SET enabled=true,required=true WHERE kind='privacy_pledge' AND version='v2'");
        await q("UPDATE system_settings SET value='v2' WHERE key='privacy_pledge_version'");
        await q("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.headers',$2,true),set_config('request.method','POST',true)",[id(1108),JSON.stringify({'x-partnerdesk-session':token(108)})]);
        await db.exec('SET LOCAL ROLE authenticated');assert.equal(await value('SELECT has_required_privacy_consent() AS result'),false);
        await q("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.headers',$2,true)",[id(1101),JSON.stringify({'x-partnerdesk-session':token(101)})]);
        assert.equal(await value('SELECT has_required_privacy_consent() AS result'),true);
        assert.equal((await q('SELECT * FROM tickets')).length,3);
        await q("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.headers',$2,true)",[id(1108),JSON.stringify({'x-partnerdesk-session':token(108)})]);
        await assert.rejects(record(),/consent_policy_changed/);
      } finally{await db.exec('ROLLBACK');}
      for(const n of [101,102])await as(n,async()=>{assert.equal(await value('SELECT has_required_privacy_consent() AS result'),true);assert.equal((await q('SELECT * FROM tickets')).length,3);});
    });
    await t.test('missing policy document fails closed for Partner; policy bodies cannot be edited',async()=>{
      await db.exec('BEGIN');try{await q("UPDATE system_settings SET value='missing' WHERE key='privacy_pledge_version'");
        await q("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.headers',$2,true)",[id(1108),JSON.stringify({'x-partnerdesk-session':token(108)})]);
        await db.exec('SET LOCAL ROLE authenticated');assert.equal(await value('SELECT has_required_privacy_consent() AS result'),false);
      }finally{await db.exec('ROLLBACK');}
      await assert.rejects(q("UPDATE consent_policy_versions SET document_text='changed' WHERE kind='privacy_pledge'"),/immutable/);
    });
    await t.test('Company Admin/Operator need no receipt, Guest needs no invented pledge and has no business scope',async()=>{
      for(const n of [101,102])await as(n,async()=>assert.equal((await q('SELECT * FROM tickets')).length,3));
      await as(107,async()=>{assert.equal((await value('SELECT get_my_consent_requirements() AS result')).valid,true);assert.equal((await q('SELECT * FROM tickets')).length,0);});
    });
    await t.test('without an app token neither evidence nor business API is available',async()=>{
      await as(108,async()=>assert.equal((await q('SELECT * FROM tickets')).length,0),{withToken:false});
      await as(104,()=>assert.rejects(record(),/app_session/),{withToken:false});
    });
    await t.test('direct receipt insertion/update and policy edits denied even with broad DML grants',async()=>{
      await deny(104,"INSERT INTO privacy_consents(profile_id,consent_date,valid_until) VALUES($1,now(),CURRENT_DATE)",[id(104)],/row-level security/);
      await as(108,async()=>{assert.equal((await q("UPDATE privacy_consents SET policy_text_hash='forged' RETURNING id")).length,0);assert.equal((await q('DELETE FROM privacy_consents RETURNING id')).length,0);});
    });
    await t.test('approved signup policy rejects direct Auth creation without exact acknowledgement and records server evidence',async()=>{
      await db.exec('BEGIN');
      try{
        await q("UPDATE consent_policy_versions SET enabled=true,required=true,required_for_profiles_created_at_or_after=NULL WHERE kind='signup_privacy'");
        const doc=(await q("SELECT * FROM consent_policy_versions WHERE kind='signup_privacy'"))[0];
        await db.exec('SAVEPOINT invalid_signup');
        await assert.rejects(q('INSERT INTO auth.users(id,email) VALUES($1,$2)',[id(2001),'missing@example.invalid']),/signup_consent_required/);
        await db.exec('ROLLBACK TO SAVEPOINT invalid_signup');
        assert.equal((await q('SELECT * FROM auth.users WHERE id=$1',[id(2001)])).length,0);
        await q('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)',[id(2002),'new@example.invalid',JSON.stringify({role:'admin',organization_id:company,signup_consents:(await q("SELECT kind,version,text_hash,true AS agreed FROM consent_policy_versions WHERE kind<>'privacy_pledge'"))})]);
        const p=(await q('SELECT * FROM profiles WHERE auth_user_id=$1',[id(2002)]))[0];assert.equal(p.role,'guest');
        assert.equal((await q('SELECT id FROM privacy_consents WHERE profile_id=$1',[p.id])).length,3);
        const all=await q("SELECT kind,version,text_hash,true AS agreed FROM consent_policy_versions WHERE kind<>'privacy_pledge'");
        for(let i=0;i<3;i++){await db.exec('SAVEPOINT missing_one');await assert.rejects(q('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)',[id(2100+i),'missing'+i+'@example.invalid',JSON.stringify({signup_consents:all.filter((_,j)=>i!==j)})]),/signup_consent_required/);await db.exec('ROLLBACK TO SAVEPOINT missing_one');}

        const receipt=(await q("SELECT * FROM privacy_consents WHERE profile_id=$1 AND consent_type='signup_privacy'",[p.id]))[0];
        assert.equal(receipt.source,'auth_signup');assert.equal(receipt.policy_text_snapshot,doc.document_text);assert.equal(receipt.auth_user_id_snapshot,id(2002));
        assert.equal(receipt.valid_until,null); // Do not invent a signup-consent expiry.
      }finally{await db.exec('ROLLBACK');}
    });
    await t.test('signup direct API rejects stale hash, non-boolean acceptance and duplicate entries',async()=>{
      await db.exec('BEGIN');try{
        await q("UPDATE consent_policy_versions SET enabled=true,required=true,required_for_profiles_created_at_or_after=NULL WHERE kind='signup_privacy'");
        const doc=(await q("SELECT * FROM consent_policy_versions WHERE kind='signup_privacy'"))[0];
        const entry={kind:doc.kind,version:doc.version,text_hash:doc.text_hash,agreed:true};
        const others=await q("SELECT kind,version,text_hash,true AS agreed FROM consent_policy_versions WHERE kind IN ('signup_delegation','signup_one_account')");
        for(const [entries,pattern] of [[[{...entry,text_hash:'wrong'}],/consent_policy_changed/],
          [[{...entry,agreed:'true'}],/signup_consent_required/],[[entry,entry],/invalid_signup_consents/]]){
          await db.exec('SAVEPOINT bad_signup');
          await assert.rejects(q('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)',[id(2003),'bad@example.invalid',JSON.stringify({signup_consents:[...entries,...others]})]),pattern);
          await db.exec('ROLLBACK TO SAVEPOINT bad_signup');
          assert.equal((await q('SELECT * FROM auth.users WHERE id=$1',[id(2003)])).length,0);
        }
      }finally{await db.exec('ROLLBACK');}
    });
    await t.test('required signup receipt withdrawal blocks a Partner even when its annual pledge is valid',async()=>{
      await db.exec('BEGIN');try{
        await q("UPDATE consent_policy_versions SET enabled=true,required=true,required_for_profiles_created_at_or_after=NULL WHERE kind='signup_privacy'");
        const doc=(await q("SELECT * FROM consent_policy_versions WHERE kind='signup_privacy'"))[0];
        await q("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.headers',$2,true),set_config('request.method','POST',true)",[id(1108),JSON.stringify({'x-partnerdesk-session':token(108)})]);
        await db.exec('SET LOCAL ROLE authenticated');assert.equal(await value('SELECT has_required_privacy_consent() AS result'),false);
        const receipt=await value('SELECT record_policy_consent($1,$2,$3,true) AS result',[doc.kind,doc.version,doc.text_hash]);
        assert.equal(await value('SELECT has_required_privacy_consent() AS result'),true);
        await value('SELECT withdraw_policy_consent($1) AS result',[receipt.id]);assert.equal(await value('SELECT has_required_privacy_consent() AS result'),false);
        assert.equal((await q('SELECT * FROM tickets')).length,0);
      }finally{await db.exec('ROLLBACK');}
    });
    await t.test('restrictive consent gate cannot be ORed around by a permissive read policy',async()=>{
      await db.exec('CREATE POLICY simulated_unreviewed_read ON tickets FOR SELECT TO authenticated USING(true)');
      try{await as(104,async()=>assert.equal((await q('SELECT * FROM tickets')).length,0));}
      finally{await db.exec('DROP POLICY simulated_unreviewed_read ON tickets');}
    });
    await t.test('new-only signup rollout exempts pre-cutoff profiles without inventing receipts',async()=>{
      await db.exec('BEGIN');try{
        await q("UPDATE consent_policy_versions SET enabled=true,required=true,required_for_profiles_created_at_or_after=clock_timestamp()+interval '1 day' WHERE kind='signup_privacy'");
        await q("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.headers',$2,true)",[id(1108),JSON.stringify({'x-partnerdesk-session':token(108)})]);
        await db.exec('SET LOCAL ROLE authenticated');assert.equal(await value('SELECT has_required_privacy_consent() AS result'),true);
      }finally{await db.exec('ROLLBACK');}
    });
    await t.test('private helpers are owner-only; only bounded public signup-document reader is anonymous',async()=>{
      const funcs=await q(`SELECT n.nspname,p.proname,p.proconfig,has_function_privilege('anon',p.oid,'EXECUTE') AS anon,
        has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname IN ('private','public') AND p.prokind='f'`);
      for(const f of funcs){assert.ok(f.proconfig?.includes('search_path=""'),f.proname);if(f.nspname==='private')assert.equal(f.authenticated,false,f.proname);
        if(f.anon)assert.equal(f.proname,'list_signup_consent_policies');}
    });
  }finally{await db.close();}
});
