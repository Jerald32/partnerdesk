import { useState,useEffect } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/lib/AuthContext';
import { invokeAppAuth } from '@/lib/appAuth';
import { readRows } from '@/lib/supabaseData';
import { useRpcAction } from '@/hooks/useRpcAction';
import ConsentModal from './ConsentModal';

export default function RoleRequestForm(){
  const {user}=useAuth();
  const [organizations,setOrganizations]=useState([]),[role,setRole]=useState('partner_admin'),[organization,setOrganization]=useState(''),[reason,setReason]=useState(''),[confirm,setConfirm]=useState(false),[submitted,setSubmitted]=useState(false),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState('');
  const {run,busy,error,unknown}=useRpcAction(()=>{setConfirm(false);setSubmitted(true);});
  useEffect(()=>{const controller=new AbortController();async function load(){try{
    await invokeAppAuth('validate-session');if(controller.signal.aborted)return;
    const [orgs,result]=await Promise.all([
      readRows(()=>supabase.from('organizations').select('id,name,type',{count:'exact'}).eq('is_active',true).order('name').order('id'),controller.signal),
      supabase.from('role_requests').select('id').eq('requester_profile_id',user.id).eq('status','pending').abortSignal(controller.signal).maybeSingle(),
    ]);if(result.error)throw result.error;if(!controller.signal.aborted){setOrganizations(orgs);setSubmitted(Boolean(result.data));}
  }catch{if(!controller.signal.aborted)setLoadError('권한 요청 정보를 조회하지 못했습니다.');}finally{if(!controller.signal.aborted)setLoading(false);}}
  void load();return()=>controller.abort();},[user.id]);
  const options=organizations.filter(o=>o.type===(role==='operator'?'operator':'partner'));
  return <section className="rounded-lg border border-border bg-card p-5 space-y-3"><h3 className="text-sm font-semibold">권한 변경 요청</h3>
    {(loadError||error)&&<p role="alert" className="text-xs text-destructive">{loadError||error}</p>}
    {submitted?<p className="text-xs text-muted-foreground">요청이 접수되었습니다. 관리자 검토를 기다려 주세요.</p>:<form onSubmit={e=>{e.preventDefault();setConfirm(true);}} className="space-y-3">
      <fieldset disabled={loading||busy||unknown||Boolean(loadError)} className="space-y-3">
        <select value={role} onChange={e=>{setRole(e.target.value);setOrganization('');}} className="w-full p-2 text-xs bg-accent border border-border rounded"><option value="partner_admin">Partner Admin</option><option value="operator">Operator</option></select>
        <select required value={organization} onChange={e=>setOrganization(e.target.value)} className="w-full p-2 text-xs bg-accent border border-border rounded"><option value="">접근 가능한 조직 선택</option>{options.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select>
        <textarea required maxLength={2000} value={reason} onChange={e=>setReason(e.target.value)} placeholder="요청 사유" className="w-full p-2 text-xs bg-accent border border-border rounded" />
        <button disabled={!options.some(o=>o.id===organization)||!reason.trim()} className="text-xs text-primary">동의 후 요청</button>
      </fieldset>
    </form>}
    {confirm&&<ConsentModal saving={busy||unknown} onCancel={()=>setConfirm(false)} onAgree={()=>void run('submit_role_request',{p_requested_role:role,p_requested_organization_id:organization,p_justification:reason.trim(),p_consent_agreed:true})} />}
  </section>;
}
