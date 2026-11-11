import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {backupDates,backupDigest,prepareBackup,validateBackupFile} from '../src/lib/auditBackup.js';
import {RPCS} from '../server/gateway/transport.mjs';
const exportId='10000000-0000-4000-8000-000000000001';

test('backup envelopes verify exact UTF-8 payload, counts, IDs and KST date boundaries',async()=>{
 assert.deepEqual(backupDates(new Date('2026-12-31T15:00:00Z')),{today:'2027-01-01',yesterday:'2026-12-31'});
 const payload={format:'partnerdesk-audit-data-v1',export_id:exportId,period:{from:'2026-10-01',to_inclusive:'2026-10-31'},
  access_logs:[{id:'original',metadata:{detail:'한글 원본'}}],access_reviews:[],access_review_decisions:[],access_review_items:[],
  counts:{access_logs:1,access_reviews:0,access_review_decisions:0,access_review_items:0}};
 const raw=JSON.stringify(payload),response={export_id:exportId,payload_json:raw,sha256:await backupDigest(raw),counts:payload.counts};
 const result=await prepareBackup(response);assert.equal(result.envelope.payload_json,raw);assert.ok(result.filename.endsWith('.json'));
 assert.deepEqual(await validateBackupFile(JSON.parse(JSON.stringify(result.envelope))),payload);
 await assert.rejects(validateBackupFile({...result.envelope,payload_json:raw.replace('한글 원본','변조 원본')}),/backup_checksum_mismatch/);
 const wrong=JSON.stringify({...payload,counts:{...payload.counts,access_logs:2}});
 await assert.rejects(validateBackupFile({...result.envelope,payload_json:wrong,payload_sha256:await backupDigest(wrong)}),/backup_count_mismatch/);
 await assert.rejects(prepareBackup({...response,counts:{...payload.counts,access_logs:0}}),/backup_count_mismatch/);
 for(const name of ['export_access_backup','verify_access_backup','confirm_access_backup_storage'])assert.ok(RPCS.has(name));
});

