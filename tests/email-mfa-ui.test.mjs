import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
function provider({mfa=true}={}) {
 const slots=[],calls=[],saved=[];let cursor=0,validPin=false;
 const react={createContext:()=>({Provider:()=>{}}),useCallback:f=>f,useEffect(){},useContext(){},
  useRef(v){const i=cursor++;if(!(i in slots))slots[i]={current:v};return slots[i];},
  useState(v){const i=cursor++;if(!(i in slots))slots[i]=v;return [slots[i],x=>{slots[i]=typeof x==='function'?x(slots[i]):x;}];}};
 globalThis.sessionStorage={removeItem(){},setItem(){}};
 const authUser={id:'fixture',email_confirmed_at:'2026-01-01'};
 const imports={react,'./supabaseClient':{supabase:{auth:{signInWithPassword:async()=>({data:{user:authUser},error:null})},
  from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{role:'guest',account_status:'active',organization:{type:'operator',is_active:true}},error:null})})})}),
  rpc:async()=>({data:{valid:true,requirements:[]},error:null})}},
 './appAuth':{invokeAppAuth:async action=>{calls.push(action);
  if(action==='activate-without-mfa'&&mfa)throw Object.assign(new Error('required'),{reason:'mfa_required'});
  if(action==='send-code')return {challenge_id:'challenge',nonce:'nonce',expires_at:'2030-01-01'};
  if(action==='verify-code'&&!validPin)throw Object.assign(new Error('invalid'),{reason:'code_invalid'});
  return {app_session_token:'fixture-token'};}},
 './appSession':{clearAppSession(){},getAppSession:()=>null,saveAppSession:(...args)=>saved.push(args)},
 './logout':{secureLogout:async()=>{}}};
 const exports={};const output=ts.transpileModule(readFileSync(new URL('../src/lib/AuthContext.jsx',import.meta.url),'utf8'),{
  fileName:'AuthContext.jsx',compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 new Function('require','exports',output)(name=>imports[name]||require(name),exports);
 const render=()=>{cursor=0;return exports.AuthProvider({children:null}).props.value;};
 return {render,calls,saved,accept(){validPin=true;}};
}
test('real AuthProvider keeps password-only login pending and denies failed PIN; valid PIN alone completes app login',async()=>{
 const p=provider();assert.deepEqual(await p.render().login('fixture@gmail.com','fixture password'),{mfaRequired:true});
 assert.equal(p.saved.length,0);assert.equal(p.render().isAuthenticated,false);assert.ok(p.render().mfaChallenge.pending);
 await p.render().checkUserAuth();assert.equal(p.saved.length,0);
 await assert.rejects(p.render().verifyMfa('000000'),/invalid/);assert.equal(p.saved.length,0);assert.equal(p.render().isAuthenticated,false);
 p.accept();await p.render().verifyMfa('123456');assert.equal(p.saved.length,1);assert.equal(p.render().isAuthenticated,true);assert.equal(p.render().mfaChallenge,null);
});
test('MFA-disabled rollout preserves current password login and cancellation clears pending authentication',async()=>{
 const existing=provider({mfa:false});await existing.render().login('fixture@naver.com','fixture password');assert.equal(existing.saved.length,1);
 const pending=provider();await pending.render().login('fixture@company.example','fixture password');
 await pending.render().logout(false);assert.equal(pending.render().mfaChallenge,null);assert.equal(pending.render().isAuthenticated,false);assert.equal(pending.saved.length,0);
});
