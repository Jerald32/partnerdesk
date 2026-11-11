import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {getPasswordCycleStatus} from '../src/lib/passwordPolicy.js';
import * as policy from '../src/lib/passwordPolicy.js';
const require=createRequire(import.meta.url);
const day=86400000,now=Date.parse('2026-11-09T06:00:00Z');

test('cycle is due exactly at 90 days, missing/invalid history is actionable',()=>{
 assert.equal(getPasswordCycleStatus(null,now).due,false);
 for(const value of [null,'invalid'])assert.equal(getPasswordCycleStatus({password_changed_at:value},now).due,true);
 assert.equal(getPasswordCycleStatus({password_changed_at:new Date(now-90*day+1).toISOString()},now).due,false);
 assert.equal(getPasswordCycleStatus({password_changed_at:new Date(now-90*day).toISOString()},now).due,true);
 assert.equal(getPasswordCycleStatus({password_changed_at:new Date(now+day).toISOString()},now).daysElapsed,0);
});

function fixture(options={}){
 let slots=[],cursor=0,lastKey=null,session={sessionId:'session-1'};
 const storage=new Map(),calls=[],checks=[];
 const auth={user:{id:'profile-1',auth_user_id:'auth-1',email:'profile@example.invalid',password_changed_at:new Date(Date.now()-91*day).toISOString()},isAuthenticated:true,mfaVerified:true};
 const react={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;
  return [slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},useRef(initial){const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];}};
 const marker=name=>Object.defineProperty(function(){},'name',{value:name});
 const names=['Dialog','DialogContent','DialogHeader','DialogTitle','DialogDescription','DialogFooter','Button','KeyRound','Loader2','Mail'];
 const ui=Object.fromEntries(names.map(name=>[name,marker(name)]));
 const modules={react,'lucide-react':ui,'@/components/ui/dialog':ui,'@/components/ui/button':ui,
  '@/lib/AuthContext':{useAuth:()=>auth},'@/lib/appSession':{getAppSession:()=>session},'@/lib/passwordPolicy':policy,
  '@/lib/appAuth':{invokeAppAuth:async action=>{checks.push(action);if(options.validate)await options.validate();}},
  '@/lib/supabaseClient':{supabase:{auth:{getUser:async()=>({data:{user:{id:options.otherUser?'other':'auth-1',email:'verified@example.invalid',email_confirmed_at:'2026-01-01T00:00:00Z'}},error:null}),
   resetPasswordForEmail:async(...args)=>{calls.push(args);return options.mail?options.mail(...args):{error:null};}}}}};
 const exports={};const source=ts.transpileModule(readFileSync(new URL('../src/components/PasswordCycleNotice.jsx',import.meta.url),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 new Function('require','exports','sessionStorage',source)(name=>modules[name]||require(name),exports,
  {getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)});
 function render(){
  const child=exports.default();if(!child){slots=[];lastKey=null;return null;}
  if(child.key!==lastKey){slots=[];lastKey=child.key;}
  cursor=0;return child.type(child.props);
 }
 const text=node=>typeof node==='string'||typeof node==='number'?String(node):!node||typeof node!=='object'?'':[node.props?.children].flat(Infinity).filter(child=>child!==undefined&&child!==null).map(text).join(' ');
 function find(node,predicate){if(node&&typeof node==='object'&&predicate(node))return node;
  for(const child of [node?.props?.children].flat(Infinity)){if(child&&typeof child==='object'){const result=find(child,predicate);if(result)return result;}}}
 return {auth,calls,checks,render,text,button:label=>find(render(),node=>node.type===ui.Button&&text(node).trim()===label),
  newSession:()=>{session={sessionId:'session-2'};},remount:()=>{slots=[];lastKey=null;},alert:()=>find(render(),node=>node.props.role==='alert')};
}

test('notice waits for full login/MFA and recent password changes suppress it',()=>{
 const f=fixture();assert.equal(f.render().props.open,true);
 f.auth.mfaVerified=false;assert.equal(f.render(),null);
 f.auth.mfaVerified=true;f.auth.isAuthenticated=false;assert.equal(f.render(),null);
 f.auth.isAuthenticated=true;f.auth.user.password_changed_at=new Date().toISOString();assert.equal(f.render(),null);
 f.auth.user.password_changed_at=null;assert.equal(f.render().props.open,true);
});
test('later dismisses only this login, including page reload; next login prompts again',()=>{
 const f=fixture();f.button('나중에').props.onClick();assert.equal(f.render().props.open,false);
 f.remount();assert.equal(f.render().props.open,false);
 f.newSession();assert.equal(f.render().props.open,true);
});
test('change button sends one reset email to the Auth-verified owner; sending does not change the password date',async()=>{
 let release;const f=fixture({mail:()=>new Promise(resolve=>{release=resolve;})});
 const before=f.auth.user.password_changed_at,button=f.button('비밀번호 변경하기');
 const first=button.props.onClick(),second=button.props.onClick();await second;
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.length,1);
 assert.deepEqual(f.calls[0],['verified@example.invalid',{redirectTo:'https://partnerdesk-phi.vercel.app/reset-password'}]);
 release({error:null});await first;
 assert.deepEqual(f.checks,['validate-session']);assert.match(f.text(f.render()),/재설정 메일을 발송했습니다/);
 assert.equal(f.auth.user.password_changed_at,before);assert.equal(f.button('비밀번호 변경하기'),undefined);
});
test('session/identity failures send nothing; mail failure stays retryable',async()=>{
 const invalid=fixture({validate:async()=>{throw Error('expired');}});await invalid.button('비밀번호 변경하기').props.onClick();assert.equal(invalid.calls.length,0);assert.ok(invalid.alert());
 const other=fixture({otherUser:true});await other.button('비밀번호 변경하기').props.onClick();assert.equal(other.calls.length,0);
 let attempts=0;const f=fixture({mail:async()=>({error:++attempts===1?{code:'smtp_failed'}:null})});
 await f.button('비밀번호 변경하기').props.onClick();assert.ok(f.alert());assert.ok(f.button('비밀번호 변경하기'));
 await f.button('비밀번호 변경하기').props.onClick();assert.equal(f.calls.length,2);assert.match(f.text(f.render()),/재설정 메일을 발송했습니다/);
});
