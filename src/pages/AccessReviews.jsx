import {useEffect,useState} from 'react';
import {Link,useNavigate,useParams,useSearchParams} from 'react-router-dom';
import {useAuth} from '@/lib/AuthContext';
import {isCompanyAdmin,isCompanyMember} from '@/lib/roles';
import {supabase} from '@/lib/supabaseClient';
import {invokeAppAuth} from '@/lib/appAuth';
import {useRpcAction} from '@/hooks/useRpcAction';
import {auditTime} from '@/lib/roleAudit';
import {previousReviewMonth,reviewError,reviewStatus} from '@/lib/accessReview';
import {MonthlyReviewSummary} from '@/components/MonthlyReviewOverview';

const field='border border-border rounded px-3 py-2 bg-background text-sm w-full';
const button='border border-border rounded px-3 py-2 text-sm disabled:opacity-50';
function RequestForm({approvers,onSaved,initialOpen=false}) {
 const [open,setOpen]=useState(initialOpen),[month,setMonth]=useState(previousReviewMonth),[approver,setApprover]=useState('');
 useEffect(()=>{if(initialOpen)setOpen(true);},[initialOpen]);
 const [summary,setSummary]=useState(''),[findings,setFindings]=useState(''),[actions,setActions]=useState('');
 const {run,busy,error,unknown}=useRpcAction(data=>{setOpen(false);setSummary('');setFindings('');setActions('');onSaved(data);},reviewError);
 return <section className="rounded-lg border border-border p-4 space-y-3">
  <button className="access-review-request-button" type="button" onClick={()=>setOpen(v=>!v)} aria-expanded={open}>접속기록 점검 승인요청하기</button>
  {open&&<form className="space-y-3 max-w-2xl" onSubmit={e=>{e.preventDefault();if(busy||unknown)return;void run('request_access_review',{p_month:month+'-01',p_approver_id:approver,p_summary:summary,p_findings:findings,p_actions:actions},data=>data?.status==='pending'&&Boolean(data.id));}}>
   <p className="text-sm text-muted-foreground">선택한 달 전체 기록을 점검한 뒤 요청해 주세요. 제출 시 대상 기록이 고정되며, 수정은 요청 회수 후 재요청으로 진행합니다.</p>
   <fieldset disabled={busy||unknown} className="space-y-3">
    <label className="block text-sm">점검 대상 월<input required type="month" min="2000-01" max={previousReviewMonth()} value={month} onChange={e=>setMonth(e.target.value)} className={field}/></label>
    <label className="block text-sm">승인자<select required value={approver} onChange={e=>setApprover(e.target.value)} className={field}><option value="">승인자 선택</option>{approvers.map(p=><option key={p.id} value={p.id}>{p.name} ({p.email})</option>)}</select></label>
    {!approvers.length&&<p role="status" className="text-sm text-muted-foreground">지정할 수 있는 다른 활성 Company 사용자가 없습니다.</p>}
    {[['점검 결과',summary,setSummary,'점검한 내용과 결과를 입력해 주세요.'],['특이사항',findings,setFindings,'이상 접속 등 특이사항을 입력해 주세요. 없으면 ‘특이사항 없음’.'],['조치 내용',actions,setActions,'조치 결과를 입력해 주세요. 없으면 ‘조치 불필요’.']].map(([label,value,set,placeholder])=><label key={label} className="block text-sm">{label}<textarea required maxLength={4000} value={value} onChange={e=>set(e.target.value)} placeholder={placeholder} className={field} rows={3}/></label>)}
    <button disabled={!approvers.length||![summary,findings,actions].every(v=>v.trim())} className="access-review-request-button">{busy?'요청 중…':'승인 요청 제출'}</button>
   </fieldset>
  </form>}
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
 </section>;
}

