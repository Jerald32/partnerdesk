import {test} from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/gateway.js';
const userId='80000000-0000-4000-8000-000000000001';

test('gateway IP exemption trusts live server lookup, never client role or metadata, and audits its use',async()=>{
 const oldFetch=globalThis.fetch,oldEnv={...process.env};
 Object.assign(process.env,{VERCEL:'1',VERCEL_ENV:'production',PARTNERDESK_SUPABASE_URL:'https://bqtlopwgjvvugalktldr.supabase.co',
  PARTNERDESK_SUPABASE_PUBLISHABLE_KEY:'public-fixture',PARTNERDESK_SUPABASE_SERVICE_KEY:'service-fixture',PARTNERDESK_GATEWAY_SIGNING_KEY:'12'.repeat(32)});
 let exempt=true,lookupFails=false,authValid=true,auditFails=false,upstream=0;
 const lookups=[],audits=[];
 globalThis.fetch=async(url,options)=>{
  const path=new URL(url).pathname;
  if(path==='/auth/v1/user')return authValid?Response.json({id:userId,user_metadata:{role:'admin'}}):Response.json({}, {status:401});
  if(path.endsWith('/backend_gateway_policy'))return Response.json({mode:'enforced',version:1,entries:['192.0.2.0/24']});
  if(path.endsWith('/backend_gateway_ip_exemption')) {
   assert.equal(options.headers.Authorization,'Bearer service-fixture');
   lookups.push(JSON.parse(options.body));
   return lookupFails?Response.json({}, {status:503}):Response.json({exempt});
  }
  if(path.endsWith('/backend_gateway_audit')) {
   audits.push(JSON.parse(options.body));
   return Response.json({ok:!auditFails},{status:auditFails?503:200});
  }
  if(path==='/functions/v1/app-auth') {upstream++;return Response.json({success:true});}
  throw new Error('unexpected_endpoint');
 };
 const invoke=async()=>{
  const res={setHeader(){},end(value){this.body=JSON.parse(value);}};
  await handler({url:'/api/gateway?gateway_path=functions/v1/app-auth',method:'POST',body:{action:'send-code'},
   headers:{authorization:'Bearer verified-user-token','x-vercel-forwarded-for':'198.51.100.1','x-role':'admin','x-admin-ip-exempt':'true'}},res);
  return res;
 };
 try {
  assert.equal((await invoke()).statusCode,200);assert.equal(upstream,1);
  assert.deepEqual(lookups[0],{p_auth_user_id:userId});assert.equal(audits[0].p_verdict,'admin_ip_exempt');
  exempt=false;
  assert.equal((await invoke()).statusCode,403);assert.equal(upstream,1);assert.equal(audits.at(-1).p_verdict,'ip_denied');
  lookupFails=true;
  assert.equal((await invoke()).statusCode,503);assert.equal(upstream,1);
  lookupFails=false;exempt=true;auditFails=true;
  assert.equal((await invoke()).statusCode,503);assert.equal(upstream,1);
  auditFails=false;authValid=false;const before=lookups.length;
  assert.equal((await invoke()).statusCode,401);assert.equal(lookups.length,before);assert.equal(upstream,1);
 } finally {
  globalThis.fetch=oldFetch;
  for(const name of Object.keys(process.env))if(!Object.hasOwn(oldEnv,name))delete process.env[name];Object.assign(process.env,oldEnv);
 }
});
