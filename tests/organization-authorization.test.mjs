import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// Real PostgreSQL, real migrations/RLS/RPCs, synthetic identities and sessions only.
// No network, Supabase credentials, mocked authorization, or production writes.
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const holding = '10a8e084-c396-4a97-b301-c4ef4aa59d71';
const company=id(1), bp=id(2), sp=id(3), other=id(4), inactive=id(5);
const businessA=id(101), businessB=id(102), businessC=id(103);
const tickets=[id(201),id(202),id(203),id(204),id(205)];
const actors = [
  {n:301,org:company,role:'admin'}, {n:302,org:company,role:'operator'},
  {n:303,org:bp,role:'partner_admin'}, {n:304,org:bp,role:'operator'},
  {n:305,org:sp,role:'admin'}, {n:306,org:sp,role:'operator'},
  {n:307,org:bp,role:'guest'}, {n:308,org:holding,role:'guest'},
  {n:309,org:other,role:'admin'}, {n:310,org:company,role:'admin',status:'disabled'},
  {n:311,org:inactive,role:'admin'}, {n:312,org:bp,role:'guest',status:'pending_login'},
  {n:313,org:sp,role:'operator',status:'suspended'},
];
const rawToken = n => n.toString(16).padStart(64,'0');

test('organization authorization: migrations, RLS, RPCs, approval and preservation', async t => {
  const db=new PGlite();
  try {
    await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO authenticated,anon,service_role;
      CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,raw_user_meta_data jsonb DEFAULT '{}',encrypted_password text);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated,anon,service_role;`);
    const migrations=readdirSync(new URL('../supabase/migrations/',import.meta.url)).sort();
    for(const file of migrations.filter(f=>f<'20261008000003')) {
      let sql=readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');
      // Read-only remote inspection confirmed this historical function was repaired
      // in production with parentheses. Reproduce that exact baseline in memory;
      // do not rewrite or reapply a migration already in remote history.
      if(file==='20261006000015_add_user_role_management.sql')sql=sql.replace(
        "CASE WHEN v_org.type = 'operator' THEN 'operator_company' ELSE 'partner' END THEN",
        "(CASE WHEN v_org.type = 'operator' THEN 'operator_company' ELSE 'partner' END) THEN");
      try { await db.exec(sql); }
      catch(e) { throw new Error('bootstrap migration '+file+': '+e.message,{cause:e}); }
    }
    for(const [org,name,type,active] of [[company,'Company','operator',true],[bp,'Mixed Partner','partner',true],[sp,'Service Partner','partner',true],[other,'Other Partner','partner',true],[inactive,'Inactive','partner',false]]) {
      await db.query('INSERT INTO organizations(id,name,type,is_active) VALUES($1,$2,$3,$4)',[org,name,type,active]);
      if(type==='partner')await db.query("INSERT INTO partner_details(organization_id,partner_type) VALUES($1,'other')",[org]);
    }
    for(const a of actors) {
      await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[id(a.n+1000),`fixture${a.n}@example.invalid`]);
      await db.query('UPDATE profiles SET id=$1,organization_id=$2,role=$3,account_status=$4 WHERE auth_user_id=$5',[id(a.n),a.org,a.role,a.status||'active',id(a.n+1000)]);
      await db.query(`INSERT INTO private.app_sessions(profile_id,auth_user_id,session_token_hash,authenticated_at,expires_at,last_activity_at)
        VALUES($1,$2,encode(sha256(decode($3,'hex')),'hex'),clock_timestamp()-interval '1 second',clock_timestamp()+interval '8 hours',clock_timestamp()-interval '1 second')`,[id(a.n),id(a.n+1000),rawToken(a.n)]);
    }
    for(const b of [businessA,businessB,businessC])await db.query('INSERT INTO businesses(id,name) VALUES($1,$2)',[b,b]);
    for(const [b,o,level] of [[businessA,bp,'business'],[businessB,bp,'service'],[businessA,sp,'service'],[businessA,other,'service'],[businessC,other,'business']])await db.query('INSERT INTO service_partners(business_id,partner_organization_id,access_level) VALUES($1,$2,$3)',[b,o,level]);
    for(const [index,b,o] of [[0,businessA,sp],[1,businessA,other],[2,businessA,null],[3,businessB,bp],[4,businessC,other]]) {
      await db.query('INSERT INTO tickets(id,business_id,assigned_partner_organization_id,title) VALUES($1,$2,$3,$4)',[tickets[index],b,o,'fixture']);
      await db.query("INSERT INTO activities(ticket_id,type,content,is_internal) VALUES($1,'comment','public',false),($1,'note','private',true)",[tickets[index]]);
      await db.query("INSERT INTO ticket_attachments(ticket_id,object_path,original_name) VALUES($1,$2,'fixture')",[tickets[index],tickets[index]]);
    }
    // Snapshots prove conversion affects only the legacy role, not membership or sessions.
    const before=(await db.query('SELECT id,organization_id,account_status,auth_user_id,updated_at,role FROM profiles ORDER BY id')).rows;
    const sessions=(await db.query('SELECT * FROM private.app_sessions ORDER BY id')).rows;
    const data={}; for(const table of ['organizations','businesses','service_partners','tickets'])data[table]=(await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    // Known policy names must be restored to canonical expressions too; relying
    // only on detecting new names would miss an accidentally widened old policy.
    await db.exec('ALTER POLICY tickets_select_authorized ON tickets USING(true); ALTER POLICY profiles_select_app_session_gate ON profiles USING(true);');
    await db.exec(readFileSync(new URL('../supabase/migrations/20261008000003_separate_organization_roles.sql',import.meta.url),'utf8'));
    // Supabase installations may grant table DML by default. Exercise RLS even
    // with those grants; absence of direct-write policies must still deny DML.
    await db.exec('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO authenticated;');
    const after=(await db.query('SELECT id,organization_id,account_status,auth_user_id,updated_at,role FROM profiles ORDER BY id')).rows;
    assert.deepEqual(after,before.map(p=>({...p,role:p.role==='partner_admin'?'admin':p.role})));
    assert.deepEqual((await db.query('SELECT * FROM private.app_sessions ORDER BY id')).rows,sessions);
    for(const table of Object.keys(data))assert.deepEqual((await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows,data[table]);

    async function as(n,fn,{token=true}={}) {
      await db.exec('BEGIN');
      try {
        await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.headers',$2,true),set_config('request.method','POST',true)",[id(n+1000),JSON.stringify(token?{'x-partnerdesk-session':rawToken(n)}:{})]);
        await db.exec('SET LOCAL ROLE authenticated');
        return await fn();
      } finally { await db.exec('ROLLBACK'); }
    }
    const q=async(sql,args=[]) => (await db.query(sql,args)).rows;
    const fails=async(n,sql,args=[],pattern=/forbidden|role_not_allowed|company_role_required|account_unavailable|active_organization_required/) => as(n,()=>assert.rejects(db.query(sql,args),pattern));

    for(const [n,visible] of [[301,[0,1,2,3,4]],[302,[0,1,2,3,4]],[303,[0,1,2,3]],[304,[0,1,2,3]],[305,[0]],[306,[0]],[307,[]],[308,[]],[309,[1,4]],[310,[]],[311,[]],[312,[]],[313,[]]]) {
      await t.test(`actor ${n}: ticket/list/detail/activity/attachment/aggregate scope`,()=>as(n,async()=>{
        const expected=visible.map(i=>tickets[i]).sort();
        assert.deepEqual((await q('SELECT id FROM tickets ORDER BY id')).map(r=>r.id),expected);
        assert.equal(Number((await q('SELECT count(*) AS count FROM tickets'))[0].count),expected.length);
        assert.deepEqual((await q('SELECT DISTINCT ticket_id FROM activities ORDER BY ticket_id')).map(r=>r.ticket_id),expected);
        assert.deepEqual((await q('SELECT ticket_id FROM ticket_attachments ORDER BY ticket_id')).map(r=>r.ticket_id),expected);
        if(![301,302].includes(n))assert.equal((await q("SELECT * FROM activities WHERE is_internal OR type='note'")).length,0);
        for(let i=0;i<tickets.length;i++)assert.equal((await q('SELECT id FROM tickets WHERE id=$1',[tickets[i]])).length,visible.includes(i)?1:0);
      }));
    }
    for(const n of [301,302,303,304,305,306])await t.test(`actor ${n}: scoped status/comment/address/operator work`,async()=>{
      await as(n,async()=>{ assert.equal((await q("SELECT change_ticket_status($1,'inprogress',1) AS result",[tickets[0]]))[0].result.version,2); });
      await as(n,async()=>{ assert.equal((await q("SELECT add_ticket_activity($1,'comment','ok') AS result",[tickets[0]]))[0].result.type,'comment'); });
      await as(n,async()=>{ assert.equal((await q("SELECT update_ticket_address($1,'address',NULL,1) AS result",[tickets[0]]))[0].result.address,'address'); });
      await as(n,async()=>{ assert.equal((await q('SELECT change_ticket_operator($1,true,1) AS result',[tickets[0]]))[0].result.operator_profile_id,id(n)); });
    });
    for(const n of [303,304,305,306,307,308,312])await t.test(`actor ${n}: foreign ticket mutation rejected`,async()=>{
      for(const [sql,args]of [["SELECT change_ticket_status($1,'done',1)",[tickets[4]]],["SELECT add_ticket_activity($1,'comment','no')",[tickets[4]]],["SELECT update_ticket_address($1,'no',NULL,1)",[tickets[4]]],['SELECT change_ticket_operator($1,true,1)',[tickets[4]]],['SELECT change_ticket_assignment($1,NULL,1)',[tickets[4]]]])await fails(n,sql,args);
    });
    await t.test('scope depends on each Business relationship, not partner Admin role',async()=>{
      await as(303,async()=>assert.equal((await q('SELECT can_access_ticket($1) AS allowed',[tickets[3]]))[0].allowed,true));
      // A ticket not assigned to mixed partner in its service-only Business is invisible.
      await db.query("INSERT INTO tickets(id,business_id,title) VALUES($1,$2,'foreign in mixed business')",[id(206),businessB]);
      await as(303,async()=>assert.equal((await q('SELECT can_access_ticket($1) AS allowed',[id(206)]))[0].allowed,false));
      await fails(303,"SELECT change_ticket_status($1,'done',1)",[id(206)]);
    });
    await t.test('missing app credential denies RLS and RPC, no role-only bypass',async()=>{
      await as(301,async()=>{assert.equal((await q('SELECT id FROM tickets')).length,0);assert.equal((await q('SELECT * FROM profiles')).length,0);},{token:false});
      await as(301,()=>assert.rejects(db.query("SELECT change_ticket_status($1,'done',1)",[tickets[0]]),/app_session/),{token:false});
    });
    await t.test('Company Operator cannot manage users, partner access or audit',async()=>{
      await fails(302,"SELECT change_profile_role_organization($1,'admin',$2)",[id(304),bp]);
      const relation=(await q('SELECT id FROM service_partners WHERE partner_organization_id=$1 LIMIT 1',[sp]))[0].id;
      await fails(302,"SELECT change_service_partner_access_level($1,'business')",[relation]);
      await fails(302,"SELECT read_admin_audit('access',0)");
    });
    await t.test('partner Admin manages only own existing members, both internal roles',async()=>{
      await as(303,async()=>{const r=(await q("SELECT change_profile_role_organization($1,'admin',$2) AS result",[id(304),bp]))[0].result;assert.equal(r.role,'admin');});
      await fails(303,"SELECT change_profile_role_organization($1,'operator',$2)",[id(306),sp]);
      await fails(303,"SELECT change_profile_role_organization($1,'admin',$2)",[id(304),company]);
      await fails(303,'SELECT deactivate_profile($1)',[id(306)]);
      await as(303,async()=>assert.deepEqual((await q('SELECT id FROM profiles ORDER BY id')).map(r=>r.id),[303,304,307,312].map(id)));
      await fails(303,"SELECT read_admin_audit('role',0)");
      await as(303,async()=>assert.equal((await q('SELECT * FROM system_settings')).length,0));
    });
    await t.test('Company Admin can choose partner Operator and move organization',async()=>{
      await as(301,async()=>assert.equal((await q("SELECT change_profile_role_organization($1,'operator',$2) AS result",[id(307),sp]))[0].result.organization_id,sp));
      await as(301,()=>assert.rejects(db.query("SELECT change_profile_role_organization($1,'admin',$2)",[id(308),holding]),/holding_organization_forbidden/));
      await as(301,()=>assert.rejects(db.query("SELECT change_profile_role_organization($1,'admin',$2)",[id(301),sp]),/last_active_admin_protected/));
      await as(301,()=>assert.rejects(db.query("SELECT change_profile_role_organization($1,'operator',$2)",[id(301),company]),/last_active_admin_protected/));
    });
    await t.test('partner cannot read/write Company internal notes or reassign partner',async()=>{
      for(const n of [303,304,305,306]){
        await fails(n,"SELECT add_ticket_activity($1,'note','no')",[tickets[0]],/internal_note_forbidden/);
        await fails(n,'SELECT change_ticket_assignment($1,NULL,1)',[tickets[0]]);
      }
    });
    await t.test('ticket creation cannot self-assign a service partner into new access',async()=>{
      for(const n of [301,302,303,304])await as(n,async()=>{
        const result=(await q("SELECT create_ticket($1,'new fixture') AS result",[businessA]))[0].result;
        assert.equal(result.status,'new');
        assert.equal((await q('SELECT id FROM tickets WHERE id=$1',[result.id])).length,1);
      });
      for(const n of [305,306])await fails(n,"SELECT create_ticket($1,'forbidden')",[businessA],/business_partner_access_required/);
      await fails(303,"SELECT create_ticket($1,'forbidden')",[businessB],/business_partner_access_required/);
      await fails(303,"SELECT create_ticket($1,'forbidden')",[businessC],/business_not_found_or_forbidden/);
      await fails(307,"SELECT create_ticket($1,'forbidden')",[businessA],/role_not_allowed/);
      await fails(303,"SELECT create_ticket($1,'forbidden',p_assigned_partner_organization_id=>$2)",[businessA,sp],/partner_assignment_forbidden/);
    });
    await t.test('notifications do not leak formerly visible foreign tickets or allow changing them',async()=>{
      await db.query("INSERT INTO notifications(recipient_profile_id,ticket_id,message) VALUES($1,$2,'mine'),($1,$3,'foreign')",[id(305),tickets[0],tickets[4]]);
      await as(305,async()=>{
        const rows=await q('SELECT ticket_id FROM notifications');
        assert.deepEqual(rows.map(r=>r.ticket_id),[tickets[0]]);
        assert.equal((await q('SELECT mark_notifications_read(NULL) AS result'))[0].result.count,1);
      });
    });
    await t.test('partner Admin takeover is limited to operators of its own organization',async()=>{
      await db.query('UPDATE tickets SET operator_profile_id=$1 WHERE id=$2',[id(302),tickets[0]]);
      await fails(305,'SELECT change_ticket_operator($1,true,1)',[tickets[0]],/operator_already_assigned/);
      await db.query('UPDATE tickets SET operator_profile_id=$1 WHERE id=$2',[id(306),tickets[0]]);
      await as(305,async()=>assert.equal((await q('SELECT change_ticket_operator($1,true,1) AS result',[tickets[0]]))[0].result.operator_profile_id,id(305)));
      await db.query('UPDATE tickets SET operator_profile_id=NULL WHERE id=$1',[tickets[0]]);
    });
    await t.test('guest role request never grants access, Company approves holding membership',async()=>{
      await as(308,async()=>{
        const r=(await q("SELECT submit_role_request('operator',$1,'please approve',true) AS result",[sp]))[0].result;
        assert.equal(r.status,'pending'); assert.equal((await q('SELECT id FROM tickets')).length,0);
      });
      const request=await as(308,async()=>{const r=(await q("SELECT submit_role_request('operator',$1,'please approve',true) AS result",[sp]))[0].result;return r;});
      // Create a durable synthetic pending request as the owner for review tests.
      await db.query(`INSERT INTO role_requests(id,requester_profile_id,current_organization_id,requested_role,requested_org_type,
        requested_organization_id,justification,consent_agreed,consent_agreed_at) VALUES($1,$2,$3,'operator','partner',$4,'fixture',true,now())`,[request.id,id(308),holding,sp]);
      await fails(305,'SELECT approve_role_request($1,$2,NULL)',[request.id,sp]);
      await as(301,async()=>{
        const result=(await q('SELECT approve_role_request($1,$2,NULL) AS result',[request.id,sp]))[0].result;
        assert.equal(result.role,'operator'); assert.equal(result.status,'approved');
        assert.equal((await q('SELECT id FROM tickets')).length,6); // Company scope remains global.
      });
    });
    await t.test('legacy pending partner_admin approval maps to scoped Admin and revokes only target sessions',async()=>{
      const requestId=id(601);
      await db.query(`INSERT INTO role_requests(id,requester_profile_id,current_organization_id,requested_role,requested_org_type,
        requested_organization_id,justification,consent_agreed,consent_agreed_at) VALUES($1,$2,$3,'partner_admin','partner',$3,'legacy fixture',true,now())`,[requestId,id(307),bp]);
      await as(303,async()=>{
        const r=(await q('SELECT approve_role_request($1,$2,NULL) AS result',[requestId,bp]))[0].result;
        assert.equal(r.role,'admin'); assert.equal(r.organization_id,bp);
        await db.exec('RESET ROLE');
        assert.ok((await q('SELECT revoked_at FROM private.app_sessions WHERE profile_id=$1',[id(307)]))[0].revoked_at);
        assert.equal((await q('SELECT revoked_at FROM private.app_sessions WHERE profile_id=$1',[id(301)]))[0].revoked_at,null);
      });
    });
    await t.test('stale request affiliation cannot expose or administer a foreign member',async()=>{
      const requestId=id(602);
      await db.query(`INSERT INTO role_requests(id,requester_profile_id,current_organization_id,requested_role,requested_org_type,
        requested_organization_id,justification,consent_agreed,consent_agreed_at) VALUES($1,$2,$3,'operator','partner',$3,'stale fixture',true,now())`,[requestId,id(306),bp]);
      await as(303,async()=>assert.equal((await q('SELECT id FROM role_requests WHERE id=$1',[requestId])).length,0));
      await fails(303,'SELECT reject_role_request($1,NULL)',[requestId]);
      await fails(303,'SELECT approve_role_request($1,$2,NULL)',[requestId,bp]);
    });
    await t.test('SECURITY DEFINER ACLs and session gates remain intact',async()=>{
      const functions=await q(`SELECT n.nspname,p.proname,p.prosecdef,p.proconfig,
        has_function_privilege('anon',p.oid,'EXECUTE') AS anon,
        has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname IN ('public','private') AND p.prokind='f'`);
      for(const f of functions){assert.equal(f.prosecdef,true,f.proname);assert.ok(f.proconfig?.includes('search_path=""'),f.proname);assert.equal(f.anon,false,f.proname);if(f.nspname==='private')assert.equal(f.authenticated,false,f.proname);}
      assert.equal((await q("SELECT * FROM pg_policies WHERE schemaname='public' AND permissive='RESTRICTIVE'")).length,13);
      await as(301,async()=>{
        assert.equal((await db.query("UPDATE profiles SET role='admin' WHERE id=$1 RETURNING id",[id(307)])).rows.length,0);
        assert.equal((await db.query('DELETE FROM tickets WHERE id=$1 RETURNING id',[tickets[0]])).rows.length,0);
        await assert.rejects(db.query("INSERT INTO tickets(business_id,title) VALUES($1,'bypass')",[businessA]),/row-level security/);
      });
    });
    await t.test('preflight aborts before data conversion on unexpected policy or disabled RLS',async()=>{
      const migration=readFileSync(new URL('../supabase/migrations/20261008000003_separate_organization_roles.sql',import.meta.url),'utf8');
      await db.exec('CREATE POLICY regression_unreviewed_leak ON tickets FOR SELECT TO authenticated USING(true)');
      try { await assert.rejects(db.exec(migration),/unreviewed_authorization_policy/); }
      finally { await db.exec('ROLLBACK; DROP POLICY regression_unreviewed_leak ON tickets;'); }
      await db.exec('ALTER TABLE tickets DISABLE ROW LEVEL SECURITY');
      try { await assert.rejects(db.exec(migration),/row_security_disabled_requires_review/); }
      finally { await db.exec('ROLLBACK; ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;'); }
      assert.equal((await q('SELECT role FROM profiles WHERE id=$1',[id(301)]))[0].role,'admin');
    });
  } finally { await db.close(); }
});
