import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWorker} from '../supabase/functions/inactivity-mail/worker.mjs';

test('worker rejects unauthenticated requests and unconfigured mail before claiming',async()=>{
 let claims=0;
 const worker=createWorker({authorize:async h=>h==='Bearer test',ready:()=>false,rpc:async()=>{claims++;},send:async()=>{}});
 assert.equal((await worker(new Request('https://test',{method:'POST'}))).status,401);
 assert.equal((await worker(new Request('https://test',{method:'POST',headers:{authorization:'Bearer test'}}))).status,503);
 assert.equal(claims,0);
});
test('worker acknowledges SMTP acceptance only, persisting failure for retry',async()=>{
 const acks=[],mails=[];
 const worker=createWorker({authorize:async()=>true,ready:()=>true,
  rpc:async(name,args)=>name==='backend_claim_inactivity_mail'?{messages:[
   {id:'a',lease_id:'la',kind:'warning',email:'a@example.invalid'},
   {id:'b',lease_id:'lb',kind:'suspended',email:'b@example.invalid'}]}:(acks.push(args),{ok:true}),
  send:async mail=>{mails.push(mail);if(mail.id==='b')throw new Error('SMTP rejected');}});
 const response=await worker(new Request('https://test',{method:'POST'}));
 assert.equal(response.status,503);assert.deepEqual(await response.json(),{sent:1,failed:1});
 assert.equal(acks.find(x=>x.p_id==='a').p_sent,true);assert.equal(acks.find(x=>x.p_id==='b').p_sent,false);
 assert.match(mails[0].text,/23일/);assert.match(mails[1].text,/30일/);
});
