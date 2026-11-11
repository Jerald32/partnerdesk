import {useEffect,useRef,useState} from 'react';
import {supabase} from '@/lib/supabaseClient';
import {invokeAppAuth} from '@/lib/appAuth';
import {backupDates,backupDigest,backupError,prepareBackup,validateBackupFile} from '@/lib/auditBackup';

const control='rounded border border-border bg-background px-3 py-2 text-sm';
export default function AuditBackup() {
 const [from,setFrom]=useState(()=>backupDates().yesterday),[to,setTo]=useState(()=>backupDates().yesterday),[reason,setReason]=useState('정기 접속기록 백업');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[prepared,setPrepared]=useState(null),[saved,setSaved]=useState(false),[confirmed,setConfirmed]=useState(false),[verification,setVerification]=useState('');
 const pending=useRef(false),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 async function run(action){if(pending.current)return;pending.current=true;setBusy(true);setError('');try{
  await invokeAppAuth('validate-session');await action();
 }catch(error){if(mounted.current)setError(backupError(error));}finally{pending.current=false;if(mounted.current)setBusy(false);}}
 async function download(){setPrepared(null);setSaved(false);setConfirmed(false);setVerification('');
  const {data,error}=await supabase.rpc('export_access_backup',{p_from:from,p_to:to,p_reason:reason});if(error)throw error;
  const result=await prepareBackup(data);if(!mounted.current)return;
  const blob=new Blob([JSON.stringify(result.envelope,null,2)],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');
  try{link.href=url;link.download=result.filename;document.body.appendChild(link);link.click();}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  setPrepared(result);
 }
 async function confirm(){if(!prepared||!saved)return;
  const {data,error}=await supabase.rpc('confirm_access_backup_storage',{p_export_id:prepared.envelope.export_id,p_sha256:prepared.envelope.payload_sha256});
  if(error)throw error;if(data?.confirmed!==true)throw new Error('invalid_response');if(mounted.current)setConfirmed(true);
 }
 async function check(file){setVerification('');if(file.size>8388608)throw new Error('invalid_backup');
  const envelope=JSON.parse(await file.text());await validateBackupFile(envelope);
  const {data,error}=await supabase.rpc('verify_access_backup',{p_export_id:envelope.export_id,p_sha256:await backupDigest(envelope.payload_json)});
  if(error)throw error;if(data?.verified!==true)throw new Error('backup_checksum_mismatch');
  if(mounted.current)setVerification('파일 내 기록 건수·체크섬과 서버의 백업 발급 기록이 일치합니다.');
 }
 return <section className="rounded-lg border border-border bg-card p-4 space-y-3" aria-label="사내 보관용 접속기록 백업">
  <h3 className="font-semibold">사내 저장장치 백업</h3>
  <p className="text-sm text-muted-foreground">선택 기간의 전체 접속기록 원본과 관련 점검·승인 이력을 JSON 파일로 내려받습니다. 현재 목록의 검색·페이지 조건은 적용하지 않습니다.</p>
  <p className="text-xs text-muted-foreground">브라우저의 다운로드 저장 위치 확인 설정을 켜고 회사 저장장치를 선택해 주세요. DRM 적용 여부와 실제 저장 위치는 앱에서 자동 확인할 수 없습니다.</p>
  <form className="flex flex-wrap items-end gap-3" onSubmit={e=>{e.preventDefault();void run(download);}}>
   <label className="grid gap-1 text-xs">백업 시작일<input className={control} required type="date" min="2000-01-01" max={backupDates().today} value={from} onChange={e=>setFrom(e.target.value)} disabled={busy}/></label>
   <label className="grid gap-1 text-xs">백업 종료일<input className={control} required type="date" min={from} max={backupDates().today} value={to} onChange={e=>setTo(e.target.value)} disabled={busy}/></label>
   <label className="grid gap-1 text-xs flex-1 min-w-48">백업 사유<input className={control} required maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)} disabled={busy}/></label>
   <button className="access-review-request-button" disabled={busy||!reason.trim()}>{busy?'처리 중…':'사내 보관용 백업 다운로드'}</button>
  </form>
  <p className="text-xs text-muted-foreground">한 번에 최대 31일·접속기록 10,000건·원본 데이터 2MiB까지 지원합니다. 한도 초과 시 일부만 저장하지 않고 다운로드를 중단합니다.</p>
  {prepared&&<div className="rounded border border-border p-3 space-y-2 text-sm"><p>다운로드를 요청했습니다. 실제 파일 보관은 회사 저장장치에서 확인해 주세요.</p><p>파일명: <span className="break-all">{prepared.filename}</span></p><p>접속기록 {prepared.payload.counts.access_logs}건 · 점검 요청 {prepared.payload.counts.access_reviews}건 · 승인/반려 등 처리 {prepared.payload.counts.access_review_decisions}건</p><p className="text-xs break-all">원본 SHA-256: {prepared.envelope.payload_sha256}</p><label className="flex items-start gap-2"><input type="checkbox" checked={saved} onChange={e=>setSaved(e.target.checked)} disabled={busy||confirmed}/>회사 내부 저장장치에 파일이 저장되었고 DRM이 적용된 것을 확인했습니다.</label><button className={control} type="button" disabled={!saved||busy||confirmed} onClick={()=>void run(confirm)}>{confirmed?'보관 확인 기록됨':'사내 보관 확인 기록'}</button><p className="text-xs text-muted-foreground">보관 확인은 관리자의 확인 진술로 기록되며, 앱이 파일 저장이나 DRM 상태를 검증했다는 뜻은 아닙니다.</p></div>}
  <label className="block text-sm">저장한 백업 파일 무결성 확인<input type="file" accept=".json,application/json" className="mt-1 block text-sm" disabled={busy} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void run(()=>check(file));}}/></label>
  {verification&&<p role="status" className="text-sm text-primary">{verification}</p>}
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
 </section>;
}
