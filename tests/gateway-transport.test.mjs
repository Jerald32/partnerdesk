import {test} from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/gateway.js';
import {readQuery,projection} from '../server/gateway/transport.mjs';
import {verifyProof} from '../server/gateway/security.mjs';
const userId='50000000-0000-4000-8000-000000000001',session='ab'.repeat(32),secret='01'.repeat(32);

test('without DB opt-in all app-auth actions retain the existing protected Edge route',async()=>{
 const oldFetch=globalThis.fetch,oldEnv={...process.env};
 Object.assign(process.env,{VERCEL:'1',VERCEL_ENV:'production',PARTNERDESK_SUPABASE_URL:'https://bqtlopwgjvvugalktldr.supabase.co',PARTNERDESK_SUPABASE_PUBLISHABLE_KEY:'public-fixture',PARTNERDESK_SUPABASE_SERVICE_KEY:'service-fixture',PARTNERDESK_GATEWAY_SIGNING_KEY:secret});
 delete process.env.PARTNERDESK_SESSION_VALIDATION_DB;
 let edgeCalls=0;
 globalThis.fetch=async(url,options)=>{
  if(String(url).endsWith('/auth/v1/user'))return Response.json({id:userId});
  if(String(url).endsWith('/backend_gateway_policy'))return Response.json({mode:'enforced',version:1,entries:['192.0.2.0/24']});
  assert.ok(String(url).endsWith('/functions/v1/app-auth'));
  verifyProof({payload:options.headers['X-PartnerDesk-Proof'],signature:options.headers['X-PartnerDesk-Signature']},secret,
   {userId,sessionToken:session,path:'functions/app-auth',method:'POST',body:options.body});
  edgeCalls++;return Response.json({success:true});
 };
 try{
  for(const action of ['validate-session','activate-without-mfa','send-code','verify-code','logout']){
   const res={setHeader(){},end(){}};
   await handler({url:'/api/gateway?gateway_path=functions/v1/app-auth',method:'POST',body:{action},headers:{authorization:'Bearer fixture-user-jwt','x-partnerdesk-session':session,'x-vercel-forwarded-for':'192.0.2.1','x-partnerdesk-performance-baseline':'1'}},res);
   assert.equal(res.statusCode,200);
  }
  assert.equal(edgeCalls,5);
 }finally{globalThis.fetch=oldFetch;for(const k of Object.keys(process.env))if(!Object.hasOwn(oldEnv,k))delete process.env[k];Object.assign(process.env,oldEnv);}
});
test('query translation preserves projection, nested joins, filters, order and range; rejects arbitrary expressions',()=>{
 const {request,fields}=readQuery('profiles',new URLSearchParams('select=id,organization:organizations!profiles_organization_id_fkey(id,name)&auth_user_id=eq.fixture&order=id.asc&limit=1'));
 assert.equal(request.filters[0].value,'fixture');
 assert.deepEqual(projection({id:'fixture',email:'not_requested',organization:{id:'org',name:'fixture',extra:'not_requested'}},fields),{id:'fixture',organization:{id:'org',name:'fixture'}});
 assert.equal(readQuery('partner_details',new URLSearchParams()).request.order[0].column,'organization_id');
 for(const query of ['select=id;delete','or=(id.eq.x)','id=like.*','limit=1001','order=id.desc;delete','select=other(id)'])assert.throws(()=>readQuery('profiles',new URLSearchParams(query)));
 assert.throws(()=>readQuery('auth.users',new URLSearchParams()));
});
test('real gateway handler verifies identity, overwrites internal proof, retains user JWT and returns no server proof',async()=>{
 const oldFetch=globalThis.fetch,oldEnv={...process.env};
 Object.assign(process.env,{VERCEL:'1',PARTNERDESK_SUPABASE_URL:'https://bqtlopwgjvvugalktldr.supabase.co',PARTNERDESK_SUPABASE_PUBLISHABLE_KEY:'public-fixture',PARTNERDESK_SUPABASE_SERVICE_KEY:'service-fixture',PARTNERDESK_GATEWAY_SIGNING_KEY:secret});
 const calls=[];globalThis.fetch=async(url,options)=>{
  calls.push({url:String(url),options});
  if(String(url).endsWith('/auth/v1/user'))return Response.json({id:userId});
  if(String(url).endsWith('/backend_gateway_policy'))return Response.json({mode:'monitor',version:1,entries:['192.0.2.0/24']});
  if(String(url).endsWith('/gateway_read')){
   assert.equal(options.headers.Authorization,'Bearer fixture-user-jwt');assert.equal(options.headers.apikey,'public-fixture');
   const request=JSON.parse(options.body).p_request;
   verifyProof({payload:options.headers['X-PartnerDesk-Proof'],signature:options.headers['X-PartnerDesk-Signature']},secret,
    {userId,sessionToken:session,path:'rpc/gateway_read',method:'POST',body:request});
   return Response.json({rows:[{id:'ticket',title:'fixture',description:'not requested'}],count:1});
  }
  throw new Error('unexpected_endpoint');
 };
 const invoke=async(req)=>{const headers={};let body;const res={setHeader(k,v){headers[k]=v;},end(v){body=v;}};await handler(req,res);return {status:res.statusCode,headers,body};};
 try{
  const r=await invoke({url:'/api/gateway/rest/v1/tickets?select=id,title&limit=10',method:'GET',headers:{authorization:'Bearer fixture-user-jwt','x-partnerdesk-session':session,'x-vercel-forwarded-for':'192.0.2.1','x-partnerdesk-proof':'forged'}});
  assert.equal(r.status,200);assert.deepEqual(JSON.parse(r.body),[{id:'ticket',title:'fixture'}]);assert.equal(r.headers['Content-Range'],'0-0/1');
  assert.ok(!JSON.stringify(r).includes(secret));assert.ok(!JSON.stringify(r).includes('X-PartnerDesk-Proof'));
  const before=calls.length;const denied=await invoke({url:'/api/gateway/https://attacker.invalid',method:'GET',headers:{}});assert.equal(denied.status,400);assert.equal(calls.length,before);
 }finally{globalThis.fetch=oldFetch;for(const k of Object.keys(process.env))if(!Object.hasOwn(oldEnv,k))delete process.env[k];Object.assign(process.env,oldEnv);}
});

