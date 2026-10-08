import { organizationScopeDescription } from '@/lib/roles';
﻿import { useState,useEffect } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/lib/AuthContext';
import { invokeAppAuth } from '@/lib/appAuth';
import { useRpcAction } from '@/hooks/useRpcAction';
import ConsentModal from './ConsentModal';

export default function RoleRequestForm(){
  const {user}=useAuth();
  const [organizations,setOrganizations]=useState([]),[role,setRole]=useState('operator'),[organization,setOrganization]=useState(''),[reason,setReason]=useState(''),[confirm,setConfirm]=useState(false),[submitted,setSubmitted]=useState(false),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState('');
  const {run,busy,error,unknown}=useRpcAction(()=>{setConfirm(false);setSubmitted(true);});
  useEffect(()=>{const controller=new AbortController();async function load(){try{
    await invokeAppAuth('validate-session');if(controller.signal.aborted)return;
    const [orgs,result]=await Promise.all([
      supabase.rpc('list_role_request_organizations').abortSignal(controller.signal),
      supabase.from('role_requests').select('id').eq('requester_profile_id',user.id).eq('status','pending').abortSignal(controller.signal).maybeSingle(),
    ]);if(orgs.error)throw orgs.error;if(result.error)throw result.error;if(!controller.signal.aborted){setOrganizations(orgs.data || []);setSubmitted(Boolean(result.data));}
  }catch{if(!controller.signal.aborted)setLoadError('권한 요청 정보를 조회하지 못했습니다.');}finally{if(!controller.signal.aborted)setLoading(false);}}
  void load();return()=>controller.abort();},[user.id]);
  const options=organizations;
  return <section className="rounded-lg border border-border bg-card p-5 space-y-3"><h3 className="text-sm font-semibold">권한 변경 요청</h3>
    {(loadError||error)&&<p role="alert" className="text-xs text-destructive">{loadError||error}</p>}
    {submitted?<p className="text-xs text-muted-foreground">요청이 접수되었습니다. 관리자 검토를 기다려 주세요.</p>:<form onSubmit={e=>{e.preventDefault();setConfirm(true);}} className="space-y-3">
      <fieldset disabled={loading||busy||unknown||Boolean(loadError)} className="space-y-3">
        <select required value={organization} onChange={e=>setOrganization(e.target.value)} className="w-full p-2 text-xs bg-accent border border-border rounded"><option value="">접근 가능한 조직 선택</option>{options.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select>
        <p className="text-xs text-muted-foreground">{organizationScopeDescription(options.find(o=>o.id===organization))} 승인 전에는 Ticket을 볼 수 없습니다.</p>
        <select aria-label="요청 역할" value={role} onChange={e=>setRole(e.target.value)} className="w-full p-2 text-xs bg-accent border border-border rounded"><option value="admin">Admin</option><option value="operator">Operator</option></select>
        {role==='admin'&&<p className="text-xs text-muted-foreground">{options.find(o=>o.id===organization)?.type==='operator'?'Company Admin은 전역 사용자·권한 관리 역할입니다.':'Partner Admin은 자기 조직의 사용자·권한만 관리합니다.'} 관리자 검토 후에만 부여됩니다.</p>}
        <textarea required maxLength={2000} value={reason} onChange={e=>setReason(e.target.value)} placeholder="요청 사유" className="w-full p-2 text-xs bg-accent border border-border rounded" />
        <button disabled={!options.some(o=>o.id===organization)||!reason.trim()} className="text-xs text-primary">동의 후 요청</button>
      </fieldset>
    </form>}
    {confirm&&<ConsentModal saving={busy||unknown} onCancel={()=>setConfirm(false)} onAgree={()=>void run('submit_role_request',{p_requested_role:role,p_requested_organization_id:organization,p_justification:reason.trim(),p_consent_agreed:true})} />}
  </section>;
}
