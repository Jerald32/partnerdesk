import { canManageUsers, isCompanyAdmin, isGuest, SIGNUP_HOLDING_ORGANIZATION } from '@/lib/roles';
import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { supabase } from '@/lib/supabaseClient';
import { invokeAppAuth } from '@/lib/appAuth';
import { readRows } from '@/lib/supabaseData';
import { useRpcAction } from '@/hooks/useRpcAction';
import UserAccessRow from '@/components/users/UserAccessRow';
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

const roleLabel = role => ({ admin: 'Admin', operator: 'Operator', guest: 'Guest' }[role] || role);

function RequestRow({ request, organizations, onSaved }) {
  const { run,busy,error,unknown } = useRpcAction(onSaved);
  return <tr className="border-t border-border">
    <td className="p-4 align-top">{request.requester_name_snapshot || request.requester_email_snapshot}<p className="text-xs text-muted-foreground whitespace-pre-wrap">{request.justification}</p></td>
    <td className="p-4 align-top">{organizations.find(org => org.id === request.requested_organization_id)?.name || request.company || '소속 미지정'}</td>
    <td className="p-4 align-top">{roleLabel(request.requested_role)}</td>
    <td className="p-4 align-top"><div className="flex gap-3 text-xs">
      <button disabled={busy || unknown} className="text-primary" onClick={() => {
        if (window.confirm('요청한 조직과 역할로 승인하시겠습니까?')) void run('approve_role_request', { p_role_request_id: request.id,p_organization_id: request.requested_organization_id,p_admin_notes: null }, data => data?.role_request_id === request.id && data.status === 'approved');
      }}>승인</button>
      <button disabled={busy || unknown} onClick={() => { const note = window.prompt('반려 사유'); if (note !== null) void run('reject_role_request',{p_role_request_id:request.id,p_admin_notes:note || null}); }}>반려</button>
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </td>
  </tr>;
}

export default function UserManagement() {
  const { user,checkUserAuth } = useAuth();
  const [profiles,setProfiles] = useState([]),[organizations,setOrganizations] = useState([]),[requests,setRequests] = useState([]);
  const [loading,setLoading] = useState(true),[error,setError] = useState(''),[refresh,setRefresh] = useState(0),[filter,setFilter] = useState('');
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
      <button onClick={() => setRefresh(v => v+1)}>새로고침</button>
    </div>
    {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
    {loading ? <p className="text-sm text-muted-foreground">불러오는 중...</p> : !error && <>
      <section aria-labelledby="pending-users-heading" className="rounded-lg border border-border bg-card">
        <h3 id="pending-users-heading" className="p-4 font-semibold">가입 승인 대기 ({requests.length})</h3>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm">
          <thead className="bg-accent text-muted-foreground"><tr>{['신청자명','신청 소속','신청 등급','승인/반려'].map(label => <th key={label} scope="col" className="p-4 whitespace-nowrap">{label}</th>)}</tr></thead>
          <tbody>{requests.length ? requests.map(request => <RequestRow key={request.id} request={request} organizations={organizations} onSaved={onSaved} />) : <tr><td colSpan={4} className="p-4 text-muted-foreground">대기 중인 요청이 없습니다.</td></tr>}</tbody>
        </table></div>
      </section>
      <section aria-labelledby="all-users-heading" className="rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <h3 id="all-users-heading" className="font-semibold">전체 사용자 ({profiles.length})</h3>
          <select aria-label="등급 필터" value={filter} onChange={e=>setFilter(e.target.value)} className="bg-accent border border-border rounded p-2 text-xs"><option value="">전체 등급</option>{['admin','operator','guest'].map(role=><option key={role} value={role}>{roleLabel(role)}</option>)}</select>
        </div>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm">
          <thead className="bg-accent text-muted-foreground"><tr>{['사용자명','가입 승인 여부','소속','등급','관리'].map(label => <th key={label} scope="col" className="p-4 whitespace-nowrap">{label}</th>)}</tr></thead>
          <tbody>{profiles.filter(p=>!filter || p.role===filter).map(profile => <tr key={`${profile.id}:${profile.updated_at}`} className="border-t border-border">
            <td className="p-4"><p className="font-medium">{profile.display_name || profile.full_name || profile.email}</p><p className="text-xs text-muted-foreground">{profile.email}</p></td>
            <td className="p-4 whitespace-nowrap">{isGuest(profile.role) || !profile.organization_id || profile.organization_id === SIGNUP_HOLDING_ORGANIZATION ? '미승인' : '승인'}{['inactive_warning','suspended','disabled'].includes(profile.account_status) && <p className="text-xs text-muted-foreground">{profile.account_status === 'inactive_warning' ? '미접속 경고' : profile.account_status === 'disabled' ? '비활성화' : '차단'}</p>}</td>
            <td className="p-4">{organizations.find(org=>org.id===profile.organization_id)?.name || '소속 미지정'}</td>
            <td className="p-4">{roleLabel(profile.role)}</td>
            <td className="p-4"><Dialog>
              <DialogTrigger asChild><button className="text-primary whitespace-nowrap" aria-label={`${profile.display_name || profile.full_name || profile.email} 관리`}>관리</button></DialogTrigger>
              <DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>사용자 관리</DialogTitle><DialogDescription>사용자의 소속 및 등급을 변경합니다.</DialogDescription></DialogHeader>
                <UserAccessRow profile={profile} organizations={organizations} onSaved={onSaved} actorId={user.id} />
              </DialogContent>
            </Dialog></td>
          </tr>)}{!profiles.some(p=>!filter || p.role===filter) && <tr><td colSpan={5} className="p-4 text-muted-foreground">표시할 사용자가 없습니다.</td></tr>}</tbody>
        </table></div>
      </section>
    </>}
  </div>;
}