function ReviewDetail({id,user,refresh,onSaved}) {
 const [data,setData]=useState(null),[offset,setOffset]=useState(0),[error,setError]=useState(''),[loading,setLoading]=useState(true);
 const [comment,setComment]=useState(''),[confirmed,setConfirmed]=useState(false);
 const action=useRpcAction(()=>{setComment('');setConfirmed(false);onSaved();},reviewError);
 useEffect(()=>{
  const controller=new AbortController();setLoading(true);setError('');setData(null);
  async function load(){try{
   await invokeAppAuth('validate-session');if(controller.signal.aborted)return;
   const {data,error}=await supabase.rpc('read_access_review',{p_review_id:id,p_offset:offset}).abortSignal(controller.signal);
   if(error)throw error;if(!data?.review||!Array.isArray(data.rows))throw new Error('invalid_response');
   if(!controller.signal.aborted)setData(data);
  }catch(error){if(!controller.signal.aborted)setError(reviewError(error)||'점검 요청을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');}
  finally{if(!controller.signal.aborted)setLoading(false);}}
  void load();return()=>controller.abort();
 },[id,offset,refresh]);
 const decide=outcome=>{if(action.busy||action.unknown||!comment.trim())return;
  if(!window.confirm(`${reviewStatus(outcome)} 처리하시겠습니까? 처리 결과는 수정할 수 없습니다.`))return;
  void action.run('decide_access_review',{p_review_id:id,p_outcome:outcome,p_comment:comment},d=>d?.id===id&&d.status===outcome);
 };
 if(loading)return <p role="status">점검 상세를 불러오는 중...</p>;
 if(error)return <p role="alert" className="text-destructive">{error}</p>;
 if(!data)return null;
 const r=data.review,canDecide=r.status==='pending'&&r.approver_id===user.id&&r.requester_id!==user.id;
 return <section className="rounded-lg border border-border p-4 space-y-4">
  <h3 className="font-semibold">{r.review_month.slice(0,7)} 접속기록 점검 · {reviewStatus(r.status)}</h3>
  <dl className="grid gap-3 sm:grid-cols-2 text-sm">{Object.entries({'요청자':`${r.requester_name} (${r.requester_email})`,'요청일시':auditTime(r.requested_at),'지정 승인자':`${r.approver_name} (${r.approver_email})`,'요청자 접속 IP':r.requester_ip||'IP 기록 없음','점검 결과':r.summary,'특이사항':r.findings,'조치 내용':r.actions,'처리일시':auditTime(r.decided_at),'처리 의견':r.comment||'미처리','처리자':r.decision_actor_id?`${r.decision_actor_name} (${r.decision_actor_email})`:'미처리','처리자 접속 IP':r.decision_ip||'IP 기록 없음'}).map(([label,value])=><div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="whitespace-pre-wrap break-words">{value}</dd></div>)}</dl>
  <p className="text-xs text-muted-foreground">이름·이메일은 현재 사용자 정보입니다. 요청자·승인자·처리자의 사용자 ID와 처리 내용은 이력에 보존됩니다.</p>
  <h4 className="font-medium">고정된 점검 대상 접속기록 ({data.log_count}건)</h4>
  <p className="text-xs text-muted-foreground">한국 시간 기준 해당 월 전체 기록 중 요청 시점에 존재했던 기록입니다. 원본 ID와 해시를 유지합니다.</p>
  <div className="overflow-x-auto border border-border rounded"><table className="w-full text-xs text-left"><thead><tr>{['접속일시 (KST)','사용자 ID · 역할','작업','대상','결과','접속 IP','증적'].map(label=><th key={label} className="p-3 whitespace-nowrap" scope="col">{label}</th>)}</tr></thead><tbody>{data.rows.length?data.rows.map(log=><tr key={log.id} className="border-t border-border"><td className="p-3 whitespace-nowrap">{auditTime(log.accessed_at)}</td><td className="p-3 break-all">{log.actor_profile_id||'기록 없음'}<p>{log.user_role}</p></td><td className="p-3">{log.action}</td><td className="p-3 break-all">{log.target_type}<p>{log.target_id}</p></td><td className="p-3">{log.result||'기록 없음'}</td><td className="p-3 whitespace-nowrap">{log.user_ip||'IP 기록 없음'}</td><td className="p-3"><details><summary className="cursor-pointer">원본 식별자</summary><p className="break-all">ID: {log.id}</p><p>순번: {log.seq??'기록 없음'}</p><p className="break-all">해시: {log.record_hash||'기록 없음'}</p></details></td></tr>):<tr><td colSpan={7} className="p-3">해당 월의 접속기록이 없습니다.</td></tr>}</tbody></table></div>
  <div className="flex gap-3 text-sm"><button className={button} disabled={!offset} onClick={()=>setOffset(v=>Math.max(0,v-100))}>이전 기록</button><span>{Math.floor(offset/100)+1}페이지</span><button className={button} disabled={!data.has_more||offset>=1000000} onClick={()=>setOffset(v=>v+100)}>다음 기록</button></div>
  {r.status==='pending'&&(canDecide||isCompanyAdmin(user))&&<div className="space-y-3 border-t border-border pt-4">
   <label className="block text-sm">처리 의견 (필수)<textarea className={field} maxLength={2000} value={comment} onChange={e=>setComment(e.target.value)} disabled={action.busy||action.unknown} rows={3}/></label>
   {canDecide&&<label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} disabled={action.busy||action.unknown}/>대상 접속기록과 점검 결과를 확인했습니다.</label>}
   <div className="flex flex-wrap gap-3">{canDecide&&<><button className={button} disabled={!confirmed||!comment.trim()||action.busy||action.unknown} onClick={()=>decide('approved')}>승인</button><button className={button} disabled={!comment.trim()||action.busy||action.unknown} onClick={()=>decide('rejected')}>반려</button></>}{isCompanyAdmin(user)&&<button className={button} disabled={!comment.trim()||action.busy||action.unknown} onClick={()=>decide('withdrawn')}>요청 회수</button>}</div>
   {!canDecide&&<p className="text-xs text-muted-foreground">지정된 승인자만 승인·반려할 수 있습니다.</p>}
  </div>}
  {action.error&&<p role="alert" className="text-destructive text-sm">{action.error}</p>}
 </section>;
}

