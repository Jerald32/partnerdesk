import {useEffect,useState} from 'react';
import {supabase} from '@/lib/supabaseClient';
import {useRpcAction} from '@/hooks/useRpcAction';

function policyError(error){
 const reasons={
  recovery_path_required:'현재 IP와 허용 목록을 확인해 주세요. 복구 확인이 없거나 만료됐다면 고급 설정에서 다시 확인해야 합니다.',
  operator_recovery_not_verified:'운영자 복구 확인이 없거나 7일 유효기간이 지났습니다. 고급 설정에서 다시 확인해 주세요.',
  explicit_approval_required:'복구 절차 확인에 명시적으로 동의해 주세요.',
  administrator_lockout_risk:'관리자 또는 복구 경로가 차단될 수 있어 변경하지 않았습니다. 허용 IP와 복구 확인을 점검해 주세요.',
  reauthentication_required:'활성화 요청 후 다시 로그인한 다음 10분 안에 정책을 확인해 주세요.',
  policy_confirmation_required:'진행 중인 정책 변경을 먼저 확인하거나 IP 차단을 꺼 주세요.',
  invalid_transition:'정책 상태가 변경됐습니다. 새로고침 후 현재 상태를 확인해 주세요.',
  recovery_ip_not_allowlisted:'현재 IP를 허용 목록에 먼저 등록해 주세요.',
 };
 return reasons[error.message]||(error.code==='42501'?'Company Admin 권한과 로그인 상태를 확인해 주세요.':undefined);
}
const identity=value=>value.trim().replace(/\/(32|128)$/,'');
const button='rounded-md border px-4 py-2 min-h-10 disabled:opacity-50';

