import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { supabase } from '@/lib/supabaseClient';
import { invokeAppAuth } from '@/lib/appAuth';
import { readRows } from '@/lib/supabaseData';
import { useRpcAction } from '@/hooks/useRpcAction';

function AccessRow({ profile, organizations, onSaved, actorId }) {
  const [role, setRole] = useState(profile.role);
  const [organization, setOrganization] = useState(profile.organization_id);
  const { run, busy, error, unknown } = useRpcAction(onSaved);
  const candidates = organizations.filter(o => o.is_active && (role === 'guest' || o.type === (role === 'partner_admin' ? 'partner' : 'operator')));
  return <div className="p-4 border-b border-border last:border-0 space-y-2">
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex-1 min-w-40"><p className="text-sm font-medium">{profile.display_name || profile.full_name || profile.email}</p><p className="text-xs text-muted-foreground">{profile.email} · {profile.account_status}</p></div>
      <fieldset disabled={busy || unknown} className="flex flex-wrap items-center gap-2 text-xs">
        <select value={role} onChange={e => { setRole(e.target.value); setOrganization(''); }} className="bg-accent border border-border rounded p-2">
          {['admin','operator','partner_admin','guest'].map(role => <option key={role}>{role}</option>)}
        </select>
        <select value={organization} onChange={e => setOrganization(e.target.value)} className="bg-accent border border-border rounded p-2">
          <option value="">조직 선택</option>
          {!candidates.some(o => o.id === organization) && organization && <option value={organization} disabled>현재 조직 (변경 필요)</option>}
          {candidates.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <button disabled={!candidates.some(o => o.id === organization) || (role === profile.role && organization === profile.organization_id)}
          onClick={() => { if (window.confirm('권한과 소속을 변경하시겠습니까? 기존 세션이 해제됩니다.')) void run('change_profile_role_organization', { p_profile_id: profile.id,p_role: role,p_organization_id: organization }); }} className="text-primary">권한 저장</button>
        {profile.id !== actorId && profile.account_status !== 'disabled' && <button onClick={() => {
          if (window.confirm('계정을 비활성화하시겠습니까?')) void run('deactivate_profile',{p_profile_id: profile.id});
        }} className="text-destructive">비활성화</button>}
        {profile.account_status === 'suspended' && <button onClick={() => void run('reactivate_profile',{p_profile_id: profile.id})}>정지 해제</button>}
      </fieldset>
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>;
}

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
        if (user?.role !== 'admin') return;
        await invokeAppAuth('validate-session'); if (controller.signal.aborted) return;
        const [profiles,orgs,requests] = await Promise.all([
          readRows(() => supabase.from('profiles').select('id,full_name,display_name,email,role,organization_id,account_status,updated_at',{count:'exact'}).order('id'),controller.signal),
          readRows(() => supabase.from('organizations').select('id,name,type,is_active',{count:'exact'}).order('name').order('id'),controller.signal),
          readRows(() => supabase.from('role_requests').select('id,requester_name_snapshot,requester_email_snapshot,requested_role,requested_organization_id,company,justification,status',{count:'exact'}).eq('status','pending').order('created_at').order('id'),controller.signal),
        ]);
        if (!controller.signal.aborted) {setProfiles(profiles);setOrganizations(orgs);setRequests(requests);}
      } catch { if (!controller.signal.aborted) setError('사용자 정보를 불러오지 못했습니다. 세션과 권한을 확인해 주세요.'); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load(); return () => controller.abort();
  },[user?.id,user?.role,refresh]);
  const onSaved = () => {setRefresh(v => v+1); void checkUserAuth();};
  if (user?.role !== 'admin') return <p>관리자만 접근할 수 있습니다.</p>;
  return <div className="space-y-4">
    <h2 className="text-lg font-semibold">사용자 관리</h2>
    <div className="flex flex-wrap gap-3 text-xs">
      <button onClick={() => setTab('users')} className="text-primary">사용자 목록 ({profiles.length})</button>
      <button onClick={() => setTab('requests')}>등급 요청 ({requests.length})</button>
      <button onClick={() => setRefresh(v => v+1)}>새로고침</button>
      {tab === 'users' && <select value={filter} onChange={e=>setFilter(e.target.value)} className="bg-accent rounded"><option value="">전체 역할</option>{['admin','operator','partner_admin','guest'].map(role=><option key={role}>{role}</option>)}</select>}
    </div>
    {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
    {loading ? <p className="text-sm text-muted-foreground">불러오는 중...</p> : !error && <div className="rounded-lg border border-border bg-card">
      {tab === 'users' ? profiles.filter(p=>!filter || p.role===filter).map(profile=><AccessRow key={`${profile.id}:${profile.updated_at}`} profile={profile} organizations={organizations} onSaved={onSaved} actorId={user.id} />)
        : requests.length ? requests.map(request=><RequestRow key={request.id} request={request} onSaved={onSaved} />) : <p className="p-4 text-sm text-muted-foreground">대기 중인 요청이 없습니다.</p>}
    </div>}
  </div>;
}
