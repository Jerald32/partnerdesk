import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gatewayPath} from '../src/lib/gatewayTransport.js';
test('SDK data and Edge requests use native Function path and preserve encoded query filters',()=>{
 for(const upstream of ['https://fixture.supabase.co/rest/v1/rpc/list_signup_consent_policies','https://fixture.supabase.co/functions/v1/app-auth','https://fixture.supabase.co/rest/v1/tickets?select=id,title&business_id=eq.fixture&order=created_at.desc&limit=500&offset=500']){
  const original=new URL(upstream),actual=new URL(gatewayPath(original),'https://fixture.invalid');
  assert.equal(actual.pathname,'/api/gateway');assert.equal(actual.searchParams.get('gateway_path'),original.pathname.slice(1));
  actual.searchParams.delete('gateway_path');assert.deepEqual([...actual.searchParams],[...original.searchParams]);
 }
 const config=JSON.parse(readFileSync(new URL('../vercel.json',import.meta.url),'utf8'));
 assert.ok(config.rewrites.every(rule=>!rule.source.startsWith('/api/gateway')));
 assert.ok(config.rewrites[0].source.includes('api/'));
});
