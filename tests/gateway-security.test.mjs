import {test} from 'node:test';
import assert from 'node:assert/strict';
import {matchesCIDR,parseCIDR,platformIP,evaluateIP,signProof,verifyProof,sessionDigest} from '../server/gateway/security.mjs';
const secret='01'.repeat(32),userId='50000000-0000-4000-8000-000000000001';
const binding={userId,sessionToken:'ab'.repeat(32),path:'rpc/read_ticket_detail_audited',method:'POST',body:'{"p_ticket_id":"fixture"}'};
test('CIDR checks IPv4, IPv6, boundary masks and mapped IPv4 without trusting malformed input',()=>{
 assert.equal(matchesCIDR('192.0.2.9','192.0.2.0/24'),true);
 assert.equal(matchesCIDR('192.0.3.9','192.0.2.0/24'),false);
 assert.equal(matchesCIDR('2001:db8::a','2001:db8::/32'),true);
 assert.equal(matchesCIDR('2001:db9::a','2001:db8::/32'),false);
 assert.equal(matchesCIDR('::ffff:192.0.2.9','192.0.2.0/24'),true);
 assert.equal(matchesCIDR('::1','0.0.0.0/0'),false);
 assert.equal(matchesCIDR('192.0.2.9','192.0.2.9/32'),true);
 for(const bad of ['1.2.3.4/33','::1/129','1.2.3.4/01','1.2.3.4/-1','1.2.3.4/24/1','fe80::1%eth0'])assert.throws(()=>parseCIDR(bad));
});
test('only the Vercel platform IP slot is accepted; spoofed fallback and lists fail closed',()=>{
 assert.equal(platformIP({'x-forwarded-for':'192.0.2.1'},{vercel:true}),null);
 assert.equal(platformIP({'x-vercel-forwarded-for':'192.0.2.1'},{vercel:false}),null);
 assert.equal(platformIP({'x-vercel-forwarded-for':'192.0.2.1,198.51.100.1'},{vercel:true}),null);
 assert.equal(platformIP({'x-vercel-forwarded-for':'192.0.2.1'},{vercel:true}),'192.0.2.1');
});
test('monitor mode reports verdict without enforcing; missing IP/empty list enforced denies',()=>{
 assert.deepEqual(evaluateIP(null,{mode:'monitor',entries:[]}),{allowed:true,wouldDeny:true,reason:'trusted_ip_unavailable',mode:'monitor'});
 assert.equal(evaluateIP(null,{mode:'enforced',entries:[]}).allowed,false);
 assert.equal(evaluateIP('192.0.2.1',{mode:'enforced',entries:[]}).allowed,false);
 assert.equal(evaluateIP('192.0.2.1',{mode:'enforced',entries:['192.0.2.0/24']}).allowed,true);
});
test('HMAC proof binds user, raw-byte session hash, path, method, body and short expiry',()=>{
 const proof=signProof({...binding,ip:'192.0.2.1',policyVersion:1},secret,{now:100000});
 assert.equal(verifyProof(proof,secret,binding,{now:100000}).ip,'192.0.2.1');
 assert.ok(!Buffer.from(proof.payload,'base64').toString().includes(binding.sessionToken));
 assert.equal(sessionDigest(null),null);
 for(const alteration of [{userId:null},{sessionToken:'cd'.repeat(32)},{path:'rpc/deactivate_profile'},{method:'GET'},{body:'{}'}])
  assert.throws(()=>verifyProof(proof,secret,{...binding,...alteration},{now:100000}),/binding/);
 assert.throws(()=>verifyProof(proof,secret,binding,{now:120000}),/expired/);
 assert.throws(()=>verifyProof({...proof,signature:'ff'.repeat(32)},secret,binding,{now:100000}),/invalid/);
 assert.throws(()=>verifyProof({...proof,payload:Buffer.from('{}').toString('base64')},secret,binding,{now:100000}),/invalid/);
 assert.throws(()=>signProof({...binding,ip:null,policyVersion:1},''),/not_configured/);
});
