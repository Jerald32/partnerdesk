// Execute real route/registration handlers with isolated hooks and Auth/RPC transports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const marker=name=>Object.defineProperty(function(){},'name',{value:name});
const Outlet=marker('Outlet'),Navigate=marker('Navigate'),PrivacyConsent=marker('PrivacyConsent');
function module(path,imports){
  const exports={};const source=ts.transpileModule(readFileSync(new URL('../'+path,import.meta.url),'utf8'),{
    fileName:path,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
  }).outputText;
  new Function('require','exports',source)(name=>imports[name]||require(name),exports);return exports;
}
function route({path='/tickets',role='operator',valid=false,authenticated=true}={}){
  return module('src/components/ProtectedRoute.jsx',{
    '@/lib/roles':{isGuest:r=>r==='guest'},'react-router-dom':{Outlet,Navigate,useLocation:()=>({pathname:path})},
    '@/lib/AuthContext':{useAuth:()=>({user:{role},isAuthenticated:authenticated,isLoadingAuth:false,privacyConsentValid:valid,logout(){}})},
    '@/pages/PrivacyConsent':{default:PrivacyConsent},'@/components/users/RoleRequestForm':{default:marker('RoleRequestForm')},
  }).default({});
}
test('real route denies direct business URL on absent consent but preserves authenticated /my recovery',()=>{
  assert.equal(route().type,PrivacyConsent);
  assert.equal(route({path:'/my'}).type,Outlet);
  assert.equal(route({path:'/my',authenticated:false}).type,Navigate);
  assert.equal(route({valid:true}).type,Outlet);
});
test('guest signup-consent gate precedes approval UI; guest /my stays available without business access',()=>{
  assert.equal(route({role:'guest',valid:false}).type,PrivacyConsent);
  assert.equal(route({role:'guest',valid:true}).type,'div');
  assert.equal(route({role:'guest',path:'/my'}).type,Outlet);
});

function registration(policies,{failure=false}={}){
  const slots=[],effects=[],calls=[];let cursor=0,effectRun=false;
  const Input=marker('Input'),Button=marker('Button');
  const react={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v;}];},
    useEffect(fn){if(!effectRun)effects.push(fn);}};
  const consent=module('src/lib/consent.js',{});
  const Component=module('src/pages/Registration.jsx',{
    react,'react-router-dom':{Link:marker('Link')},'lucide-react':{UserPlus:marker('UserPlus')},
    '@/components/AuthLayout':{default:marker('AuthLayout')},'@/components/ui/input':{Input},'@/components/ui/button':{Button},
    '@/lib/supabaseClient':{supabase:{rpc:async()=>({data:policies,error:failure?{code:'error'}:null}),auth:{signUp:async args=>{calls.push(args);return {error:null};}}}},
    '@/lib/logout':{secureLogout:async()=>{}},'@/lib/authRedirect':{authRedirect:()=>'/auth/confirm'},
    '@/lib/password':{validatePassword:()=>({valid:true}),PASSWORD_RULE_TEXT:'fixture rule'},'@/lib/consent':consent,
  }).default;
  const render=()=>{cursor=0;const result=Component();effectRun=true;while(effects.length)effects.shift()();return result;};
  const find=(node,predicate)=>{
    if(node&&typeof node==='object'&&predicate(node))return node;
    for(const child of [node?.props?.children].flat(Infinity)){if(!child||typeof child!=='object')continue;const found=find(child,predicate);if(found)return found;}
  };
  const input=name=>find(render(),n=>n.type===Input&&n.props.type===name);
  const fill=()=>{
    input('email').props.onChange({target:{value:'fixture@example.invalid'}});
    input('text').props.onChange({target:{value:'Fixture'}});
    const passwords=()=>[render()].flatMap(function walk(n){return [n?.type===Input&&n.props.type==='password'?n:[],...[n?.props?.children].flat(Infinity).flatMap(c=>c&&typeof c==='object'?walk(c):[])].flat();});
    for(let i=0;i<2;i++)passwords()[i].props.onChange({target:{value:'FixtureOnly1!'}});
  };
  return {render,find,calls,fill,Input,Button,submit:()=>find(render(),n=>n.type==='form').props.onSubmit({preventDefault(){}})};
}
const flush=async()=>{await new Promise(r=>setTimeout(r,0));};
test('real registration blocks policy-load failure and sends no fabricated agreements when no policy is enabled',async()=>{
  const failed=registration(null,{failure:true});failed.render();await flush();failed.fill();await failed.submit();assert.equal(failed.calls.length,0);
  const normal=registration([]);normal.render();await flush();normal.fill();await normal.submit();
  assert.equal(normal.calls.length,1);assert.deepEqual(normal.calls[0].options.data.signup_consents,[]);
});
test('real registration requires configured acknowledgement and submits exact displayed policy/hash',async()=>{
  const p={kind:'signup_privacy',version:'approved-v1',title:'fixture',document_text:'fixture',text_hash:'b'.repeat(64),required:true};
  const f=registration([p]);f.render();await flush();f.fill();await f.submit();assert.equal(f.calls.length,0);
  f.find(f.render(),n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});
  await f.submit();assert.deepEqual(f.calls[0].options.data.signup_consents,[{kind:p.kind,version:p.version,text_hash:p.text_hash,agreed:true}]);
});
