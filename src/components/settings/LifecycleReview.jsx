import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { isCompanyAdmin } from '@/lib/roles';
import { supabase } from '@/lib/supabaseClient';
import { invokeAppAuth } from '@/lib/appAuth';
import { useRpcAction } from '@/hooks/useRpcAction';

const time=value=>value?new Date(value).toLocaleString():'확인된 로그인 없음';
function ReviewRow({row,kind,actorId,onSaved}){
 const {run,busy,error,unknown}=useRpcAction(onSaved);
 const disabled=busy||unknown;
 return <div className="border-t p-3 space-y-2 text-xs">
  {kind==='tickets'?<>
   <p className="font-medium">Ticket {row.id} · {row.status} · {row.retention_state}</p>
   <p>생성: {time(row.created_at)} · 검토 가능: {time(row.review_due_at)}</p>
   <p>활동 {row.activity_count} · 첨부 메타데이터 {row.attachment_count} · Ticket 감사 {row.ticket_audit_count}</p>
   <div className="flex gap-3">{[['retain','계속 보존'],['request_disposal_review','폐기 검토 요청']].map(([decision,label])=>
    <button key={decision} disabled={disabled} className="text-primary" onClick={()=>{
     if(window.confirm(`${label} 상태로 기록하시겠습니까? 데이터는 삭제하지 않습니다.`))
      void run('review_ticket_retention',{p_ticket_id:row.id,p_decision:decision,p_expected_version:row.version});
    }}>{label}</button>)}</div>
  </>:<>
   <p className="font-medium">{row.display_name||row.email} · {row.role} · {row.account_status}</p>
   <p>마지막 업무 로그인: {time(row.last_login_at)}</p>
   <p>{row.review_candidate===null?'휴면 기준 미설정':row.review_candidate?'장기 미접속 검토 대상':'기준 기간 내 계정'}
    {row.no_confirmed_login&&' · 미로그인 계정은 생성일 기준 검토'}{row.automatic_lock_exempt&&' · 자동 잠금 제외'}</p>
   <div className="flex gap-3">
    {row.id!==actorId&&!['disabled','suspended'].includes(row.account_status)&&<button disabled={disabled} className="text-destructive" onClick={()=>{
     if(window.confirm('관리자 승인으로 계정을 비활성화하시겠습니까? 업무 기록은 보존하고 기존 세션은 철회합니다.'))
      void run('deactivate_profile',{p_profile_id:row.id});
    }}>비활성화 승인</button>}
    {['disabled','suspended'].includes(row.account_status)&&<button disabled={disabled} className="text-primary" onClick={()=>{
     if(window.confirm('기존 조직·권한을 유지한 채 계정을 재활성화하시겠습니까?')) void run('reactivate_profile',{p_profile_id:row.id});
    }}>재활성화 승인</button>}
   </div>
  </>}
  {error&&<p role="alert" className="text-destructive">{error}</p>}
 </div>;
}

export default function LifecycleReview(){
 const {user}=useAuth();
 const [kind,setKind]=useState('tickets'),[offset,setOffset]=useState(0),[refresh,setRefresh]=useState(0);
 const [rows,setRows]=useState([]),[days,setDays]=useState(''),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const reload=()=>setRefresh(x=>x+1);
 const {run,busy,error:saveError,unknown}=useRpcAction(reload);
 useEffect(()=>{
  const controller=new AbortController();setLoading(true);setError('');
  async function load(){try{
   if(!isCompanyAdmin(user))return;
   await invokeAppAuth('validate-session');
   if(controller.signal.aborted)return;
   const {data,error}=await supabase.rpc('read_lifecycle_review',{p_kind:kind,p_offset:offset}).abortSignal(controller.signal);
   if(error||!Array.isArray(data?.rows))throw error||new Error('invalid_response');
   if(!controller.signal.aborted){setRows(data.rows);setDays(data.dormancy_review_days?.toString()||'');}
  }catch{if(!controller.signal.aborted)setError('관리 목록을 불러오지 못했습니다. 로그인과 권한을 확인해 주세요.');}
  finally{if(!controller.signal.aborted)setLoading(false);}}
  void load();return()=>controller.abort();
 },[kind,offset,refresh,user?.id,user?.role]);
 if(!isCompanyAdmin(user))return null;
 return <section className="rounded-lg border bg-card p-4 space-y-3">
  <h3 className="font-semibold">보존·휴면 계정 검토</h3>
  <p className="text-xs text-muted-foreground">Ticket 생성 시각부터 UTC 달력 3년 · 상태 무관. 자동 삭제·익명화·계정 잠금은 비활성입니다.</p>
  <div className="flex gap-3 text-sm">{[['tickets','보존기간 경과 Ticket'],['accounts','계정 접속 현황']].map(([value,label])=>
   <button key={value} className={kind===value?'text-primary':''} onClick={()=>{setKind(value);setOffset(0);}}>{label}</button>)}
   <button disabled={loading} onClick={reload}>새로고침</button></div>
  {kind==='accounts'&&<form className="space-y-2 text-xs" onSubmit={e=>{e.preventDefault();if(window.confirm('검토 기준만 저장합니다. 계정은 자동 잠금되지 않습니다.'))
   void run('set_dormancy_review_days',{p_days:days===''?null:Number(days)});}}>
   <label>휴면 검토 기준(일, 빈칸은 미설정) <input aria-label="휴면 검토 기준 일수" type="number" min="1" max="36500" value={days}
    onChange={e=>setDays(e.target.value)} className="border rounded p-2 bg-background w-24"/></label>
   <button disabled={busy||unknown||loading||Boolean(error)} className="text-primary ml-3">기준 저장</button>
   <p>기준은 식별에만 사용합니다. 마지막 업무 로그인 기록과 기존 세션 발급 기록을 확인합니다.</p>
  </form>}
  {(error||saveError)&&<p role="alert" className="text-destructive text-xs">{error||saveError}</p>}
  {loading?<p className="text-sm">불러오는 중…</p>:!error&&<>
   {rows.length?rows.map(row=><ReviewRow key={`${refresh}:${row.id}:${row.version||row.account_status}`} row={row} kind={kind} actorId={user.id} onSaved={reload}/>):<p className="text-sm">검토 대상이 없습니다.</p>}
   <div className="flex gap-3 text-xs"><button disabled={!offset} onClick={()=>setOffset(x=>Math.max(0,x-100))}>이전</button>
    <button disabled={rows.length<100||offset>=1000000} onClick={()=>setOffset(x=>x+100)}>다음</button></div>
  </>}
 </section>;
}
