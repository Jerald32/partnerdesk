import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

function fixture() {
 let now=1_000_000_000,interval;
 const events=new Map(),storage=new Map(),toasts=[],logouts=[],touches=[];
 const react={useRef:current=>({current}),useEffect:fn=>fn()};
 const exports={};
 const source=ts.transpileModule(readFileSync(new URL('../src/hooks/useIdleTimeout.jsx',import.meta.url),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const modules={react,'@/lib/AuthContext':{useAuth:()=>({logout:redirect=>logouts.push(redirect)})},
  '@/components/ui/use-toast':{useToast:()=>({toast:value=>toasts.push(value)})},
  '@/lib/supabaseClient':{supabase:{rpc:async name=>{touches.push(name);return {error:null};}}}};
 const browser={addEventListener:(name,callback)=>events.set(name,callback),removeEventListener:()=>{}};
 new Function('require','exports','window','localStorage','Date','setInterval','clearInterval',source)(
  name=>modules[name],exports,browser,{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},
  {now:()=>now},callback=>{interval=callback;return 1;},()=>{});
 exports.useIdleTimeout();
 return {toasts,logouts,touches,advance:ms=>{now+=ms;interval();},activity:()=>events.get('keydown')({isTrusted:true})};
}
test('idle UI warns at 25 minutes and logs out at 30 minutes without background keepalive',()=>{
 const f=fixture();f.advance(24*60000);assert.equal(f.toasts.length,0);assert.equal(f.logouts.length,0);
 f.advance(60000);assert.equal(f.toasts[0].title,'로그아웃 예정');
 f.advance(4*60000+59000);assert.equal(f.logouts.length,0);
 f.advance(1000);assert.deepEqual(f.logouts,[true]);assert.match(f.toasts.at(-1).description,/30분/);
 assert.deepEqual(f.touches,[]);
});
test('real user activity renews the idle period and touches the server session',()=>{
 const f=fixture();f.advance(29*60000);f.activity();assert.deepEqual(f.touches,['touch_app_session']);
 f.advance(29*60000);assert.equal(f.logouts.length,0);
 f.advance(60000);assert.deepEqual(f.logouts,[true]);
});