test('session validation uses one protected user RPC and overlapping Auth/policy checks; production ignores diagnostic bypass selection',async()=>{
 const oldFetch=globalThis.fetch,oldEnv={...process.env};
 Object.assign(process.env,{VERCEL:'1',VERCEL_ENV:'production',PARTNERDESK_SESSION_VALIDATION_DB:'true',PARTNERDESK_SUPABASE_URL:'https://bqtlopwgjvvugalktldr.supabase.co',PARTNERDESK_SUPABASE_PUBLISHABLE_KEY:'public-fixture',PARTNERDESK_SUPABASE_SERVICE_KEY:'service-fixture',PARTNERDESK_GATEWAY_SIGNING_KEY:secret});
 let releaseAuth,dbCalls=0,authStarted=false;
 globalThis.fetch=async(url,options)=>{
  if(String(url).endsWith('/auth/v1/user')){authStarted=true;return new Promise(resolve=>releaseAuth=()=>resolve(Response.json({id:userId})));}
  if(String(url).endsWith('/backend_gateway_policy')){assert.equal(authStarted,true);releaseAuth();return Response.json({mode:'enforced',version:1,entries:['192.0.2.0/24']});}
  if(String(url).endsWith('/gateway_rpc')){
   dbCalls++;assert.equal(options.headers.apikey,'public-fixture');assert.equal(options.headers.Authorization,'Bearer fixture-user-jwt');
   const body=JSON.parse(options.body).p_request;assert.deepEqual(JSON.parse(body),{name:'validate_app_session',args:{}});
   verifyProof({payload:options.headers['X-PartnerDesk-Proof'],signature:options.headers['X-PartnerDesk-Signature']},secret,
    {userId,sessionToken:session,path:'rpc/gateway_rpc',method:'POST',body});
   return Response.json({success:true,valid:true,session_id:'fixture-session'});
  }
  throw Error('unexpected_edge_or_backend');
 };
 try{
  const headers={};let body;const res={setHeader(k,v){headers[k]=v;},end(value){body=value;}};
  await handler({url:'/api/gateway?gateway_path=functions/v1/app-auth',method:'POST',body:{action:'validate-session'},headers:{authorization:'Bearer fixture-user-jwt','x-partnerdesk-session':session,'x-vercel-forwarded-for':'192.0.2.1','x-partnerdesk-performance-baseline':'1'}},res);
  assert.equal(res.statusCode,200);assert.equal(JSON.parse(body).success,true);assert.equal(dbCalls,1);
  assert.ok(!body.includes(session));assert.match(headers['Server-Timing'],/auth;dur=/);assert.match(headers['Server-Timing'],/policy;dur=/);
 }finally{globalThis.fetch=oldFetch;for(const k of Object.keys(process.env))if(!Object.hasOwn(oldEnv,k))delete process.env[k];Object.assign(process.env,oldEnv);}
});
