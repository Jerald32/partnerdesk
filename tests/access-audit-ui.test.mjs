import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {auditTime} from '../src/lib/roleAudit.js';
import * as accessAudit from '../src/lib/accessAudit.js';
import {PGlite} from '@electric-sql/pglite';
const require=createRequire(import.meta.url);
const nodeText=node=>typeof node==='string'?node:!node||typeof node!=='object'?'':[node.props?.children].flat(Infinity).map(nodeText).join('');
function all(node,predicate){if(!node||typeof node!=='object')return [];return [...(predicate(node)?[node]:[]),...[node.props?.children].flat(Infinity).flatMap(child=>all(child,predicate))];}

test('access audit separates sections and uses the fixed audit table',async()=>{
 const slots=[],deps=[],effects=[];let cursor=0;
 const react={useState(initial){const n=cursor++;if(!(n in slots))slots[n]=initial;return [slots[n],value=>{slots[n]=typeof value==='function'?value(slots[n]):value;}];},
  useEffect(fn,values){const n=cursor++;if(!deps[n]||values.some((v,i)=>v!==deps[n][i])){deps[n]=values;effects.push(fn);}}};
 const timestamp='2026-11-11T01:02:03Z';
 const imports={react,'@/lib/roles':{isCompanyAdmin:()=>true},'@/lib/AuthContext':{useAuth:()=>({user:{id:'admin',role:'admin'}})},
  '@/lib/supabaseClient':{supabase:{rpc:()=>({abortSignal:async()=>({data:{rows:[{id:'record-id',metadata:{result:'success'},accessed_at:timestamp,action:'login_session'}]},error:null})})}},
  '@/lib/appAuth':{invokeAppAuth:async()=>{}},'@/components/RoleAudit':{default:()=>null},'@/components/MonthlyReviewOverview':{default:()=>null},
  'react-router-dom':{Link:()=>null},'@/lib/roleAudit':{auditTime},'@/components/AuditBackup':{default:()=>null},'@/components/AccessAuditTable':{default:()=>null},'@/lib/accessAudit':{enrichAccessRows:async(client,rows)=>rows}};
 const source=ts.transpileModule(readFileSync(new URL('../src/pages/AdminAudit.jsx',import.meta.url),'utf8'),{fileName:'AdminAudit.jsx',compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const exports={};new Function('require','exports',source)(name=>imports[name]||require(name),exports);
 const render=()=>{cursor=0;const tree=exports.default({kind:'access'});while(effects.length)effects.shift()();return tree;};
 render();await new Promise(resolve=>setImmediate(resolve));const tree=render();
 assert.deepEqual(all(tree,n=>n.type==='h2').map(nodeText),['접속기록 점검 현황','접속기록']);
 const table=all(tree,n=>n.type===imports['@/components/AccessAuditTable'].default)[0];
 assert.equal(table.props.rows[0].accessed_at,timestamp);
 assert.deepEqual(table.props.rows[0].metadata,{result:'success'});
});

test('audit table renders seven Korean columns, current and historical labels, and original evidence',()=>{
 const source=ts.transpileModule(readFileSync(new URL('../src/components/AccessAuditTable.jsx',import.meta.url),'utf8'),{fileName:'AccessAuditTable.jsx',compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const imports={'@/lib/roleAudit':{auditTime},'@/lib/accessAudit':accessAudit},exports={};
 new Function('require','exports',source)(name=>imports[name]||require(name),exports);
 const row={id:'original-record',accessed_at:'2026-11-11T01:02:03Z',actor_profile_id:'stable-user-id',action:'ticket_detail_read',result:'success',
  current_name:'현재 이름',current_email:'current@example.invalid',current_organization_name:'현재 조직',target_type:'Ticket',target_id:'ticket-identifier',
  metadata:{organization_name_snapshot:'당시 소속',request_id:'original-request',result:'success'}};
 const tree=exports.default({rows:[row],loading:false,error:''});
 assert.deepEqual(all(tree,n=>n.type==='th').map(nodeText),['접속일시 (KST)','접속 사용자','접속 IP','수행한 업무','처리 대상','처리 결과','상세보기']);
 assert.equal(nodeText(all(tree,n=>n.type==='td')[0]),auditTime(row.accessed_at));
 const user=nodeText(all(tree,n=>n.type==='td')[1]);assert.match(user,/현재 이름/);assert.match(user,/현재 정보/);assert.match(user,/당시 소속/);assert.match(user,/기록 당시/);assert.match(user,/stable-user-id/);
 assert.match(nodeText(tree),/티켓 상세·개인정보 조회/);assert.match(nodeText(tree),/成功|성공/);
 const detail=nodeText(all(tree,n=>n.type==='details')[0]);assert.match(detail,/original-record/);assert.match(detail,/original-request/);assert.match(detail,/ticket-identifier/);assert.match(detail,/organization_name_snapshot/);
 const empty=exports.default({rows:[],loading:false,error:'failed'});assert.equal(all(empty,n=>n.type==='th').length,7);
});

test('identity enrichment uses protected lookups without filtering out inactive accounts and preserves IDs on lookup failure',async()=>{
 const userId='10000000-0000-4000-8000-000000000001',orgId='20000000-0000-4000-8000-000000000001';
 const rows=[{id:'log',actor_profile_id:userId,metadata:{organization_id:orgId},action:'logout'}],calls=[];
 const client={from(table){const chain={select(fields){calls.push([table,fields]);return chain;},in(){return chain;},order(){return chain;},limit(){return chain;},
  async abortSignal(){return {data:table==='profiles'?[{id:userId,full_name:'비활성 사용자',email:'disabled@example.invalid',organization_id:orgId}]:[{id:orgId,name:'현재 조직명'}],error:null};}};return chain;}};
 const signal=new AbortController().signal,loaded=await accessAudit.enrichAccessRows(client,rows,signal);
 assert.equal(loaded[0].current_name,'비활성 사용자');assert.equal(loaded[0].recorded_organization_name,'현재 조직명');
 assert.equal(loaded[0].actor_profile_id,userId);assert.deepEqual(rows[0].metadata,{organization_id:orgId});assert.equal(calls.length,2);
 const unavailable=await accessAudit.enrichAccessRows({from(){throw Error('unavailable');}},rows,signal);
 assert.equal(accessAudit.accessIdentity(unavailable[0]).accountId,userId);assert.equal(unavailable[0].identity_lookup_failed,true);
 assert.equal(accessAudit.accessResult({}), '결과 기록 없음');assert.equal(accessAudit.accessAction('unknown_action'),'기타 업무');
 const snapshot=accessAudit.accessIdentity({...loaded[0],user_name:'당시 이름',user_email:'then@example.invalid'});
 assert.equal(snapshot.name,'당시 이름');assert.equal(snapshot.nameSource,'기록 당시');
});

test('readable audit RPC enriches current labels, preserves snapshots and hash, and retains access guards',async()=>{
 const db=new PGlite(),user='10000000-0000-4000-8000-000000000001',org='20000000-0000-4000-8000-000000000001';
 try{
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA private;CREATE SCHEMA audit;
   CREATE FUNCTION private.require_request_app_session(boolean) RETURNS void LANGUAGE plpgsql AS $$BEGIN
    IF current_setting('test.session',true) IS DISTINCT FROM 'yes' THEN RAISE EXCEPTION 'app_session_required'; END IF;END$$;
   CREATE FUNCTION public.is_company_admin() RETURNS boolean LANGUAGE sql AS $$SELECT current_setting('test.admin',true)='yes'$$;
   CREATE TABLE public.profiles(id uuid,display_name text,full_name text,email text,organization_id uuid,account_status text);
   CREATE TABLE public.organizations(id uuid,name text);
   CREATE TABLE audit.access_logs(id uuid,accessed_at timestamptz,actor_profile_id uuid,user_id text,user_name text,user_email text,user_role text,
    metadata jsonb,action text,target_type text,target_id text,user_ip text,seq bigint,subject_info text,detail text,record_hash text,prev_hash text);`);
  await db.exec(readFileSync(new URL('../supabase/migrations/20261111000003_readable_access_audit.sql',import.meta.url),'utf8'));
  await db.query("INSERT INTO profiles VALUES($1,'현재 이름',NULL,'current@example.invalid',$2,'disabled')",[user,org]);
  await db.query("INSERT INTO organizations VALUES($1,'현재 조직명')",[org]);
  await db.query(`INSERT INTO audit.access_logs(id,accessed_at,actor_profile_id,user_id,user_name,user_email,metadata,action,user_ip,record_hash)
   VALUES(gen_random_uuid(),now(),$1::uuid,$1::uuid::text,'당시 이름','then@example.invalid',jsonb_build_object('organization_id',$2::text,'organization_name_snapshot','당시 조직명','request_id','request-original','result','success'),'login_session','192.0.2.4','original-hash')`,[user,org]);
  await db.exec("SELECT set_config('test.session','yes',false),set_config('test.admin','yes',false)");
  const lookup=async text=>(await db.query('SELECT search_admin_access_audit($1,0) AS result',[text])).rows[0].result.rows;
  const rows=await lookup('현재 이름');assert.equal(rows.length,1);assert.equal(rows[0].current_name,'현재 이름');
  assert.equal(rows[0].user_name,'당시 이름');assert.equal(rows[0].metadata.organization_name_snapshot,'당시 조직명');
  assert.equal(rows[0].record_hash,'original-hash');assert.equal(rows[0].recorded_organization_name,'현재 조직명');
  assert.equal((await lookup('192.0.2.4')).length,1);assert.equal((await lookup('then@example.invalid')).length,1);
  await db.exec("SELECT set_config('test.admin','no',false)");await assert.rejects(lookup(''),/role_not_allowed/);
  await db.exec("SELECT set_config('test.session','no',false)");await assert.rejects(lookup(''),/app_session_required/);
 }finally{await db.close();}
});
