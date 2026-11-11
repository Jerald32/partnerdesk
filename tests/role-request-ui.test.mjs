import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';

const require=createRequire(import.meta.url);
function fixture(data){
 const slots=[],effects=[];let cursor=0,mounted=false;
 const react={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v;}];},
  useEffect(fn){if(!mounted)effects.push(fn);}};
 const query={select(){return this;},eq(){return this;},abortSignal(){return this;},async maybeSingle(){return {data:null,error:null};}};
 const imports={react,
  '@/lib/roles':{organizationScopeDescription:()=>''},
  '@/lib/AuthContext':{useAuth:()=>({user:{id:'fixture'}})},
  '@/lib/supabaseClient':{supabase:{rpc:()=>({abortSignal:async()=>({data,error:null})}),from:()=>query}},
  '@/lib/appAuth':{invokeAppAuth:async()=>{}},
  '@/hooks/useRpcAction':{useRpcAction:()=>({busy:false,unknown:false,error:'',run(){throw Error('Unexpected mutation');}})},
  './ConsentModal':{default:()=>null}};
 const exports={};
 const code=ts.transpileModule(readFileSync(new URL('../src/components/users/RoleRequestForm.jsx',import.meta.url),'utf8'),{
  fileName:'RoleRequestForm.jsx',compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 new Function('require','exports',code)(name=>imports[name]||require(name),exports);
 const render=()=>{cursor=0;const tree=exports.default();mounted=true;return tree;};
 const nodes=node=>node&&typeof node==='object'?[node,...[node.props?.children].flat(Infinity).flatMap(nodes)]:[];
 const text=node=>typeof node==='string'?node:node?.props?[node.props.children].flat(Infinity).map(text).join(''):'';
 return {render,nodes,text,async load(){render();for(const effect of effects.splice(0))effect();await new Promise(resolve=>setImmediate(resolve));return render();}};
}

test('non-array organization response shows an inline error instead of crashing the account page',async()=>{
 for(const value of [{id:'first',name:'First',type:'operator'},null,'invalid']){
  const f=fixture(value),tree=await f.load();
  assert.match(f.text(tree),/권한 변경 요청/);
  assert.match(f.text(tree),/권한 요청 정보를 조회하지 못했습니다/);
  assert.equal(f.nodes(tree).find(n=>n.type==='fieldset').props.disabled,true);
  assert.equal(f.nodes(tree).filter(n=>n.type==='option'&&n.props.value==='first').length,0);
 }
});

test('empty and multi-row organization responses keep the directory usable without dropping rows',async()=>{
 for(const rows of [[],[{id:'first',name:'First',type:'operator'},{id:'second',name:'Second',type:'partner'}]]){
  const f=fixture(rows),tree=await f.load();
  assert.equal(f.nodes(tree).some(n=>n.props.role==='alert'),false);
  const options=f.nodes(tree).filter(n=>n.type==='option');
  for(const row of rows)assert.ok(options.some(n=>n.props.value===row.id));
  assert.equal(f.nodes(tree).find(n=>n.type==='fieldset').props.disabled,false);
 }
});
