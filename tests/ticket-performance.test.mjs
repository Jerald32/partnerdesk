import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const ticketId='50000000-0000-4000-8000-000000000001';
const row={id:ticketId,business_id:'business',operator_profile_id:'operator',assigned_partner_organization_id:'partner'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function page(name){
 const effects=[],states=[],calls=[];let resolveValidation,rejectValidation;
 const validation=new Promise((resolve,reject)=>{resolveValidation=resolve;rejectValidation=reject;});
 const react={useState(value){const state={value};states.push(state);return [value,v=>{state.value=v;}];},
  useRef:value=>({current:value}),useEffect:effect=>effects.push(effect)};
 const query=(table,result)=>{
  const response=result||{data:table==='businesses'?{id:'business',name:'fixture'}:table==='service_partners'?[{partner_organization_id:'partner'}]:[],error:null,count:table==='service_partners'?1:0};
  const q=new Proxy({then:(resolve,reject)=>Promise.resolve(response).then(resolve,reject)},
   {get:(target,key)=>key in target?target[key]:()=>q});return q;
 };
 const supabase={rpc:name=>{calls.push(name);return query(name,{data:row,error:null});},
  from:table=>{calls.push(table);return query(table);}};
 const placeholder=new Proxy({}, {get:()=>()=>null});
 const imports={react,'react-router-dom':{useParams:()=>({id:ticketId}),useNavigate:()=>()=>{},useSearchParams:()=>[new URLSearchParams()]},
  '@/lib/supabaseClient':{supabase},'@/lib/AuthContext':{useAuth:()=>({user:{id:'user',role:'admin',organization_id:'company',organization_type:'operator'}})},
  '@/lib/appAuth':{invokeAppAuth:()=>{calls.push('validate-session');return validation;}},
  '@/lib/roles':{isCompanyAdmin:()=>true,isCompanyMember:()=>true,ALLOWED_ROLES:['admin']},
  '@/lib/performanceTelemetry':{startPageMeasure:()=>()=>{}}};
 const exports={};const code=ts.transpileModule(readFileSync(new URL(`../src/pages/${name}.jsx`,import.meta.url),'utf8'),{
  fileName:`${name}.jsx`,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 new Function('require','exports',code)(key=>imports[key]||(key==='react/jsx-runtime'?require(key):placeholder),exports);
 exports.default();const cleanup=effects[0]();
 return {states,calls,resolveValidation,rejectValidation,cleanup};
}

test('Ticket detail starts dependent protected reads before validation finishes but publishes only after success',async()=>{
 const p=page('TicketDetail');await tick();await tick();
 assert.ok(p.calls.includes('read_ticket_detail_audited'));
 for(const table of ['businesses','service_partners','organizations','activities'])assert.ok(p.calls.includes(table),table);
 assert.ok(!p.calls.includes('profiles'),'Company Admin does not need an assignee organization lookup');
 assert.ok(!p.states.some(s=>s.value===row));
 p.resolveValidation({success:true});await tick();
 assert.ok(p.states.some(s=>s.value===row));p.cleanup();
});

test('Ticket detail never publishes protected data when parallel session validation fails',async()=>{
 const p=page('TicketDetail');await tick();p.rejectValidation(Object.assign(Error('expired'),{reason:'absolute_expired'}));await tick();
 assert.ok(!p.states.some(s=>s.value===row));
 assert.ok(p.states.some(s=>typeof s.value==='string'&&s.value.includes('로그인')));p.cleanup();
});

test('Ticket detail ignores completed reads after navigation cancels the load',async()=>{
 const p=page('TicketDetail');await tick();p.cleanup();p.resolveValidation({success:true});await tick();
 assert.ok(!p.states.some(s=>s.value===row));
});
