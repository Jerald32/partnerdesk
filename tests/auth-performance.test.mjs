import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {requestTiming} from '../server/gateway/timing.mjs';
function module(path,imports={}){
 const exports={};const code=ts.transpileModule(readFileSync(new URL('../'+path,import.meta.url),'utf8'),{fileName:path,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','exports',code)(name=>{if(name in imports)return imports[name];throw Error(name);},exports);return exports;
}
test('Edge verifies the exact JWT once per request without sharing users or subsequent requests',async()=>{
 const {authenticateOnce,timedServices}=module('supabase/functions/app-auth/timing.ts');
 let calls=0;const service={authenticate:async jwt=>{calls++;if(jwt==='invalid')throw Error('invalid');return {id:jwt};}};
 const timing=timedServices(service),first=authenticateOnce(timing.service);
 const result=await Promise.all([first.authenticate('one'),first.authenticate('one')]);
 assert.deepEqual(result,[{id:'one'},{id:'one'}]);assert.equal(calls,1);
 assert.equal(timing.finish(new Response('{}')).headers.get('X-PartnerDesk-Edge-Auth-Checks'),'1');
 await first.authenticate('two');assert.equal(calls,2);
 await authenticateOnce(service).authenticate('one');assert.equal(calls,3);
 await assert.rejects(first.authenticate('invalid'),/invalid/);await assert.rejects(first.authenticate('invalid'),/invalid/);
 assert.equal(calls,4);
});
test('browser coalesces only concurrent exact JWT/session validations, never successful results or other actions',async()=>{
 let jwt='jwt-one',token='session-one',calls=0;const pending=[];
 const {invokeAppAuth}=module('src/lib/appAuth.js',{'./appSession':{getAppSession:()=>({authUserId:'user',token})},
 './supabaseClient':{supabase:{auth:{getSession:async()=>({data:{session:{access_token:jwt,user:{id:'user'}}}})},
 functions:{invoke:()=>{calls++;return new Promise(resolve=>pending.push(resolve));}}}}});
 const a=invokeAppAuth('validate-session'),b=invokeAppAuth('validate-session');await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
 pending.shift()({data:{success:true}});await Promise.all([a,b]);
 const c=invokeAppAuth('validate-session');await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);
 token='session-two';const d=invokeAppAuth('validate-session');await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,3);
 jwt='jwt-two';const e=invokeAppAuth('validate-session');await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,4);
 for(const resolve of pending.splice(0))resolve({data:{success:true}});await Promise.all([c,d,e]);
 const f=invokeAppAuth('activate-without-mfa'),g=invokeAppAuth('activate-without-mfa');await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,6);
 for(const resolve of pending.splice(0))resolve({data:{success:true}});await Promise.all([f,g]);
});
test('gateway timing exposes only numeric metrics and validated region metadata',async()=>{
 const timing=requestTiming({region:'icn1',first:true});await timing.measure('policy',async()=>{});
 timing.edge(new Response('{}',{headers:{'Server-Timing':'e_auth;dur=12.3, secret;desc="credential", e_bad;dur=NaN','x-sb-edge-region':'ap-northeast-2','x-partnerdesk-edge-auth-checks':'1'}}));
 const headers=timing.headers();assert.match(headers['Server-Timing'],/policy;dur=/);assert.match(headers['Server-Timing'],/e_auth;dur=12.3/);
 assert.ok(!headers['Server-Timing'].includes('credential'));assert.equal(headers['X-PartnerDesk-Edge-Region'],'ap-northeast-2');
 assert.equal(headers['X-PartnerDesk-Instance-First-Request'],'1');
});
