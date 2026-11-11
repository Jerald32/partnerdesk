import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validatePassword,PASSWORD_SYMBOLS} from '../src/lib/password.js';
const policy=JSON.parse(readFileSync(new URL('../supabase/auth-password-policy.json',import.meta.url),'utf8'));

test('signup/reset rejects every missing class, whitespace/Unicode cannot substitute for a symbol',()=>{
 for(const password of ['Aa1!abc','abcdefgh1!','ABCDEFGH1!','Abcdefgh!','Abcdefg1','Abcdef1 ','Abcdef1한','Abcdef1😀','Abcdef1! 한','Abcdef1!\t','Abcdef1!ㄱ','Abcdef1!\u1100','Abcdef1!\u00a0'])
  assert.equal(validatePassword(password).valid,false);
 for(const symbol of PASSWORD_SYMBOLS)assert.equal(validatePassword('Abcdef1'+symbol).valid,true);
 // Unicode is counted by code points, matching Auth rather than UTF-16 units.
 assert.equal(validatePassword('Aa1!😀😀😀').valid,false);
 assert.equal(validatePassword('Aa1!😀😀😀😀').valid,true);
});
test('frontend uses the exact server-required symbol set, including escaped colon and backslash',()=>{
 assert.equal(policy.password_min_length,8);
 const classes=policy.password_required_characters.split(':');
 for(let i=0;i<classes.length-1;i++)if(classes[i].endsWith('\\')){classes[i]=classes[i].slice(0,-1)+':'+classes[i+1];classes[i+1]='';}
 const required=classes.filter(Boolean);
 assert.equal(required.length,4);assert.equal(required[3],PASSWORD_SYMBOLS);
 assert.equal(required[0],'abcdefghijklmnopqrstuvwxyz');assert.equal(required[1],'ABCDEFGHIJKLMNOPQRSTUVWXYZ');assert.equal(required[2],'0123456789');
});
