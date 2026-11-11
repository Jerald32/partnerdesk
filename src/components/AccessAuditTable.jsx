import {auditTime} from '@/lib/roleAudit';
import {accessAction,accessIdentity,accessMetadata,accessResult,accessTarget} from '@/lib/accessAudit';

export default function AccessAuditTable({rows,loading,error}) {
 return <div className="rounded-lg border border-border bg-card overflow-x-auto" aria-busy={loading}>
  <table className="w-full text-sm text-left"><thead className="bg-accent"><tr>{['접속일시 (KST)','접속 사용자','접속 IP','수행한 업무','처리 대상','처리 결과','상세보기'].map(label=><th key={label} scope="col" className="p-4 whitespace-nowrap">{label}</th>)}</tr></thead><tbody>
   {loading?<tr><td colSpan={7} className="p-4" role="status">불러오는 중…</td></tr>:error?<tr><td colSpan={7} className="p-4 text-muted-foreground">접속기록을 조회하지 못했습니다.</td></tr>:!rows.length?<tr><td colSpan={7} className="p-4 text-muted-foreground">조건에 맞는 접속기록이 없습니다.</td></tr>:rows.map(row=>{
    const identity=accessIdentity(row),metadata=accessMetadata(row);
    const details={'원본 로그 ID':row.id,'사용자 계정 ID':identity.accountId,'인증 계정 ID':metadata.auth_user_id,'기록 당시 조직 ID':row.organization_id||metadata.organization_id,
     '현재 조직 ID':row.current_organization_id,'기록 당시 역할':row.user_role,'수행업무 원본 코드':row.action,'처리 결과 원본 코드':row.result??metadata.result,
     '처리 대상 원본 유형':row.target_type,'처리 대상 원본 ID':row.target_id,'정보주체 식별정보':row.subject_info,'요청 ID':row.request_id||metadata.request_id,
     '접속 IP 미기록 사유':row.ip_unavailable_reason||metadata.ip_unavailable_reason,'기록 순번':row.seq,'원본 기록 해시':row.record_hash,'이전 기록 해시':row.prev_hash,'원본 상세 내용':row.detail};
    return <tr key={row.id} className="border-t border-border">
     <td className="p-4 align-top whitespace-nowrap"><time dateTime={row.accessed_at}>{auditTime(row.accessed_at)}</time></td>
     <td className="p-4 align-top min-w-64 space-y-1"><p className="font-semibold">{identity.name}</p>{!identity.system&&<><p className="text-xs text-muted-foreground">이름: {identity.nameSource}</p><p className="break-all">{identity.email}</p><p className="text-xs text-muted-foreground">이메일: {identity.emailSource}</p></>}<p>소속: {identity.organization}</p><p className="text-xs text-muted-foreground">소속: {identity.organizationSource}</p><p className="text-xs break-all">계정 ID: {identity.accountId}</p>{row.identity_lookup_failed&&<p className="text-xs text-destructive">현재 사용자·소속 정보 일부를 조회하지 못했습니다.</p>}</td>
     <td className="p-4 align-top whitespace-nowrap font-mono">{row.user_ip||'IP 기록 없음'}</td>
     <td className="p-4 align-top min-w-40">{accessAction(row.action)}</td>
     <td className="p-4 align-top min-w-40"><p>{accessTarget(row.target_type)}</p>{row.target_id&&<p className="mt-1 text-xs text-muted-foreground break-all">대상 ID: {row.target_id}</p>}</td>
     <td className="p-4 align-top whitespace-nowrap"><span className="inline-block rounded border border-border bg-accent px-2 py-1 text-xs font-medium">{accessResult(row)}</span></td>
     <td className="p-4 align-top"><details><summary className="cursor-pointer whitespace-nowrap text-primary">상세보기</summary><dl className="mt-3 space-y-2 min-w-64 text-xs">{Object.entries(details).map(([label,value])=><div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="whitespace-pre-wrap break-all">{value??'기록 없음'}</dd></div>)}</dl><p className="mt-3 text-xs text-muted-foreground">원본 metadata</p><pre className="mt-1 max-w-xl max-h-80 overflow-auto rounded border border-border bg-background p-3 text-xs whitespace-pre-wrap break-all">{typeof row.metadata==='string'?row.metadata:JSON.stringify(row.metadata??{},null,2)}</pre></details></td>
    </tr>;
   })}
  </tbody></table>
 </div>;
}
