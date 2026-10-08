import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Load ESM source without Vite alias/extension resolution.
const rolesSource=readFileSync(new URL('../src/lib/roles.js',import.meta.url),'utf8');
const roleUrl='data:text/javascript;base64,'+Buffer.from(rolesSource).toString('base64');
const { isCompanyAdmin, isCompanyMember, canManageUsers, organizationScopeDescription }=await import(roleUrl);
const visibilitySource=readFileSync(new URL('../src/lib/ticketVisibility.js',import.meta.url),'utf8').replace("'./roles'",JSON.stringify(roleUrl));
const { buildTicketVisibilityFilter }=await import('data:text/javascript;base64,'+Buffer.from(visibilitySource).toString('base64'));

test('organization and internal role independently determine menu capabilities',()=>{
  for(const organization_type of ['operator','partner'])for(const role of ['admin','operator','guest']){
    const user={role,organization_type,organization_id:'org'};
    assert.equal(isCompanyMember(user),organization_type==='operator' && role!=='guest');
    assert.equal(isCompanyAdmin(user),organization_type==='operator' && role==='admin');
    assert.equal(canManageUsers(user),role==='admin');
  }
  assert.equal(isCompanyMember({role:'admin',organization_type:'operator'}),false);
  assert.equal(isCompanyMember({role:'admin',organization_type:'operator',organization_id:'10a8e084-c396-4a97-b301-c4ef4aa59d71'}),false);
});
test('optional display filter fails closed and uses actual per-Business schema',()=>{
  const relations=[{business_id:'a',partner_organization_id:'me',access_level:'business'},{business_id:'b',partner_organization_id:'me',access_level:'service'}];
  for(const role of ['admin','operator']){
    const filter=buildTicketVisibilityFilter({role,organization_type:'partner',organization_id:'me'},[],relations);
    assert.equal(filter({business_id:'a',assigned_partner_organization_id:'other'}),true);
    assert.equal(filter({business_id:'b',assigned_partner_organization_id:'me'}),true);
    assert.equal(filter({business_id:'b',assigned_partner_organization_id:'other'}),false);
    assert.equal(filter({business_id:'foreign',assigned_partner_organization_id:'me'}),false);
  }
  for(const user of [null,{role:'guest'},{role:'admin'}])assert.equal(buildTicketVisibilityFilter(user,[],relations)({business_id:'a'}),false);
});
test('scope description supports mixed Business/Service relationships and no relations',()=>{
  assert.match(organizationScopeDescription({type:'operator'}),/Company.*모든 Ticket/);
  assert.match(organizationScopeDescription({type:'partner',access_relations:[]}),/Ticket 접근 불가/);
  const description=organizationScopeDescription({type:'partner',access_relations:[{business:{name:'A'},access_level:'business'},{business:{name:'B'},access_level:'service'}]});
  assert.match(description,/Business Partner · A: 모든 Ticket/);
  assert.match(description,/Service Partner · B: 이 조직에 배정된 Ticket만/);
});
