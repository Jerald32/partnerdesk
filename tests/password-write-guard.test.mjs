import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const id='90000000-0000-4000-8000-000000000099';
const hash='$2b$10$'+'a'.repeat(53),other='$2b$10$'+'b'.repeat(53),native='$2a$10$'+'c'.repeat(53);
test('password storage accepts only one-time server-approved hashes; native API bypass rejected',async()=>{
 const db=new PGlite();const q=async(s,a=[]) => (await db.query(s,a)).rows;
 try {
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA private;CREATE SCHEMA auth;
   CREATE TABLE auth.users(id uuid PRIMARY KEY,encrypted_password text,email_confirmed_at timestamptz,email text DEFAULT 'guard@example.invalid',raw_user_meta_data jsonb DEFAULT '{}');`);
  await db.exec(readFileSync(new URL('../supabase/migrations/20261109000003_password_policy_guard.sql',import.meta.url),'utf8'));
  await db.exec(readFileSync(new URL('../supabase/migrations/20261109000004_password_policy_native_auth_binding.sql',import.meta.url),'utf8'));
  await db.exec('UPDATE private.password_policy_config SET enforced=true');
  await assert.rejects(q('INSERT INTO auth.users(id,encrypted_password) VALUES($1,$2)',[id,hash]),/password_policy_endpoint_required/);
  const approved=(await q("SELECT backend_approve_password_write($1,$2,'signup','guard@example.invalid') AS result",[id,hash]))[0].result;
  await assert.rejects(q('INSERT INTO auth.users(id,encrypted_password,email,raw_user_meta_data) VALUES($1,$2,$3,$4)',[id,native,'wrong@example.invalid',{_partnerdesk_password_approval:approved.proof_token}]),/password_policy_endpoint_required/);
  await q('INSERT INTO auth.users(id,encrypted_password,raw_user_meta_data) VALUES($1,$2,$3)',[id,native,{_partnerdesk_password_approval:approved.proof_token}]);
  const stored=(await q('SELECT * FROM auth.users WHERE id=$1',[id]))[0];assert.equal(stored.encrypted_password,hash);assert.equal(stored.raw_user_meta_data._partnerdesk_password_approval,undefined);
  assert.equal((await q('SELECT * FROM private.password_write_approvals')).length,0);
  await assert.rejects(q('UPDATE auth.users SET encrypted_password=$1 WHERE id=$2',[other,id]),/password_policy_endpoint_required/);
  await q('UPDATE auth.users SET email_confirmed_at=clock_timestamp() WHERE id=$1',[id]);
  await q("SELECT backend_approve_password_write($1,$2,'reset',NULL)",[id,other]);
  await q('UPDATE auth.users SET encrypted_password=$1 WHERE id=$2',[native,id]);
  assert.equal((await q('SELECT encrypted_password FROM auth.users WHERE id=$1',[id]))[0].encrypted_password,other);
  await assert.rejects(q('UPDATE auth.users SET encrypted_password=$1 WHERE id=$2',[hash,id]),/password_policy_endpoint_required/);
  await q("SELECT backend_approve_password_write($1,$2,'reset',NULL)",[id,hash]);
  await db.exec("UPDATE private.password_write_approvals SET expires_at=clock_timestamp()-interval '1 second'");
  await assert.rejects(q('UPDATE auth.users SET encrypted_password=$1 WHERE id=$2',[hash,id]),/password_policy_endpoint_required/);
  for(const role of ['anon','authenticated']) {
   await db.exec('BEGIN');try{await db.exec('SET LOCAL ROLE '+role);
    await assert.rejects(q("SELECT backend_approve_password_write($1,$2,'reset',NULL)",[id,hash]),/permission denied/);
   }finally{await db.exec('ROLLBACK');}
  }
  for(let i=0;i<6;i++)await q("SELECT backend_reserve_password_request($1,'reset',NULL)",[id]);
  await assert.rejects(q("SELECT backend_reserve_password_request($1,'reset',NULL)",[id]),/password_request_rate_limited/);
 }finally{await db.close();}
});
