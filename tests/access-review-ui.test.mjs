import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {previousReviewMonth,recentReviewMonths,reviewStatus,reviewError} from '../src/lib/accessReview.js';
const require=createRequire(import.meta.url);
const actor={id:'reviewer',role:'operator'},review={id:'review',review_month:'2026-10-01',status:'pending',requester_id:'requester',approver_id:actor.id,requester_name:'요청자',requester_email:'request@example.invalid',approver_name:'승인자',approver_email:'approver@example.invalid',summary:'점검 완료',findings:'특이사항 없음',actions:'조치 불필요'};
const text=node=>typeof node==='string'?node:!node||typeof node!=='object'?'':[node.props?.children].flat(Infinity).map(text).join('');
function find(node,predicate){if(node&&typeof node==='object'&&predicate(node))return node;for(const child of [node?.props?.children].flat(Infinity)){if(child&&typeof child==='object'){const found=find(child,predicate);if(found)return found;}}}
function fixture(component,props,{search=''}={}){
 const slots=[],deps=[],effects=[],calls=[],rpcCalls=[];let cursor=0;
 const react={useState(initial){const n=cursor++;if(!(n in slots))slots[n]=typeof initial==='function'?initial():initial;return [slots[n],value=>{slots[n]=typeof value==='function'?value(slots[n]):value;}];},
  useEffect(fn,values){const n=cursor++;if(!deps[n]||values.some((v,i)=>v!==deps[n][i])){deps[n]=values;effects.push(fn);}}};
 const imports={react,'react-router-dom':{Link:()=>null,useNavigate:()=>()=>{},useParams:()=>({}),useSearchParams:()=>[new URLSearchParams(search),()=>{}]},'@/lib/AuthContext':{useAuth:()=>({user:actor})},
  '@/lib/roles':{isCompanyAdmin:user=>user.role==='admin',isCompanyMember:()=>true},
  '@/components/MonthlyReviewOverview':{MonthlyReviewSummary:()=>null},
  '@/lib/supabaseClient':{supabase:{rpc:(name,args)=>{rpcCalls.push([name,args]);return {abortSignal:async()=>({data:{review,rows:name==='list_access_reviews'?[review]:[],log_count:0,has_more:false,approvers:[],previous_month:'2026-10-01',range_from:'2026-08-01',range_to:'2026-10-01'},error:null})};}}},
  '@/lib/appAuth':{invokeAppAuth:async()=>{}},'@/hooks/useRpcAction':{useRpcAction:()=>({run:async(...args)=>{calls.push(args);return true;},busy:false,error:'',unknown:false})},
  '@/lib/roleAudit':{auditTime:value=>value||'기록 없음'},'@/lib/accessReview':{previousReviewMonth,reviewStatus,reviewError}};
 const source=ts.transpileModule(readFileSync(new URL('../src/pages/AccessReviews.jsx',import.meta.url),'utf8')+'\nexport {RequestForm,ReviewDetail};',{
  fileName:'AccessReviews.jsx',compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const exports={};new Function('require','exports',source)(name=>imports[name]||require(name),exports);
 const render=()=>{cursor=0;const tree=exports[component](props);while(effects.length)effects.shift()();return tree;};
 return {render,calls,rpcCalls,button:label=>find(render(),node=>node.type==='button'&&text(node)===label),
  field:label=>find(render(),node=>node.type==='label'&&text(node).startsWith(label)),
  settle:async()=>{await new Promise(resolve=>setImmediate(resolve));}};
}

test('monthly overview shows only existing review requests and distinguishes errors from no history',()=>{
 const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
 const imports={react:React,'react-router-dom':{Link:({to,children,...props})=>React.createElement('a',{href:to,...props},children)},
  '@/lib/supabaseClient':{supabase:{}},'@/lib/appAuth':{invokeAppAuth:async()=>{}},
  '@/lib/accessReview':{recentReviewMonths,reviewStatus},'@/lib/roleAudit':{auditTime:value=>value}};
 const source=ts.transpileModule(readFileSync(new URL('../src/components/MonthlyReviewOverview.jsx',import.meta.url),'utf8'),{
  fileName:'MonthlyReviewOverview.jsx',compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const exports={};new Function('require','exports',source)(name=>imports[name]||require(name),exports);
 const html=renderToStaticMarkup(React.createElement(exports.MonthlyReviewSummary,{summary:null,loading:false,error:true}));
 assert.match(html,/월별 점검 기본 현황/);assert.match(html,/전체보기/);assert.match(html,/조회하지 못했습니다/);
 assert.match(html,/조회 실패/);assert.ok(!html.includes('요청 이력 없음'));
 const summary=recentReviewMonths().map(review_month=>({review_month,status:'not_requested'}));
 const empty=renderToStaticMarkup(React.createElement(exports.MonthlyReviewSummary,{summary,loading:false,error:false}));
 assert.match(empty,/최근 3개월 점검 이력이 없습니다/);assert.ok(!empty.includes('요청 이력 없음'));
 summary[0]={...summary[0],id:'existing-review',status:'pending'};
 const existing=renderToStaticMarkup(React.createElement(exports.MonthlyReviewSummary,{summary,loading:false,error:false}));
 assert.match(existing,/승인 대기/);assert.match(existing,/\/access-reviews\/existing-review/);
 assert.ok(!existing.includes(summary[1].review_month));
});

test('request form sends selected month, designated user and all inspection evidence',async()=>{
 const f=fixture('RequestForm',{approvers:[{id:'reviewer',name:'승인자',email:'approver@example.invalid'}],onSaved(){}});
 f.button('접속기록 점검 승인요청하기').props.onClick();
 find(f.field('점검 대상 월'),n=>n.type==='input').props.onChange({target:{value:'2026-10'}});
 find(f.field('승인자'),n=>n.type==='select').props.onChange({target:{value:'reviewer'}});
 for(const [label,value]of [['점검 결과','점검 완료'],['특이사항','특이사항 없음'],['조치 내용','조치 불필요']])find(f.field(label),n=>n.type==='textarea').props.onChange({target:{value}});
 assert.equal(f.button('승인 요청 제출').props.disabled,false);
 find(f.render(),n=>n.type==='form').props.onSubmit({preventDefault(){}});
 assert.deepEqual(f.calls[0].slice(0,2),['request_access_review',{p_month:'2026-10-01',p_approver_id:'reviewer',p_summary:'점검 완료',p_findings:'특이사항 없음',p_actions:'조치 불필요'}]);
});

test('review list defaults to recent three months and full view has a stable back link',async()=>{
 const recent=fixture('default',{});recent.render();await recent.settle();
 assert.deepEqual(recent.rpcCalls[0],['list_access_reviews',{p_offset:0,p_scope:'recent'}]);
 assert.match(text(recent.render()),/최근 3개월 점검 이력/);
 const allLink=find(recent.render(),n=>n.props?.to==='/access-reviews?view=all');assert.equal(text(allLink),'전체보기');
 const all=fixture('default',{},{search:'view=all&page=2'});all.render();await all.settle();
 assert.deepEqual(all.rpcCalls[0],['list_access_reviews',{p_offset:100,p_scope:'all'}]);
 assert.match(text(all.render()),/전체 점검 이력/);
 const back=find(all.render(),n=>n.props?.to==='/access-reviews');assert.equal(text(back),'뒤로가기');
 assert.ok(find(all.render(),n=>n.props?.to==='/access-reviews/review?view=all&page=2'));
});

test('only designated approver gets approval actions; confirmation and comment are required',async()=>{
 const before=globalThis.window;globalThis.window={confirm:()=>true};
 try{
  const f=fixture('ReviewDetail',{id:'review',user:actor,refresh:0,onSaved(){}});f.render();await f.settle();
  assert.equal(f.button('승인').props.disabled,true);
  find(f.render(),n=>n.type==='textarea').props.onChange({target:{value:'기록 검토 완료'}});
  assert.equal(f.button('승인').props.disabled,true);
  find(f.render(),n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});
  assert.equal(f.button('승인').props.disabled,false);f.button('승인').props.onClick();
  assert.deepEqual(f.calls[0].slice(0,2),['decide_access_review',{p_review_id:'review',p_outcome:'approved',p_comment:'기록 검토 완료'}]);
  const own=fixture('ReviewDetail',{id:'review',user:{id:'requester',role:'admin'},refresh:0,onSaved(){}});own.render();await own.settle();
  assert.equal(own.button('승인'),undefined);assert.equal(own.button('반려'),undefined);assert.ok(own.button('요청 회수'));
 }finally{globalThis.window=before;}
});
