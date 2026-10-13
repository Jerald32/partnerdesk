import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),id='77777777-7777-4777-8777-777777777777';
function fixture(options={}){
 const slots=[],modules=new Map(),calls=[],effects=[];let cursor=0;
 const policy={mode:'monitor',version:2,pending:false,current_ip:'211.234.206.63',rows:[{id,ip_address:'211.234.206.63/32',description:'장안동',is_active:true}],...options.policy};
 const react={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v];},
  useRef(initial){const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];},
  useEffect(fn,deps){const i=cursor++;if(!slots[i]||deps.some((v,n)=>v!==slots[i][n])){slots[i]=deps;effects.push(fn);}}};
 const supabase={rpc(name,args){
  if(name==='read_ip_policy')return {abortSignal:async()=>({data:structuredClone(policy),error:null})};
  calls.push({name,args});if(options.error)return Promise.resolve({error:options.error});
  if(name==='save_ip_entry'){const row=policy.rows.find(r=>r.id===args.p_id);if(row)Object.assign(row,{ip_address:args.p_ip,description:args.p_description,is_active:args.p_active});}
  if(name==='disable_ip_policy'){policy.mode='monitor';policy.pending=false;}
  return Promise.resolve({data:{id},error:null});
 }};
 function load(path){if(modules.has(path))return modules.get(path);const exports={};modules.set(path,exports);
  const code=ts.transpileModule(readFileSync(new URL('../'+path,import.meta.url),'utf8'),{fileName:path,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  new Function('require','exports','window',code)(name=>name==='react'?react:name==='@/lib/supabaseClient'?{supabase}:name==='@/hooks/useRpcAction'?load('src/hooks/useRpcAction.js'):name==='@/lib/supabaseData'?{isUuid:v=>v===id}:require(name),exports,{confirm:()=>options.confirm!==false});
  return exports;
 }
 const component=load('src/components/settings/IpWhitelistPanel.jsx').IpWhitelistPanel;
 const render=()=>{cursor=0;return component({onReload(){slots.length=0;effects.length=0;}});};
 const flush=async()=>{for(let i=0;i<3;i++){render();for(const effect of effects.splice(0))effect();await new Promise(resolve=>setImmediate(resolve));}return render();};
 function nodes(node){return node&&typeof node==='object'?[node,...[node.props?.children].flat(Infinity).flatMap(nodes)]:[];}
 const text=node=>typeof node==='string'?node:node?.props?[node.props.children].flat(Infinity).map(text).join(''):'';
 const find=predicate=>nodes(render()).find(predicate);
 const button=label=>find(n=>n.type==='button'&&text(n)===label);
 const inputs=()=>nodes(render()).filter(n=>n.type==='input'&&n.props.type!=='checkbox');
 return {render,flush,calls,policy,text,find,button,inputs,change(index,value){inputs()[index].props.onChange({target:{value}});},submit:()=>find(n=>n.type==='form').props.onSubmit({preventDefault(){}})};
}
test('IP UI shows simple status and keeps recovery details collapsed',async()=>{
 const f=fixture();await f.flush();assert.match(f.text(f.render()),/IP 차단: 꺼짐/);
 assert.equal(f.find(n=>n.type==='details').props.open,undefined);
 assert.equal(f.find(n=>n.type==='form').props.className.includes('sm:grid-cols-2'),true);
 assert.equal(f.calls.length,0);
});
test('IP editing saves the existing ID immediately and resets form without enabling policy',async()=>{
 const f=fixture();await f.flush();f.button('수정').props.onClick();f.change(1,'장안동 사무실');await f.submit();await f.flush();
 assert.equal(f.calls[0].args.p_id,id);assert.equal(f.calls[0].args.p_active,true);
 assert.equal(f.inputs()[0].props.value,'');assert.equal(f.button('수정 취소'),undefined);
 assert.equal(f.policy.mode,'monitor');assert.equal(f.policy.rows.length,1);
});
test('IP duplicate office registration is prevented and deletion preserves recovery history',async()=>{
 const f=fixture();await f.flush();f.change(0,'211.234.206.63');await f.submit();assert.equal(f.calls.length,0);
 assert.match(f.text(f.render()),/이미 등록된 IP/);f.button('삭제').props.onClick();await f.flush();
 assert.equal(f.calls[0].args.p_id,id);assert.equal(f.calls[0].args.p_active,false);
 assert.equal(f.policy.rows.length,1);assert.equal(f.policy.rows[0].is_active,false);
});
test('refresh clears edit fields; uncertain save blocks repeats until refreshed',async()=>{
 const f=fixture({error:{message:'network failure'}});await f.flush();f.button('수정').props.onClick();await f.submit();await f.flush();
 assert.equal(f.button('저장').props.disabled,true);f.button('새로고침').props.onClick();await f.flush();
 assert.equal(f.inputs()[0].props.value,'');assert.equal(f.button('저장').props.disabled,false);
 assert.equal(f.calls.length,1);
});
test('activation remains an explicit separate action and rejected conditions show recovery guidance',async()=>{
 const cancelled=fixture({confirm:false});await cancelled.flush();cancelled.button('IP 차단 켜기').props.onClick();assert.equal(cancelled.calls.length,0);
 const f=fixture({error:{code:'P0001',message:'recovery_path_required'}});await f.flush();f.button('IP 차단 켜기').props.onClick();await f.flush();
 assert.equal(f.calls[0].name,'request_ip_activation');assert.match(f.text(f.find(n=>n.props.role==='alert')),/고급 설정/);
 assert.equal(f.policy.mode,'monitor');
});
test('enforced UI offers audited disable and pending reconfirmation separately',async()=>{
 const f=fixture({policy:{mode:'enforced',pending:true}});await f.flush();assert.ok(f.button('재로그인 후 정책 확인'));
 f.button('IP 차단 끄기').props.onClick();await f.flush();assert.equal(f.calls[0].name,'disable_ip_policy');
 assert.equal(f.policy.mode,'monitor');assert.ok(f.button('IP 차단 켜기'));
});
