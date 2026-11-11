import {useEffect,useState} from 'react';
import {supabase} from '@/lib/supabaseClient';
import {invokeAppAuth} from '@/lib/appAuth';
import {auditTime,changeTypeLabel,roleLabel} from '@/lib/roleAudit';

const emptyFilters={query:'',from:'',to:'',type:''};
const inputClass='rounded border border-border bg-background px-3 py-2 text-sm';
function Identity({name,email,source,organization,organizationLabel}) {
 return <div className="space-y-1"><p className="font-medium">{name || '이름 기록 없음'}</p><p className="text-xs text-muted-foreground break-all">{email || '이메일 기록 없음'}</p><p className="text-xs">{organizationLabel}: {organization || '소속 확인 불가'}</p><p className="text-xs text-muted-foreground">{source==='snapshot'?'기록 당시 정보 포함':'이름·이메일: 현재 정보 기준'}</p></div>;
}
export default function RoleAudit({user}) {
 const [draft,setDraft]=useState(emptyFilters),[filters,setFilters]=useState(emptyFilters),[offset,setOffset]=useState(0);
 const [rows,setRows]=useState([]),[hasMore,setHasMore]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
 useEffect(()=>{
  const controller=new AbortController();setLoading(true);setError('');setRows([]);setHasMore(false);
  async function load(){try{
   await invokeAppAuth('validate-session');if(controller.signal.aborted)return;
   const {data,error:failure}=await supabase.rpc('search_admin_role_audit',{p_query:filters.query,p_offset:offset,p_from:filters.from||null,p_to:filters.to||null,p_change_type:filters.type}).abortSignal(controller.signal);
   if(failure||!Array.isArray(data?.rows))throw new Error('load_failed');
   if(!controller.signal.aborted){setRows(data.rows);setHasMore(data.has_more===true);}
  }catch{if(!controller.signal.aborted)setError('권한 변경 이력을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');}
  finally{if(!controller.signal.aborted)setLoading(false);}}
  void load();return()=>controller.abort();
 },[filters,offset,refresh,user.id]);
 const field=(name,value)=>setDraft(previous=>({...previous,[name]:value}));
 return <div className="space-y-4">
  <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">권한 변경 이력</h2><button className={inputClass} disabled={loading} onClick={()=>setRefresh(v=>v+1)}>새로고침</button></div>
  <p className="text-sm text-muted-foreground">누가 누구의 권한·소속을 어떻게 변경했는지 확인합니다. 모든 일시는 한국 시간(KST)입니다.</p>
  <form className="flex flex-wrap items-end gap-3" onSubmit={event=>{event.preventDefault();if(draft.from&&draft.to&&draft.from>draft.to){setError('종료일은 시작일 이후로 선택해 주세요.');return;}setOffset(0);setFilters({...draft,query:draft.query.trim()});}}>
   <label className="grid gap-1 text-xs flex-1 min-w-48">신청자·변경자·대상자·소속 검색<input className={inputClass} maxLength={100} value={draft.query} placeholder="이름, 이메일 또는 소속명" onChange={e=>field('query',e.target.value)}/></label>
   <label className="grid gap-1 text-xs">시작일<input type="date" className={inputClass} value={draft.from} onChange={e=>field('from',e.target.value)}/></label>
   <label className="grid gap-1 text-xs">종료일<input type="date" className={inputClass} value={draft.to} min={draft.from||undefined} onChange={e=>field('to',e.target.value)}/></label>
   <label className="grid gap-1 text-xs">처리 방식<select className={inputClass} value={draft.type} onChange={e=>field('type',e.target.value)}><option value="">전체</option><option value="direct">관리자 직접 변경</option><option value="request_approved">요청 승인</option></select></label>
   <button className={inputClass} disabled={loading}>검색</button><button type="button" className={inputClass} disabled={loading} onClick={()=>{setDraft(emptyFilters);setFilters({...emptyFilters});setOffset(0);}}>초기화</button>
  </form>
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  <p className="text-xs text-muted-foreground">대상자 소속은 변경 후 소속, 변경자 소속은 현재 소속입니다. 소속명은 현재 등록된 명칭입니다. 이름·이메일은 기록 당시 정보를 우선하고, 없는 항목은 현재 정보로 보완합니다.</p>
  <div className="rounded-lg border border-border bg-card overflow-x-auto" aria-busy={loading}>
   <table className="w-full text-sm text-left"><thead className="bg-accent"><tr>{['변경일시 (KST)','변경 대상자 (이름·이메일·소속)','변경 전 권한','변경 후 권한','변경(승인·발급)자 (이름·이메일·소속)','신청자 정보','신청일시 (KST)','신청사유','변경(승인·발급)자 접속 IP','발급사유'].map(label=><th key={label} scope="col" className="p-4 whitespace-nowrap">{label}</th>)}</tr></thead><tbody>{loading?<tr><td colSpan={10} className="p-4"><p role="status">불러오는 중...</p></td></tr>:error?<tr><td colSpan={10} className="p-4 text-muted-foreground">이력을 조회하지 못했습니다. 위 오류 메시지를 확인해 주세요.</td></tr>:!rows.length?<tr><td colSpan={10} className="p-4 text-muted-foreground">조건에 맞는 권한 변경 이력이 없습니다.</td></tr>:rows.map(row=><tr key={row.id} className="border-t border-border">
    <td className="p-4 align-top whitespace-nowrap"><time dateTime={row.changed_at}>{auditTime(row.changed_at)}</time></td>
    <td className="p-4 align-top"><Identity name={row.target_name} email={row.target_email} source={row.target_identity_source} organization={row.organization_after_name} organizationLabel="변경 후 소속"/></td>
    <td className="p-4 align-top whitespace-nowrap">{roleLabel(row.role_before,row.org_type_before)}</td>
    <td className="p-4 align-top whitespace-nowrap"><strong>{roleLabel(row.role_after,row.org_type_after)}</strong></td>
    <td className="p-4 align-top"><Identity name={row.actor_name} email={row.actor_email} source={row.actor_identity_source} organization={row.actor_organization_name} organizationLabel="현재 소속"/><details className="mt-2"><summary className="cursor-pointer text-primary">상세보기</summary><p className="mt-2 text-xs">{changeTypeLabel(row.change_type)}</p><dl className="mt-3 space-y-2 text-xs min-w-56 break-words">
     {Object.entries({'변경 전 권한':roleLabel(row.role_before,row.org_type_before),'변경 후 권한':roleLabel(row.role_after,row.org_type_after),'변경 전 소속':row.organization_before_name,'변경 후 소속':row.organization_after_name,'요청 일시':auditTime(row.requested_at),'신청 사유':row.request_reason,'처리 사유·승인 메모':row.admin_notes,'이력 ID':row.id,'변경자 ID':row.actor_profile_id||row.actor_id,'대상자 ID':row.target_profile_id||row.target_user_id,'변경 전 소속 ID':row.affiliation_before,'변경 후 소속 ID':row.affiliation_after,'권한 요청 ID':row.role_request_id,'처리 경로':row.source_api}).map(([label,value])=><div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="whitespace-pre-wrap break-all">{value||'기록 없음'}</dd></div>)}
    </dl></details></td>
    <td className="p-4 align-top min-w-48">{row.requester_profile_id||row.requester_name||row.requester_email?<Identity name={row.requester_name} email={row.requester_email} source={row.requester_identity_source} organization={row.requester_organization_name} organizationLabel="신청 소속"/>:row.change_type==='direct'?'신청 없음 (직접 변경)':'신청자 기록 없음'}</td>
    <td className="p-4 align-top whitespace-nowrap">{row.requested_at?<time dateTime={row.requested_at}>{auditTime(row.requested_at)}</time>:row.change_type==='direct'?'신청 없음':'기록 없음'}</td>
    <td className="p-4 align-top min-w-48 whitespace-pre-wrap break-words">{row.request_reason||(row.change_type==='direct'?'신청 없음':'기록 없음')}</td>
    <td className="p-4 align-top whitespace-nowrap font-mono">{row.actor_ip||'IP 기록 없음'}</td>
    <td className="p-4 align-top min-w-48 whitespace-pre-wrap break-words">{row.issue_reason||row.admin_notes||'기록 없음'}{!row.issue_reason&&row.admin_notes&&<p className="mt-1 text-xs text-muted-foreground">승인 메모 기준</p>}</td>
   </tr>)}</tbody></table>
  </div>
  <div className="flex items-center gap-4 text-sm"><button disabled={loading||offset===0} onClick={()=>setOffset(v=>Math.max(0,v-100))}>이전</button><span>{Math.floor(offset/100)+1}페이지 · {rows.length}건</span><button disabled={loading||!hasMore||offset>=1000000} onClick={()=>setOffset(v=>v+100)}>다음</button></div>
 </div>;
}
