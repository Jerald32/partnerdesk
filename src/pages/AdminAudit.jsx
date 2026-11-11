import { isCompanyAdmin } from '@/lib/roles';
import { useEffect,useState } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { supabase } from '@/lib/supabaseClient';
import { invokeAppAuth } from '@/lib/appAuth';
import RoleAudit from '@/components/RoleAudit';
import MonthlyReviewOverview from '@/components/MonthlyReviewOverview';
import {Link} from 'react-router-dom';
import AccessAuditTable from '@/components/AccessAuditTable';
import {enrichAccessRows} from '@/lib/accessAudit';
import AuditBackup from '@/components/AuditBackup';

const TITLES = { access:'접속 기록',role:'권한 변경 이력',deletion:'파기 이력' };
export default function AdminAudit({ kind }) {
  const { user } = useAuth();
  const [rows,setRows] = useState([]),[offset,setOffset] = useState(0),[error,setError] = useState(''),[loading,setLoading] = useState(true);
  const [draft,setDraft] = useState(''),[query,setQuery] = useState('');
  useEffect(()=>setOffset(0),[kind]);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');setRows([]);
    async function load(){try{
      if(!isCompanyAdmin(user)||kind==='role')return;
      await invokeAppAuth('validate-session');if(controller.signal.aborted)return;
      const {data,error}=await (kind==='access'
        ? supabase.rpc('search_admin_access_audit',{p_query:query,p_offset:offset})
        : supabase.rpc('read_admin_audit',{p_kind:kind,p_offset:offset})).abortSignal(controller.signal);
      if(error)throw error;if(!Array.isArray(data?.rows))throw new Error('invalid_response');
      const loaded=kind==='access'?await enrichAccessRows(supabase,data.rows,controller.signal):data.rows.map(row=>Object.fromEntries(Object.entries(row)
        .map(([key,value])=>[key,value&&typeof value==='object'?JSON.stringify(value):value])));
      if(!controller.signal.aborted)setRows(loaded);
    }catch{if(!controller.signal.aborted)setError('기록을 불러오지 못했습니다. 세션과 권한, 서버 RPC 적용 여부를 확인해 주세요.');}
    finally{if(!controller.signal.aborted)setLoading(false);}}
    void load();return()=>controller.abort();
  },[kind,offset,query,user?.id,user?.role]);
  if(!isCompanyAdmin(user))return <p>관리자만 접근할 수 있습니다.</p>;
  if(kind==='role')return <RoleAudit user={user} />;
  const columns=rows.length?Object.keys(rows[0]):[];
  return <div className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className={kind==='access'?'text-2xl font-bold':'text-lg font-semibold'}>{kind==='access'?'접속기록 점검 현황':TITLES[kind]}</h2>
    {kind==='access'&&<Link to="/access-reviews?request=1" className="access-review-request-button">접속기록 점검 승인요청하기</Link>}
    </div>
    {kind==='access'&&<MonthlyReviewOverview/>}
    {kind==='access'&&<AuditBackup/>}
    {kind==='access'&&<h2 className="border-t border-border pt-6 text-2xl font-bold">접속기록</h2>}
    {kind==='access'&&<form className="flex gap-2" onSubmit={e=>{e.preventDefault();setOffset(0);setQuery(draft.trim());}}>
      <input aria-label="감사 기록 검색" maxLength={100} value={draft} onChange={e=>setDraft(e.target.value)}
        placeholder="작업, 사용자·조직·대상 ID, 결과, 요청 ID" className="border rounded px-3 py-2 text-sm w-full bg-background"/>
      <button type="submit" disabled={loading} className="border rounded px-3">검색</button>
    </form>}
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    {kind==='access'?<AccessAuditTable rows={rows} loading={loading} error={error}/>:<div className="rounded-lg border border-border bg-card overflow-x-auto">
      {loading?<p className="p-4">불러오는 중...</p>:rows.length?<table className="w-full text-xs"><thead><tr>{columns.map(c=><th key={c} className="p-3 text-left text-muted-foreground">{c}</th>)}</tr></thead><tbody>{rows.map(row=><tr key={row.id} className="border-t border-border">{columns.map(c=><td key={c} className="p-3">{String(row[c]??'–')}</td>)}</tr>)}</tbody></table>:!error&&<p className="p-4 text-sm text-muted-foreground">기록이 없습니다.</p>}
    </div>}<div className="flex gap-3 text-xs"><button disabled={loading||offset===0} onClick={()=>setOffset(v=>Math.max(0,v-100))}>이전</button><button disabled={loading||rows.length<100||offset>=1000000} onClick={()=>setOffset(v=>v+100)}>다음</button></div>
  </div>;
}
