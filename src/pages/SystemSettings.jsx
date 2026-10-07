import { useState,useEffect } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { supabase } from '@/lib/supabaseClient';
import { invokeAppAuth } from '@/lib/appAuth';
import { readRows } from '@/lib/supabaseData';

export default function SystemSettings(){
  const {user}=useAuth();const [settings,setSettings]=useState([]),[ips,setIps]=useState([]),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  useEffect(()=>{const controller=new AbortController();async function load(){try{
    if(user?.role!=='admin')return;await invokeAppAuth('validate-session');if(controller.signal.aborted)return;
    const [settings,ips]=await Promise.all([
      readRows(()=>supabase.from('system_settings').select('id,key,value',{count:'exact'}).order('key').order('id'),controller.signal),
      readRows(()=>supabase.from('ip_whitelist').select('id,ip_address,description,is_active',{count:'exact'}).order('id'),controller.signal),
    ]);if(!controller.signal.aborted){setSettings(settings);setIps(ips);}
  }catch{if(!controller.signal.aborted)setError('설정을 조회하지 못했습니다. 세션과 권한을 확인해 주세요.');}finally{if(!controller.signal.aborted)setLoading(false);}}
  void load();return()=>controller.abort();},[user?.id,user?.role]);
  return <div className="max-w-2xl space-y-4"><h2 className="text-lg font-semibold">설정</h2>
    <div className="rounded-lg border border-border bg-card p-4 text-sm">Ticket 상태: 신규 / 진행중 / 보류 / 완료<br />기본 SLA: 24시간. Business별 Partner SLA는 Business 상세에서 관리합니다.</div>
    {user?.role==='admin'&&<><p className="text-xs text-muted-foreground">인증·MFA·IP 설정은 조회 전용입니다.</p>
      {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
      {loading?<p>불러오는 중...</p>:<><div className="rounded-lg border border-border bg-card p-4 space-y-2">{settings.map(row=><p key={row.id} className="text-xs"><span className="text-muted-foreground">{row.key}</span> · {row.value}</p>)}</div>
      <div className="rounded-lg border border-border bg-card p-4"><h3 className="text-sm mb-2">IP 목록</h3>{ips.map(row=><p key={row.id} className="text-xs">{row.ip_address} · {row.description} · {row.is_active?'활성':'비활성'}</p>)}</div></>}
    </>}
  </div>;
}
