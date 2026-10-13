import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consentSubmission, signupConsentEntries } from '../src/lib/consent.js';
const policy={kind:'privacy_pledge',version:'v1.0',text_hash:'a'.repeat(64),required:true};
test('document acknowledgement sends the displayed version/hash and cannot submit unchecked or unavailable text',()=>{
  assert.equal(consentSubmission(policy,false),null);
  assert.equal(consentSubmission({...policy,text_hash:null},true),null);
  assert.deepEqual(consentSubmission(policy,true),{p_kind:policy.kind,p_version:policy.version,p_text_hash:policy.text_hash,p_agreed:true});
});
test('signup requires only server-required documents and never invents default agreement',()=>{
  assert.equal(signupConsentEntries(null,{}),null);
  assert.deepEqual(signupConsentEntries([],{}),[]);
  assert.equal(signupConsentEntries([policy],{}),null);
  assert.deepEqual(signupConsentEntries([{...policy,required:false}],{}),[]);
  assert.equal(signupConsentEntries([policy],{privacy_pledge:true})[0].agreed,true);
});