test('backup SQL exports full immutable records, guards administrators, validates issuance and records manual storage confirmation',async()=>{
 const db=new PGlite();
 const q=async(sql,args=[]) => (await db.query(sql,args)).rows;
 const scalar=async(sql,args=[]) => (await q(sql,args))[0].result;
 const user='20000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002',review='30000000-0000-4000-8000-000000000001';
 try{
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA private;CREATE SCHEMA audit;
   CREATE TABLE public.profiles(id uuid PRIMARY KEY);
   CREATE FUNCTION private.access_review_actor() RETURNS public.profiles LANGUAGE plpgsql AS $$DECLARE p public.profiles;BEGIN
    IF current_setting('test.session',true) IS DISTINCT FROM 'yes' THEN RAISE EXCEPTION 'app_session_required'; END IF;
    SELECT * INTO p FROM public.profiles WHERE id=current_setting('test.actor')::uuid;RETURN p;END$$;
   CREATE FUNCTION public.is_company_admin() RETURNS boolean LANGUAGE sql AS $$SELECT current_setting('test.admin',true)='yes'$$;
   CREATE FUNCTION private.access_review_ip() RETURNS text LANGUAGE sql AS $$SELECT '192.0.2.1'::text$$;
   CREATE TABLE audit.access_logs(id uuid DEFAULT gen_random_uuid(),seq bigint,actor_profile_id uuid,accessed_at timestamptz DEFAULT clock_timestamp(),
    action text,target_type text,target_id text,metadata jsonb,user_ip text,record_hash text,prev_hash text);
   CREATE TABLE audit.access_reviews(id uuid,review_month date,requested_at timestamptz,summary text);
   CREATE TABLE audit.access_review_decisions(review_id uuid,decided_at timestamptz,outcome text,comment text);
   CREATE TABLE audit.access_review_items(review_id uuid,log_id uuid);
   CREATE FUNCTION audit.verify_access_log_chain() RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('ok',current_setting('test.chain',true)='yes')$$;
   CREATE FUNCTION audit.append_access_log(p_action text,p_target_type text DEFAULT NULL,p_target_id text DEFAULT NULL,p_metadata jsonb DEFAULT '{}',p_trusted_ip text DEFAULT NULL)
   RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE log_id uuid;BEGIN
    INSERT INTO audit.access_logs(actor_profile_id,action,target_type,target_id,metadata,user_ip)
    VALUES(current_setting('test.actor')::uuid,p_action,p_target_type,p_target_id,p_metadata,p_trusted_ip) RETURNING id INTO log_id;
    RETURN jsonb_build_object('id',log_id);END$$;`);
  await db.exec(readFileSync(new URL('../supabase/migrations/20261111000004_internal_audit_backup.sql',import.meta.url),'utf8'));
  await q('INSERT INTO profiles VALUES($1),($2)',[user,other]);
  await q("SELECT set_config('test.actor',$1,false),set_config('test.admin','yes',false),set_config('test.session','yes',false),set_config('test.chain','yes',false)",[user]);
  const month=(await q("SELECT (date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Seoul')-interval '1 month')::date::text AS month"))[0].month;
  const dates=(await q("SELECT ($1::date+1)::text AS start,($1::date+2)::text AS finish",[month]))[0];
  const rows=await q(`INSERT INTO audit.access_logs(id,accessed_at,action,metadata,record_hash,seq)
   SELECT gen_random_uuid(),($1::date::timestamp AT TIME ZONE 'Asia/Seoul')+n*interval '1 day','original_event',jsonb_build_object('original','원문'),'original-hash',n
   FROM generate_series(0,3) n RETURNING id,seq`,[month]);
  await q("INSERT INTO audit.access_reviews VALUES($1,$2,clock_timestamp(),'점검 원본')",[review,month]);
  await q("INSERT INTO audit.access_review_decisions VALUES($1,clock_timestamp(),'approved','승인 원본')",[review]);
  await q('INSERT INTO audit.access_review_items VALUES($1,$2),($1,$3)',[review,rows[0].id,rows[1].id]);
  const args=[dates.start,dates.finish,'정기 백업'];
  const result=await scalar('SELECT export_access_backup($1,$2,$3) AS result',args);
  const file=await prepareBackup(result);assert.equal(file.payload.access_logs.length,2);
  assert.equal(file.payload.access_logs[0].record_hash,'original-hash');assert.deepEqual(file.payload.access_logs[0].metadata,{original:'원문'});
  assert.equal(file.payload.access_reviews.length,1);assert.equal(file.payload.access_review_decisions[0].comment,'승인 원본');
  assert.equal(file.payload.access_review_items.length,2);assert.match(file.payload.scope.review_items,/outside/);
  assert.equal((await scalar('SELECT verify_access_backup($1,$2) AS result',[result.export_id,result.sha256])).verified,true);
  assert.equal((await scalar('SELECT verify_access_backup($1,$2) AS result',[result.export_id,'a'.repeat(64)])).verified,false);
  await assert.rejects(scalar('SELECT confirm_access_backup_storage($1,$2) AS result',[result.export_id,'a'.repeat(64)]),/backup_not_available/);
  await q("SELECT set_config('test.actor',$1,false)",[other]);
  await assert.rejects(scalar('SELECT confirm_access_backup_storage($1,$2) AS result',[result.export_id,result.sha256]),/backup_not_available/);
  await q("SELECT set_config('test.actor',$1,false)",[user]);
  for(let n=0;n<2;n++)assert.equal((await scalar('SELECT confirm_access_backup_storage($1,$2) AS result',[result.export_id,result.sha256])).confirmed,true);
  const confirmations=await q("SELECT metadata FROM audit.access_logs WHERE action='audit_backup_storage_confirmed'");
  assert.equal(confirmations.length,1);assert.equal(confirmations[0].metadata.confirmation_source,'requesting_admin_attestation');
  await assert.rejects(scalar('SELECT export_access_backup($1,$2,$3) AS result',[dates.start,dates.finish,' ']),/invalid_backup_range_or_reason/);
  await q("SELECT set_config('test.admin','no',false)");await assert.rejects(scalar('SELECT export_access_backup($1,$2,$3) AS result',args),/role_not_allowed/);
  await q("SELECT set_config('test.admin','yes',false),set_config('test.chain','no',false)");await assert.rejects(scalar('SELECT export_access_backup($1,$2,$3) AS result',args),/audit_chain_not_appendable/);
  await q("SELECT set_config('test.session','no',false)");await assert.rejects(scalar('SELECT verify_access_backup($1,$2) AS result',[result.export_id,result.sha256]),/app_session_required/);
 }finally{await db.close();}
});
