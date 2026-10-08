import { organizationScopeDescription } from '@/lib/roles';
import { useState } from 'react';
import { useRpcAction } from '@/hooks/useRpcAction';
import { accessOrganizations, accessSaveMessage, formatUserAccessError, USER_ACCESS_ROLES } from '@/lib/userAccessForm';

export default function UserAccessRow({ profile, organizations, onSaved, actorId }) {
  const [role, setRole] = useState(profile.role);
  const [organization, setOrganization] = useState(profile.organization_id);
  const { run, busy, error, unknown } = useRpcAction(onSaved, formatUserAccessError);
  const candidates = accessOrganizations(organizations, 'guest');
  const validation = accessSaveMessage(profile, organizations, role, organization);
  const descriptionId = `access-status-${profile.id}`;
  async function save(event) {
    event.preventDefault();
    if (busy || unknown || validation) return;
    if (!window.confirm('권한과 소속을 변경하시겠습니까? 대상 사용자의 기존 세션이 해제됩니다.')) return;
    await run('change_profile_role_organization', { p_profile_id: profile.id, p_role: role, p_organization_id: organization },
      data => data?.id === profile.id && data.role === role && data.organization_id === organization);
  }
  return <form onSubmit={save} className="p-4 border-b border-border last:border-0 space-y-2">
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex-1 min-w-40"><p className="text-sm font-medium">{profile.display_name || profile.full_name || profile.email}</p><p className="text-xs text-muted-foreground">{profile.email} · {profile.account_status}</p></div>
      <fieldset disabled={busy || unknown} className="flex flex-wrap items-center gap-2 text-xs">
        <select aria-label="사용자 조직" value={organization} onChange={event => setOrganization(event.target.value)} className="bg-accent border border-border rounded p-2">
          <option value="">조직 선택</option>
          {!candidates.some(org => org.id === organization) && organization && <option value={organization} disabled>현재 조직 (변경 필요)</option>}
          {candidates.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}
        </select>
        <p className="basis-full text-muted-foreground">{organizationScopeDescription(organizations.find(org => org.id === organization))} {role === 'guest' && '현재 Guest: 승인 전 Ticket 접근 불가.'}</p>
        <select aria-label="사용자 역할" value={role} onChange={event => setRole(event.target.value)} className="bg-accent border border-border rounded p-2">
          {USER_ACCESS_ROLES.map(value => <option key={value} value={value}>{value === 'guest' ? 'Guest (승인 대기)' : value === 'admin' ? 'Admin' : 'Operator'}</option>)}
        </select>
        {role === 'admin' && <span className="text-muted-foreground">{organizations.find(org => org.id === organization)?.type === 'operator' ? 'Company Admin: 전역 사용자·권한 관리' : 'Partner Admin: 자기 조직의 사용자·권한 관리'}</span>}
        <button type="submit" disabled={busy || unknown || Boolean(validation)} aria-describedby={descriptionId} className="text-primary disabled:text-muted-foreground disabled:cursor-not-allowed">{busy ? '저장 중…' : '권한 저장'}</button>
        {profile.id !== actorId && profile.account_status !== 'disabled' && <button type="button" onClick={() => {
          if (window.confirm('계정을 비활성화하시겠습니까?')) void run('deactivate_profile', { p_profile_id: profile.id });
        }} className="text-destructive">비활성화</button>}
        {profile.account_status === 'suspended' && <button type="button" onClick={() => void run('reactivate_profile', { p_profile_id: profile.id })}>정지 해제</button>}
      </fieldset>
    </div>
    <p id={descriptionId} role="status" className="text-xs text-muted-foreground">{busy ? '권한 변경을 저장하고 있습니다.' : unknown ? '처리 결과가 불확실합니다. 목록을 새로고침하여 결과를 확인해 주세요.' : validation || '변경사항을 저장할 수 있습니다.'}</p>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </form>;
}
