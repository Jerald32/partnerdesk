import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPasswordHandler} from '../supabase/functions/password-policy/handler.mjs';
function fixture(){
 const calls=[];
 const handler=createPasswordHandler({randomUUID:()=> 'new-user',hash:async password=>{calls.push(['hash',password]);return 'bcrypt-hash';},
  authenticate:async token=>token==='valid-token'?{id:'verified-user'}:null,
  reserve:async args=>{calls.push(['reserve',args]);},approve:async args=>{calls.push(['approve',args]);return {proof_token:'one-time-proof'};},updatePassword:async(...args)=>{calls.push(['update',...args]);},
  createUser:async args=>{calls.push(['create',args]);return true;},sendConfirmation:async email=>{calls.push(['email',email]);}});
 const invoke=(body,token)=>handler(new Request('https://test',{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)}));
 return {calls,invoke};
}
test('server rejects whitespace/Hangul even when every required class is present, before hashing or writing',async()=>{
 const f=fixture();
 for(const password of ['Abcdef1! ','Abcdef1!한','Abcdef1!ㄱ','Abcdef1!\n','Abcdef1!\u00a0']) {
  const response=await f.invoke({action:'signup',password});assert.equal(response.status,422);
 }
 assert.equal(f.calls.length,0);
});
test('known production aliases support browser preflight; unrelated browser origins are refused',async()=>{
 const handler=createPasswordHandler({});
 for(const origin of ['https://partnerdesk-phi.vercel.app','https://partnerdesk-716-7c9a.vercel.app']) {
  const response=await handler(new Request('https://test',{method:'OPTIONS',headers:{origin}}));
  assert.equal(response.status,204);assert.equal(response.headers.get('access-control-allow-origin'),origin);
 }
 const denied=await handler(new Request('https://test',{method:'OPTIONS',headers:{origin:'https://unrelated.invalid'}}));
 assert.equal(denied.status,403);
});
test('signup binds native Auth to server approval; reset derives owner from verified JWT',async()=>{
 const f=fixture();
 assert.equal((await f.invoke({action:'signup',email:'test@example.invalid',name:'Fixture',password:'Abcdef1!',signup_consents:[],role:'admin'})).status,200);
 const created=f.calls.find(x=>x[0]==='create')[1];assert.equal(created.proofToken,'one-time-proof');assert.equal(created.password,'Abcdef1!');assert.equal(created.role,undefined);
 const approval=f.calls.find(x=>x[0]==='approve')[1];assert.equal(approval.hash,'bcrypt-hash');assert.equal(approval.password,undefined);
 assert.equal((await f.invoke({action:'reset',password:'Abcdef1!',userId:'victim'})).status,401);
 assert.equal((await f.invoke({action:'reset',password:'Abcdef1!',userId:'victim'},'valid-token')).status,200);
 assert.deepEqual(f.calls.find(x=>x[0]==='update'),['update','valid-token','Abcdef1!']);
});
