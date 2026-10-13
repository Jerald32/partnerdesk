import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const user='20000000-0000-4000-8000-000000000001', org='20000000-0000-4000-8000-000000000002';
const sid='20000000-0000-4000-8000-000000000003', otherSid='20000000-0000-4000-8000-000000000004';
test('email MFA: real PostgreSQL challenge, attempt, audit and business boundary',async t=>{
 const db=new PGlite(); const q=async(s,a=[]) => (await db.query(s,a)).rows;
 const val=async(s,a=[]) => (await q(s,a))[0].result;
 try {
  await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
   CREATE SCHEMA auth;GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
   CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb DEFAULT '{}',encrypted_password text);
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated,service_role;`);
  for(const file of readdirSync(new URL('../supabase/migrations/',import.meta.url)).sort().filter(f=>f<'20261008000003')) {
   let s=readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');
   if(file==='20261006000015_add_user_role_management.sql')s=s.replace("CASE WHEN v_org.type = 'operator' THEN 'operator_company' ELSE 'partner' END THEN","(CASE WHEN v_org.type = 'operator' THEN 'operator_company' ELSE 'partner' END) THEN");
   await db.exec(s);
  }
  await q("INSERT INTO organizations(id,name,type) VALUES($1,'fixture','operator')",[org]);
  await q("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'fixture@gmail.com',clock_timestamp())",[user]);
  await q("UPDATE profiles SET organization_id=$1,role='admin',account_status='active' WHERE auth_user_id=$2",[org,user]);
  await db.exec(readFileSync(new URL('../supabase/migrations/20261008000003_separate_organization_roles.sql',import.meta.url),'utf8'));
  await db.exec(readFileSync(new URL('../supabase/migrations/20261012000000_enforce_partner_consent.sql',import.meta.url),'utf8'));
  await q("INSERT INTO system_settings(key,value) VALUES('mfa_enabled','false')");
  const before=await q('SELECT * FROM profiles ORDER BY id');
  await db.exec(readFileSync(new URL('../supabase/migrations/20261013000000_email_mfa_flow.sql',import.meta.url),'utf8'));
  const begin=()=>val('SELECT backend_begin_email_mfa($1,$2) AS result',[user,sid]);
  const deliver=c=>val('SELECT backend_email_mfa_delivery($1,$2,$3,true) AS result',[user,sid,c.challenge_id]);
  const reserve=(c,s=sid)=>val('SELECT backend_reserve_email_mfa_attempt($1,$2,$3,$4) AS result',[user,s,c.challenge_id,c.nonce]);
  const finish=(c,a,verified)=>val('SELECT backend_finish_email_mfa($1,$2,$3,$4,$5,$6,$7,NULL) AS result',
   [user,sid,c.challenge_id,c.nonce,a.attempt_id,verified,verified?'ab'.repeat(32):null]);
  await t.test('additive migration leaves existing profiles/policy intact',async()=>{
   assert.deepEqual(await q('SELECT * FROM profiles ORDER BY id'),before);
   assert.equal((await q("SELECT value FROM system_settings WHERE key='mfa_enabled'"))[0].value,'false');
  });
  let c;
  await t.test('sending grants no session; force cannot skip cooldown; pre-PIN JWT has no business access',async()=>{
   c=await begin();assert.equal(c.ok,true);assert.equal((await q('SELECT * FROM private.app_sessions')).length,0);
   assert.equal((await begin()).reason,'mfa_rate_limited');
   await db.exec('BEGIN');
   try {
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.headers','{}',true)",[user]);
    await db.exec('SET LOCAL ROLE authenticated');
    assert.equal(await val('SELECT has_valid_app_session() AS result'),false);
    assert.equal(await val('SELECT has_required_privacy_consent() AS result'),false);
    await assert.rejects(q('SELECT backend_begin_email_mfa($1,$2)',[user,sid]),/permission denied/);
   } finally {await db.exec('ROLLBACK');}
  });
  await t.test('delivery, primary session, nonce and expiry are mandatory',async()=>{
   assert.equal((await reserve(c)).reason,'challenge_invalid');await deliver(c);
   assert.equal((await reserve(c,otherSid)).reason,'challenge_invalid');
   assert.equal((await val('SELECT backend_reserve_email_mfa_attempt($1,$2,$3,$4) AS result',[user,sid,c.challenge_id,'00'.repeat(32)])).reason,'challenge_invalid');
  });
  await t.test('five attempts persist and lock; no PIN/raw token enters evidence',async()=>{
   for(let i=0;i<5;i++){const a=await reserve(c);assert.equal(a.ok,true);assert.equal((await finish(c,a,false)).reason,i===4?'mfa_locked':'code_invalid');}
   assert.equal((await reserve(c)).reason,'mfa_locked');assert.equal((await begin()).reason,'mfa_locked');
   assert.equal((await q('SELECT * FROM private.app_sessions')).length,0);
   const events=await q('SELECT action,metadata FROM audit.access_logs');assert.ok(events.some(e=>e.action==='이메일 MFA locked'));
   assert.ok(events.every(e=>!JSON.stringify(e).includes('code_hash')&&!JSON.stringify(e).includes('session_token')));
  });
  await t.test('lock expires; verified email creates exactly one MFA session; replay fails',async()=>{
   await q("UPDATE profiles SET mfa_locked_until=clock_timestamp()-interval '1 second' WHERE auth_user_id=$1",[user]);
   await q("UPDATE private.email_mfa_challenges SET created_at=clock_timestamp()-interval '2 minutes' WHERE id=$1",[c.challenge_id]);
   c=await begin();await deliver(c);const a=await reserve(c);assert.equal(a.ok,true);
   assert.equal((await finish(c,a,true)).ok,true);assert.equal((await finish(c,a,true)).reason,'challenge_invalid');
   const sessions=await q('SELECT mfa_verified_at FROM private.app_sessions');assert.equal(sessions.length,1);assert.ok(sessions[0].mfa_verified_at);
   assert.equal((await q('SELECT mfa_fail_count FROM profiles WHERE auth_user_id=$1',[user]))[0].mfa_fail_count,0);
  });
  await t.test('email ownership, account and organization remain server requirements',async()=>{
   await q('UPDATE auth.users SET email_confirmed_at=NULL WHERE id=$1',[user]);
   await assert.rejects(begin(),/account_unavailable/);
   await q('UPDATE auth.users SET email_confirmed_at=clock_timestamp() WHERE id=$1',[user]);
   await q('UPDATE organizations SET is_active=false WHERE id=$1',[org]);await assert.rejects(begin(),/account_unavailable/);
  });
 } finally {await db.close();}
});
