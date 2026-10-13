import {useEffect,useState} from 'react';
import {supabase} from '@/lib/supabaseClient';
import {useRpcAction} from '@/hooks/useRpcAction';

export default function IpWhitelistManager(){
 const [recoveryApproved,setRecoveryApproved]=useState(false);
 const [policy,setPolicy]=useState(null),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
 const [editing,setEditing]=useState(null),[ip,setIP]=useState(''),[description,setDescription]=useState(''),[active,setActive]=useState(true);
 const reload=()=>setRefresh(x=>x+1);const {run,busy,error:saveError,unknown}=useRpcAction(reload);
 useEffect(()=>{const controller=new AbortController();async function load(){try{
  const {data,error}=await supabase.rpc('read_ip_policy').abortSignal(controller.signal);if(error||!Array.isArray(data?.rows))throw error||new Error();
  if(!controller.signal.aborted){setPolicy(data);setError('');}
 }catch{if(!controller.signal.aborted)setError('IP 정책을 조회하지 못했습니다. 로그인·관리자 권한을 확인해 주세요.');}}void load();return()=>controller.abort();},[refresh]);
 return <section className="rounded-lg border bg-card p-4 space-y-3 text-sm">
  <h3 className="font-semibold">공통 IP 화이트리스트</h3>
  {policy&&<><p>상태: {policy.mode==='monitor'?'모니터링 · 실제 IP 차단 비활성':'IP 차단 활성'}{policy.pending&&' · 재로그인 후 10분 내 재확인 필요'}</p>
   <p className="text-xs text-muted-foreground">현재 서버 판별 IP: {policy.current_ip||'확인 불가'} · 모든 조직 공통 적용</p>
   <form className="flex flex-wrap gap-2" onSubmit={e=>{e.preventDefault();void run('save_ip_entry',{p_id:editing,p_ip:ip.trim(),p_description:description.trim()||null,p_active:active,p_expected_version:policy.version},data=>Boolean(data?.id));}}>
    <input aria-label="허용 IP 또는 CIDR" required maxLength={64} value={ip} onChange={e=>setIP(e.target.value)} placeholder="IPv4 / IPv6 / CIDR" className="border rounded bg-background p-2"/>
    <input aria-label="IP 설명" maxLength={200} value={description} onChange={e=>setDescription(e.target.value)} placeholder="설명" className="border rounded bg-background p-2"/>
    <label><input type="checkbox" checked={active} onChange={e=>setActive(e.target.checked)}/> 사용</label>
    <button disabled={busy||unknown||policy.pending} className="text-primary">{editing?'수정 저장':'추가'}</button>
    {editing&&<button type="button" onClick={()=>{setEditing(null);setIP('');setDescription('');setActive(true);}}>추가로 전환</button>}
   </form>
   <div className="space-y-2">{policy.rows.map(row=><div key={row.id} className="flex gap-3 text-xs"><span>{row.ip_address} · {row.description} · {row.is_active?'사용':'비활성'}</span>
    <button onClick={()=>{setEditing(row.id);setIP(row.ip_address);setDescription(row.description||'');setActive(row.is_active);}}>수정·비활성화</button></div>)}</div>
   <div className="border rounded p-3 space-y-2">
    <p>단일 사무실 복구: Supabase SQL Editor에서 운영자 권한 검증 SQL을 실행한 후 확인합니다. 화면 접근만으로는 검증되지 않습니다.</p>
    <p>운영자 검증: {policy.operator_recovery?'확인됨 (7일 유효)':'미확인'} · 관리자 승인: {policy.operator_recovery_ready?'확인됨 (24시간 유효)':'미확인'}</p>
    <label className="flex gap-2"><input type="checkbox" checked={recoveryApproved} onChange={e=>setRecoveryApproved(e.target.checked)}/>비상 복구 SQL과 실행 순서를 확인했고, 독립된 Supabase 운영자 접근 수단을 확보했습니다.</label>
    <button disabled={busy||unknown||!policy.operator_recovery||!recoveryApproved} onClick={()=>void run('acknowledge_ip_operator_recovery',{p_id:policy.operator_recovery.id,p_approved:true},data=>Boolean(data?.id))}>복구 절차 명시적 승인</button>
   </div>
   <div className="flex flex-wrap gap-3 text-xs">
    <button disabled={busy||unknown} onClick={()=>{if(window.confirm('현재 접속 경로를 복구 경로로 확인합니다. 별도 고정 IP/VPN에서도 관리자 로그인 후 이 확인을 실행해 주세요.'))void run('confirm_ip_recovery_path',{});}}>현재 복구 경로 확인</button>
    {policy.mode==='monitor'&&<button disabled={busy||unknown||policy.pending} onClick={()=>{if(window.confirm('모든 조직의 IP 차단을 실제 활성화합니다. 별도 승인을 받은 경우에만 진행하세요. 재로그인 후 10분 안에 확인하지 않으면 복귀합니다.'))void run('request_ip_activation',{p_expected_version:policy.version});}}>별도 승인 후 활성화 요청</button>}
    {policy.pending&&<button disabled={busy||unknown} onClick={()=>void run('confirm_ip_transition',{})}>재로그인 후 정책 확정</button>}
    <button onClick={reload}>새로고침</button>
   </div>
   <p className="text-xs text-muted-foreground">허용 목록과 현재 IP 일치가 필요합니다. 독립된 Supabase 복구 권한 검증 및 관리자 승인, 또는 다른 허용 IP에서 확인한 복구 경로가 있어야 활성화할 수 있습니다.</p>
  </>}
  {(error||saveError)&&<p role="alert" className="text-destructive">{error||saveError}</p>}
 </section>;
}
