import {test} from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/gateway.js';
import {readQuery,projection} from '../server/gateway/transport.mjs';
import {verifyProof} from '../server/gateway/security.mjs';
const userId='50000000-0000-4000-8000-000000000001',session='ab'.repeat(32),secret='01'.repeat(32);
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
