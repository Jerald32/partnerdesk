import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {supabase} from '@/lib/supabaseClient';
import {invokeAppAuth} from '@/lib/appAuth';
import {reviewStatus} from '@/lib/accessReview';
import {auditTime} from '@/lib/roleAudit';

export function MonthlyReviewSummary({summary,loading,error}) {
 const unavailable=!loading&&(error||!Array.isArray(summary));
 const records=Array.isArray(summary)?summary.filter(row=>row.id):[];
 return <section className="rounded-lg border border-border bg-card p-4 space-y-3" aria-label="월별 점검 기본 현황">
  <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">월별 점검 기본 현황 · 최근 3개월</h3><Link to="/access-reviews?view=all" className="inline-flex items-center rounded-md border-2 border-blue-400 bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500">전체보기</Link></div>
  <p className="text-xs text-muted-foreground">전월까지 최근 3개월 중 실제 점검 요청 이력이 있는 월만 표시합니다.</p>
  {unavailable&&<p role="alert" className="text-sm text-destructive">월별 점검 데이터를 조회하지 못했습니다. 연결 상태를 확인하고 다시 조회해 주세요.</p>}
  <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{['점검 대상 월','점검 상태','요청일시 (KST)','승인자','처리일시 (KST)','상세'].map(label=><th key={label} scope="col" className="p-3 whitespace-nowrap">{label}</th>)}</tr></thead><tbody>{loading?<tr><td colSpan={6} className="p-3">불러오는 중…</td></tr>:unavailable?<tr><td colSpan={6} className="p-3">조회 실패</td></tr>:!records.length?<tr><td colSpan={6} className="p-3 text-muted-foreground">최근 3개월 점검 이력이 없습니다.</td></tr>:records.map(row=>{
   return <tr key={row.id} className="border-t border-border"><td className="p-3 whitespace-nowrap">{row.review_month.slice(0,7)}</td><td className="p-3 whitespace-nowrap">{reviewStatus(row.status)}</td><td className="p-3 whitespace-nowrap">{row.requested_at?auditTime(row.requested_at):'–'}</td><td className="p-3">{row.approver_name||'–'}{row.approver_email&&<p className="text-xs text-muted-foreground">{row.approver_email}</p>}</td><td className="p-3 whitespace-nowrap">{row.decided_at?auditTime(row.decided_at):'–'}</td><td className="p-3"><Link to={'/access-reviews/'+row.id} className="text-primary">상세보기</Link></td></tr>;
  })}</tbody></table></div>
 </section>;
}

export default function MonthlyReviewOverview() {
 const [summary,setSummary]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(false),[refresh,setRefresh]=useState(0);
 useEffect(()=>{
  const controller=new AbortController();setLoading(true);setError(false);setSummary(null);
  async function load(){try{
   await invokeAppAuth('validate-session');if(controller.signal.aborted)return;
   const {data,error}=await supabase.rpc('list_access_reviews',{p_offset:0,p_scope:'recent'}).abortSignal(controller.signal);
   if(error||!Array.isArray(data?.monthly_summary))throw new Error('invalid_summary');
   if(!controller.signal.aborted)setSummary(data.monthly_summary);
  }catch{if(!controller.signal.aborted)setError(true);}finally{if(!controller.signal.aborted)setLoading(false);}}
  void load();return()=>controller.abort();
 },[refresh]);
 return <div className="space-y-2"><MonthlyReviewSummary summary={summary} loading={loading} error={error}/><button type="button" className="rounded border border-border px-3 py-2 text-sm disabled:opacity-50" disabled={loading} onClick={()=>setRefresh(v=>v+1)}>기본 현황 새로고침</button></div>;
}