export default function IpWhitelistManager(){
 const [revision,setRevision]=useState(0);
 return <IpWhitelistPanel key={revision} onReload={()=>setRevision(value=>value+1)}/>;
}
export function IpWhitelistPanel({onReload}){
 const [policy,setPolicy]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[refresh,setRefresh]=useState(0);
 const [editing,setEditing]=useState(null),[ip,setIP]=useState(''),[description,setDescription]=useState(''),[active,setActive]=useState(true);
 const [recoveryApproved,setRecoveryApproved]=useState(false),[notice,setNotice]=useState('');
 const clearForm=()=>{setEditing(null);setIP('');setDescription('');setActive(true);setRecoveryApproved(false);};
 const {run,busy,error:saveError,unknown}=useRpcAction(()=>{clearForm();setLoading(true);setRefresh(value=>value+1);},policyError);
 useEffect(()=>{
  const controller=new AbortController();
  async function load(){try{
   const {data,error}=await supabase.rpc('read_ip_policy').abortSignal(controller.signal);
   if(error||!Array.isArray(data?.rows))throw error||new Error();
   if(!controller.signal.aborted){setPolicy(data);setError('');}
  }catch{if(!controller.signal.aborted)setError('IP 설정을 조회하지 못했습니다. 로그인과 Company Admin 권한을 확인해 주세요.');}
  finally{if(!controller.signal.aborted)setLoading(false);}}
  void load();return()=>controller.abort();
 },[refresh]);
 const locked=busy||unknown||loading;
 async function save(event){
  event.preventDefault();setNotice('');
  if(!editing&&policy.rows.some(row=>identity(row.ip_address)===identity(ip))){setNotice('이미 등록된 IP입니다. 목록에서 수정해 주세요.');return;}
  const ok=await run('save_ip_entry',{p_id:editing,p_ip:ip.trim(),p_description:description.trim()||null,p_active:active,p_expected_version:policy.version});
  if(ok)setNotice('IP 설정을 저장했습니다. 차단 상태는 변경하지 않았습니다.');
 }
 async function remove(row){
  if(!window.confirm('이 IP를 삭제하시겠습니까? 사용을 중지하며 복구와 감사 이력은 보존합니다.'))return;
  const ok=await run('save_ip_entry',{p_id:row.id,p_ip:row.ip_address,p_description:row.description,p_active:false,p_expected_version:policy.version});
  if(ok)setNotice('삭제 처리했습니다. 복구를 위해 사용 중지된 항목으로 보관합니다.');
 }
 return <section className="rounded-lg border bg-card p-4 sm:p-6 space-y-5 text-sm">
  <div className="flex flex-wrap items-start justify-between gap-3">
   <div><h3 className="font-semibold text-base">IP 화이트리스트</h3>
    {policy&&<><p className="mt-2 font-medium">IP 차단: {policy.mode==='enforced'?'켜짐':'꺼짐'}</p>
     <p className="mt-1 text-muted-foreground break-all">현재 접속 IP: {policy.current_ip||'확인 불가'}</p></>}
   </div>
   <button type="button" className={button} disabled={busy||loading} onClick={onReload}>새로고침</button>
  </div>
  {loading&&<p role="status">IP 설정을 불러오는 중입니다.</p>}
  {policy&&<>
   {policy.pending&&<div role="status" className="rounded-md border p-3">정책 변경 확인이 필요합니다. 다시 로그인한 뒤 10분 안에 확인하지 않으면 다음 요청에서 이전 정책으로 돌아갑니다.
    <button type="button" className={`${button} mt-2 block w-full sm:w-auto`} disabled={locked} onClick={()=>void run('confirm_ip_transition',{})}>재로그인 후 정책 확인</button>
   </div>}
   <form onSubmit={save} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
    <h4 className="font-medium sm:col-span-2">{editing?'IP 수정':'IP 등록'}</h4>
    <label className="min-w-0">IP 또는 CIDR<input required maxLength={64} value={ip} disabled={locked} onChange={event=>setIP(event.target.value)} placeholder="예: 211.234.206.63/32" className="mt-1 w-full min-w-0 rounded-md border bg-background p-2"/></label>
    <label className="min-w-0">설명<input maxLength={200} value={description} disabled={locked} onChange={event=>setDescription(event.target.value)} placeholder="예: 장안동 사무실" className="mt-1 w-full min-w-0 rounded-md border bg-background p-2"/></label>
    {editing&&<label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" checked={active} disabled={locked} onChange={event=>setActive(event.target.checked)}/>사용</label>}
    <div className="flex flex-col sm:flex-row gap-2 sm:col-span-2">
     <button type="submit" className={`${button} bg-primary text-primary-foreground`} disabled={locked||policy.pending}>저장</button>
     {editing&&<button type="button" className={button} disabled={locked} onClick={clearForm}>수정 취소</button>}
    </div>
   </form>
   <div className="space-y-2"><h4 className="font-medium">등록된 IP</h4>
    {!policy.rows.length&&<p className="text-muted-foreground">등록된 IP가 없습니다.</p>}
    {policy.rows.map(row=><div key={row.id} className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border p-3">
     <div className="min-w-0"><p className="font-medium break-all">{row.ip_address}</p><p className="break-words text-muted-foreground">{row.description||'설명 없음'}</p><p className="mt-1 text-xs">{row.is_active?'사용 중':'사용 중지'}</p></div>
     <div className="grid grid-cols-2 gap-2">
      <button type="button" className={button} disabled={locked||policy.pending} onClick={()=>{setEditing(row.id);setIP(row.ip_address);setDescription(row.description||'');setActive(row.is_active);setNotice('');}}>수정</button>
      <button type="button" className={button} disabled={locked||policy.pending||!row.is_active} onClick={()=>void remove(row)}>삭제</button>
     </div>
    </div>)}
   </div>
   <div className="border-t pt-4 space-y-2">
    <button type="button" className={`${button} w-full sm:w-auto ${policy.mode==='monitor'?'bg-primary text-primary-foreground':''}`} disabled={locked||(policy.mode==='monitor'&&policy.pending)} onClick={()=>{
     if(policy.mode==='monitor'){
      if(window.confirm('모든 조직의 IP 차단을 켜시겠습니까? 허용 IP와 복구 확인을 서버에서 검사합니다. 활성화 후 다시 로그인하여 10분 안에 정책을 확인해야 합니다.'))void run('request_ip_activation',{p_expected_version:policy.version});
     }else if(window.confirm('IP 차단을 끄시겠습니까? 허용 목록과 직접 Supabase 접근 차단은 유지합니다.'))void run('disable_ip_policy',{p_expected_version:policy.version});
    }}>{policy.mode==='monitor'?'IP 차단 켜기':'IP 차단 끄기'}</button>
    <p className="text-xs text-muted-foreground">IP 저장과 차단 상태는 별도로 관리합니다. 모든 조직에 공통 적용됩니다.</p>
   </div>
   <details className="border-t pt-3"><summary className="cursor-pointer font-medium">고급 설정 / 복구 안내</summary>
    <div className="mt-3 space-y-3">
     <p>차단을 켜려면 현재 IP가 허용 목록에 포함되고, 독립된 Supabase 복구 확인 및 관리자 승인 또는 다른 허용 IP의 복구 접속 확인이 필요합니다.</p>
     <p>운영자 복구 확인은 7일, 관리자 승인은 24시간 유효합니다. 기간이 지나면 다시 확인해야 합니다.</p>
     <p>운영자 검증: {policy.operator_recovery?'확인됨':'미확인 또는 만료'} · 관리자 승인: {policy.operator_recovery_ready?'확인됨':'미확인 또는 만료'}</p>
     <p>Supabase SQL Editor에서 postgres 역할로 아래 검증을 실행하세요. 화면에 접근하는 것만으로는 확인되지 않습니다.</p>
     <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">SELECT private.verify_ip_operator_recovery('운영기록-참조번호');</pre>
     <p>IP 차단으로 접속할 수 없으면 SQL Editor에서 다음 복구 SQL을 전체 실행합니다. 직접 접근 차단(enabled), RLS와 MFA는 변경하지 않습니다.</p>
     <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">{`BEGIN ISOLATION LEVEL READ COMMITTED;
UPDATE private.gateway_config
SET mode='monitor', pending=NULL, version=version+1 WHERE id=true;
SELECT audit.append_access_log(
 p_action=>'ip_policy_emergency_recovered', p_target_type=>'IPPolicy',
 p_metadata=>jsonb_build_object('source','supabase_sql_editor',
 'incident_reference','운영기록-참조번호',
 'ip_unavailable_reason','sql_editor_has_no_verified_gateway_client_ip'));
COMMIT;`}</pre>
     <p>오류가 나면 ROLLBACK을 실행하고 운영자에게 확인하세요. 복구 실행자·시각·사유는 별도 운영 기록에도 남겨 주세요.</p>
     <label className="flex items-start gap-2"><input type="checkbox" checked={recoveryApproved} disabled={locked} onChange={event=>setRecoveryApproved(event.target.checked)}/>비상 복구 절차와 독립된 Supabase 운영자 접근 수단을 확인했습니다.</label>
     <button type="button" className={button} disabled={locked||!policy.operator_recovery||!recoveryApproved} onClick={()=>void run('acknowledge_ip_operator_recovery',{p_id:policy.operator_recovery.id,p_approved:true})}>복구 절차 승인</button>
     <div><button type="button" className={button} disabled={locked} onClick={()=>{if(window.confirm('현재 허용 IP의 복구 접속을 확인합니다. 두 번째 IP 방식은 다른 허용 IP에서도 확인해야 합니다.'))void run('confirm_ip_recovery_path',{});}}>현재 복구 접속 확인</button></div>
    </div>
   </details>
  </>}
  {notice&&<p role="status">{notice}</p>}
  {(error||saveError)&&<p role="alert" className="text-destructive">{error||saveError}</p>}
 </section>;
}
