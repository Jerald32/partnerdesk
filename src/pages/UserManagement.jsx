import { canManageUsers, isCompanyAdmin } from '@/lib/roles';
import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { supabase } from '@/lib/supabaseClient';
import { invokeAppAuth } from '@/lib/appAuth';
import { readRows } from '@/lib/supabaseData';
import { useRpcAction } from '@/hooks/useRpcAction';
import UserAccessRow from '@/components/users/UserAccessRow';

function RequestRow({ request, onSaved }) {
  const { run,busy,error,unknown } = useRpcAction(onSaved);
  return <div className="p-4 border-b border-border space-y-2">
    <p className="text-sm">{request.requester_name_snapshot || request.requester_email_snapshot} · {request.requested_role} · {request.company}</p>
    <p className="text-xs text-muted-foreground whitespace-pre-wrap">{request.justification}</p>
    <div className="flex gap-3 text-xs">
      <button disabled={busy || unknown} className="text-primary" onClick={() => {
        if (window.confirm('요청한 조직과 역할로 승인하시겠습니까?')) void run('approve_role_request', { p_role_request_id: request.id,p_organization_id: request.requested_organization_id,p_admin_notes: null }, data => data?.role_request_id === request.id && data.status === 'approved');
      }}>승인</button>
      <button disabled={busy || unknown} onClick={() => { const note = window.prompt('거절 사유'); if (note !== null) void run('reject_role_request',{p_role_request_id:request.id,p_admin_notes:note || null}); }}>거절</button>
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>;
}

export default function UserManagement() {
  const { user,checkUserAuth } = useAuth();
  const [profiles,setProfiles] = useState([]),[organizations,setOrganizations] = useState([]),[requests,setRequests] = useState([]);
  const [loading,setLoading] = useState(true),[error,setError] = useState(''),[refresh,setRefresh] = useState(0),[filter,setFilter] = useState(''),[tab,setTab] = useState('users');
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    async function load() {
      try {
        if (!canManageUsers(user)) return;
        await invokeAppAuth('validate-session'); if (controller.signal.aborted) return;
        const [profiles,orgs,requests,relations] = await Promise.all([
          readRows(() => supabase.from('profiles').select('id,full_name,display_name,email,role,organization_id,account_status,updated_at',{count:'exact'}).order('id'),controller.signal),
          readRows(() => supabase.from('organizations').select('id,name,type,is_active,partner_details(organization_id)',{count:'exact'}).order('name').order('id'),controller.signal),
          readRows(() => supabase.from('role_requests').select('id,requester_name_snapshot,requester_email_snapshot,requested_role,requested_organization_id,company,justification,status',{count:'exact'}).eq('status','pending').order('created_at').order('id'),controller.signal),
          readRows(() => supabase.from('service_partners').select('id,business_id,partner_organization_id,access_level,business:businesses(name)',{count:'exact'}).order('id'),controller.signal),
        ]);
        if (!controller.signal.aborted) {setProfiles(profiles);setOrganizations(orgs.map(org=>({...org,access_relations:relations.filter(relation=>relation.partner_organization_id===org.id)})));setRequests(requests);}
      } catch { if (!controller.signal.aborted) setError('사용자 정보를 불러오지 못했습니다. 세션과 권한을 확인해 주세요.'); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load(); return () => controller.abort();
  },[user?.id,user?.role,user?.organization_id,refresh]);
  const onSaved = () => {setRefresh(v => v+1); void checkUserAuth();};
  if (!canManageUsers(user)) return <p>관리자만 접근할 수 있습니다.</p>;
  return <div className="space-y-4">
    <h2 className="text-lg font-semibold">사용자 관리</h2>
    <p className="text-xs text-muted-foreground">{isCompanyAdmin(user) ? 'Company Admin: 전체 조직의 사용자를 관리합니다.' : 'Partner Admin: 자기 조직의 사용자만 관리합니다. 다른 조직으로의 이동과 신규 가입자의 최초 소속 승인은 Company Admin에게 요청해 주세요.'}</p>
    <div className="flex flex-wrap gap-3 text-xs">
      <button onClick={() => setTab('users')} className="text-primary">사용자 목록 ({profiles.length})</button>
      <button onClick={() => setTab('requests')}>등급 요청 ({requests.length})</button>
      <button onClick={() => setRefresh(v => v+1)}>새로고침</button>
      {tab === 'users' && <select value={filter} onChange={e=>setFilter(e.target.value)} className="bg-accent rounded"><option value="">전체 역할</option>{['admin','operator','guest'].map(role=><option key={role}>{role}</option>)}</select>}
    </div>
    {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
    {loading ? <p className="text-sm text-muted-foreground">불러오는 중...</p> : !error && <div className="rounded-lg border border-border bg-card">
      {tab === 'users' ? profiles.filter(p=>!filter || p.role===filter).map(profile=><UserAccessRow key={`${profile.id}:${profile.updated_at}`} profile={profile} organizations={organizations} onSaved={onSaved} actorId={user.id} />)
        : requests.length ? requests.map(request=><RequestRow key={request.id} request={request} onSaved={onSaved} />) : <p className="p-4 text-sm text-muted-foreground">대기 중인 요청이 없습니다.</p>}
    </div>}
  </div>;
}