export default function AccessReviews() {
 const {user}=useAuth();const {id}=useParams();const navigate=useNavigate();const [search,setSearch]=useSearchParams();
 const [data,setData]=useState(null),[refresh,setRefresh]=useState(0),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const showAll=search.get('view')==='all',page=Number(search.get('page')||1);
 const offset=Number.isInteger(page)&&page>=1&&page<=10001?(page-1)*100:0;
 const setOffset=update=>setSearch(current=>{const next=new URLSearchParams(current);next.set('page',String(update(offset)/100+1));return next;});
 const allowed=isCompanyMember(user);
 useEffect(()=>{
  if(!allowed)return;
  const controller=new AbortController();setLoading(true);setError('');setData(null);
  async function load(){try{
   await invokeAppAuth('validate-session');if(controller.signal.aborted)return;
   const {data,error}=await supabase.rpc('list_access_reviews',{p_offset:offset,p_scope:showAll?'all':'recent'}).abortSignal(controller.signal);
   if(error)throw error;if(!Array.isArray(data?.rows)||!Array.isArray(data.approvers))throw new Error('invalid_response');
   if(!controller.signal.aborted)setData(data);
  }catch(error){if(!controller.signal.aborted)setError(reviewError(error)||'월별 점검 현황을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');}
  finally{if(!controller.signal.aborted)setLoading(false);}}
  void load();return()=>controller.abort();
 },[allowed,user.id,offset,refresh,showAll]);
 if(!allowed)return <p>Company 사용자만 이용할 수 있습니다.</p>;
 return <div className="space-y-4">
  {showAll&&<Link to="/access-reviews" className={button+' inline-flex items-center'}>뒤로가기</Link>}
  <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">{showAll?'월별 접속기록 점검 · 전체 현황':'월별 접속기록 점검'}</h2><button className={button} disabled={loading} onClick={()=>setRefresh(v=>v+1)}>새로고침</button></div>
  <p className="text-sm text-muted-foreground">전역 관리자가 점검을 요청하고 지정된 Company 사용자 1명이 검토합니다. 본인 승인은 허용하지 않으며, 모든 일시는 한국 시간입니다.</p>
  {!showAll&&isCompanyAdmin(user)&&<MonthlyReviewSummary summary={data?.monthly_summary} loading={loading} error={Boolean(error)}/>}
  {isCompanyAdmin(user)?<><Link className="text-primary text-sm" to="/access-logs">접속기록 조회하기</Link>{data&&<p role="status" className="text-sm">{data.previous_month.slice(0,7)} 월별 점검: <strong>{data.previous_month_approved?'승인 완료':'점검 승인 미완료'}</strong></p>}<RequestForm approvers={data?.approvers||[]} initialOpen={search.get('request')==='1'} onSaved={r=>{setRefresh(v=>v+1);navigate('/access-reviews/'+r.id+(showAll?'?view=all':''));}}/></>:<section className="rounded-lg border border-border p-4 space-y-2"><button className={button} disabled>접속기록 점검 승인요청하기</button><p className="text-sm text-muted-foreground">전역 관리자(Company Admin)만 승인 요청을 작성할 수 있습니다. 지정 승인자는 아래 요청에서 검토하기를 선택해 주세요.</p></section>}
  {error&&<p role="alert" className="text-destructive">{error}</p>}
  <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">{showAll?'전체 점검 이력':'최근 3개월 점검 이력'}</h3>{!showAll&&<Link to="/access-reviews?view=all" className={button+' inline-flex items-center'}>전체보기</Link>}</div>
  {!showAll&&<p className="text-sm text-muted-foreground">점검 대상 월 기준, 전월까지 최근 3개월의 이력을 표시합니다.{data?.range_from&&data?.range_to&&` (${data.range_from.slice(0,7)} ~ ${data.range_to.slice(0,7)})`}</p>}
  <div className="border border-border rounded overflow-x-auto"><table className="w-full text-sm text-left"><thead><tr>{['대상 월','점검 상태','요청자','요청일시 (KST)','승인자','처리일시 (KST)','상세'].map(label=><th scope="col" key={label} className="p-3 whitespace-nowrap">{label}</th>)}</tr></thead><tbody>{loading?<tr><td className="p-3" colSpan={7}>불러오는 중...</td></tr>:data?.rows.length?data.rows.map(r=><tr key={r.id} className="border-t border-border"><td className="p-3 whitespace-nowrap">{r.review_month.slice(0,7)}</td><td className="p-3 whitespace-nowrap">{reviewStatus(r.status)}</td><td className="p-3">{r.requester_name}<p className="text-xs text-muted-foreground">{r.requester_email}</p></td><td className="p-3 whitespace-nowrap">{auditTime(r.requested_at)}</td><td className="p-3">{r.approver_name}<p className="text-xs text-muted-foreground">{r.approver_email}</p></td><td className="p-3 whitespace-nowrap">{auditTime(r.decided_at)}</td><td className="p-3"><Link className="text-primary" to={'/access-reviews/'+r.id+(showAll?'?view=all&page='+(offset/100+1):'')}>검토하기</Link></td></tr>):<tr><td className="p-3" colSpan={7}>{error?'조회 실패':'조회 가능한 점검 요청이 없습니다.'}</td></tr>}</tbody></table></div>
  <div className="flex gap-3 text-sm"><button className={button} disabled={loading||!offset} onClick={()=>setOffset(v=>Math.max(0,v-100))}>이전</button><span>{Math.floor(offset/100)+1}페이지</span><button className={button} disabled={loading||!data?.has_more||offset>=1000000} onClick={()=>setOffset(v=>v+100)}>다음</button></div>
  {id&&<ReviewDetail key={id} id={id} user={user} refresh={refresh} onSaved={()=>setRefresh(v=>v+1)}/>}
 </div>;
}
