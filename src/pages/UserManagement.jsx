import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Users, Shield, UserCog, Handshake, Mail, ArrowUpCircle, Trash2, Crown, Unlock } from 'lucide-react';
import { cn } from '@/lib/utils';
import RoleRequestAdmin from '@/components/users/RoleRequestAdmin';
import { isPartnerOrgType } from '@/lib/roles';
import { logAccess } from '@/lib/accessLog';

const HQ_LIST = ['SK쉴더스'];

const ROLE_CONFIG = {
  admin:         { label: 'Admin',          color: 'bg-primary/20 text-primary border-primary/30' },
  operator:      { label: 'Operator',      color: 'bg-orange-500/20 text-orange-400 border-orange-500/30' },
  partner_admin: { label: 'Partner Admin',  color: 'bg-teal-500/20 text-teal-400 border-teal-500/30' },
  guest:         { label: 'Guest',          color: 'bg-slate-500/20 text-slate-400 border-slate-500/30' },
};

export default function UserManagement() {
  const [currentUser, setCurrentUser] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [filterRole, setFilterRole] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('operator');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [tab, setTab] = useState('users'); // 'users' | 'requests'
  const [pendingCount, setPendingCount] = useState(0);

  const [partners, setPartners] = useState([]);

  const load = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [me, p, usersRes] = await Promise.all([
        base44.auth.me(),
        base44.entities.Partner.list(),
        base44.functions.invoke('manageUsers', { action: 'list' }),
      ]);
      setCurrentUser(me);
      setUsers(usersRes.data.users);
      setPartners(p);
      logAccess({
        action: '조회',
        target_type: '사용자 정보',
        subject_info: `사용자 계정 ${usersRes.data.users.length}명 정보 조회 (이름·이메일·소속)`,
        detail: '사용자 관리 화면 접속',
      });
    } catch (err) {
      setLoadError(err?.message || '사용자 목록을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const isAdmin = currentUser?.role === 'admin';

  // SK쉴더스 소속(운영사)만 Admin 지정 가능; 파트너사 소속은 Partner Admin 지정 가능
  const canBeAdmin = (u) => u?.org_type === 'operator_company' || HQ_LIST.includes(u?.affiliation);
  const canBePartnerAdmin = (u) => isPartnerOrgType(u?.org_type) || (!!u?.affiliation && !HQ_LIST.includes(u?.affiliation));

  const handleRoleChange = async (userId, newRole) => {
    const target = users.find(u => u.id === userId);
    if (newRole === 'admin') {
      const patch = { role: 'admin' };
      if (!canBeAdmin(target)) { patch.org_type = 'operator_company'; patch.affiliation = HQ_LIST[0] || ''; }
      await base44.functions.invoke('manageUsers', { action: 'update', userId, reason: `관리자 직접 등급 변경 (${newRole})`, data: patch });
    } else if (newRole === 'partner_admin') {
      const target2 = users.find(u => u.id === userId);
      const orgType = isPartnerOrgType(target2?.org_type) ? target2.org_type : 'partner';
      await base44.functions.invoke('manageUsers', { action: 'update', userId, reason: `관리자 직접 등급 변경 (${newRole})`, data: { role: 'partner_admin', org_type: orgType } });
    } else {
      await base44.functions.invoke('manageUsers', { action: 'update', userId, reason: `관리자 직접 등급 변경 (${newRole})`, data: { role: newRole } });
    }
    load();
  };

  // 소속사 선택으로 org_type 자동 결정: 본사명→운영사, 파트너→파트너
  // 비즈니스/서비스 구분은 비즈니스별 ServicePartner.access_level에서 관리하므로 사용자 설정 불필요
  const handleAffiliationChange = (userId, value, currentRole) => {
    const isHq = HQ_LIST.includes(value);
    const patch = { affiliation: value };
    if (value) {
      patch.org_type = isHq ? 'operator_company' : 'partner';
      if (!isHq && currentRole === 'admin') patch.role = 'operator';
      if (isHq && currentRole === 'partner_admin') patch.role = 'operator';
    }
    return base44.functions.invoke('manageUsers', { action: 'update', userId, reason: `관리자 직접 소속 변경 (${value || '미지정'})`, data: patch }).then(load);
  };

  const handleDelete = async (userId) => {
    if (!window.confirm('정말 이 사용자를 삭제하시겠습니까?')) return;
    await base44.functions.invoke('manageUsers', { action: 'delete', userId });
    load();
  };

  const handleInvite = async (e) => {
    e.preventDefault();
    setInviting(true); setInviteError('');
    try {
      // 플랫폼 inviteUser는 'user'/'admin'만 허용 — 커스텀 등급은 가입 후 별도 지정
      const platformRole = inviteRole === 'admin' ? 'admin' : 'user';
      await base44.users.inviteUser(inviteEmail, platformRole);
      setInviteEmail(''); setInviting(false);
      load();
    } catch (err) {
      setInviteError(err.message || '초대 실패'); setInviting(false);
    }
  };

  const filtered = users.filter(u => !filterRole || u.role === filterRole);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">사용자 관리</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{users.length}명 사용자</p>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setTab('users')}
              className={cn("h-7 px-3 text-xs rounded-md transition-colors", tab === 'users' ? "bg-primary text-primary-foreground" : "bg-accent text-muted-foreground hover:text-foreground")}
            >
              사용자 목록
            </button>
            <button
              onClick={() => setTab('requests')}
              className={cn("h-7 px-3 text-xs rounded-md transition-colors flex items-center gap-1.5", tab === 'requests' ? "bg-primary text-primary-foreground" : "bg-accent text-muted-foreground hover:text-foreground")}
            >
              <ArrowUpCircle className="w-3 h-3" />
              등급 요청
              {pendingCount > 0 && (
                <span className={cn("w-4 h-4 rounded-full text-[10px] font-bold flex items-center justify-center", tab === 'requests' ? "bg-white text-primary" : "bg-primary text-primary-foreground")}>
                  {pendingCount}
                </span>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Admin: Role requests tab */}
      {isAdmin && tab === 'requests' && (
        <RoleRequestAdmin onCountChange={setPendingCount} />
      )}

      {/* Users tab */}
      {tab === 'users' && (
        <>
          {/* Role filter */}
          <div className="flex items-center gap-2 flex-wrap">
            {['', 'admin', 'operator', 'partner_admin', 'guest'].map(role => (
              <button
                key={role}
                onClick={() => setFilterRole(role)}
                className={cn(
                  "h-7 px-3 text-xs rounded-md transition-colors",
                  filterRole === role ? "bg-primary text-primary-foreground" : "bg-accent text-muted-foreground hover:text-foreground"
                )}
              >
                {role === '' ? '전체' : ROLE_CONFIG[role]?.label}
              </button>
            ))}
          </div>

          {/* Invite form — admin only */}
          {isAdmin && (
            <div className="rounded-lg border border-border bg-card p-4">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">사용자 초대</h3>
              <form onSubmit={handleInvite} className="flex items-end gap-3 flex-wrap">
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">이메일</label>
                  <input
                    type="email" required
                    value={inviteEmail}
                    onChange={e => setInviteEmail(e.target.value)}
                    placeholder="user@company.com"
                    className="h-8 w-60 px-3 text-sm bg-accent border border-border rounded-md text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">역할</label>
                  <select
                    value={inviteRole}
                    onChange={e => setInviteRole(e.target.value)}
                    className="h-8 px-3 text-sm bg-accent border border-border rounded-md text-foreground focus:outline-none focus:ring-1 focus:ring-ring appearance-none cursor-pointer"
                  >
                    <option value="guest">Guest</option>
                    <option value="operator">Operator</option>
                    <option value="partner_admin">Partner Admin</option>
                    {canBeAdmin(currentUser) && <option value="admin">Admin</option>}
                  </select>
                </div>
                <button
                  type="submit" disabled={inviting}
                  className="flex items-center gap-1.5 h-8 px-4 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  <Mail className="w-3.5 h-3.5" /> {inviting ? '초대 중...' : '초대 전송'}
                </button>
                {inviteError && <p className="text-xs text-destructive">{inviteError}</p>}
              </form>
            </div>
          )}

          {/* User mobile cards */}
          <div className="md:hidden space-y-2">
            {loading ? (
              <div className="py-10 text-center text-muted-foreground text-sm">불러오는 중...</div>
            ) : loadError ? (
              <div className="py-10 text-center space-y-2">
                <p className="text-destructive text-sm">{loadError}</p>
                <button onClick={load} className="h-8 px-3 text-xs bg-accent border border-border rounded-md hover:bg-accent/70 transition-colors">다시 시도</button>
              </div>
            ) : filtered.length === 0 ? (
              <div className="py-10 text-center text-muted-foreground text-sm">사용자가 없습니다</div>
            ) : (
              filtered.map(user => {
                const roleConf = ROLE_CONFIG[user.role] || ROLE_CONFIG.guest;
                return (
                  <div key={user.id} className="rounded-lg border border-border bg-card p-3 space-y-2.5">
                    <div className="flex items-center gap-2.5">
                      <div className={cn("w-8 h-8 rounded-full overflow-hidden flex items-center justify-center text-xs font-semibold shrink-0",
                        user.role === 'admin' ? "bg-primary/20 text-primary" :
                        user.role === 'operator' ? "bg-orange-500/20 text-orange-400" :
                        user.role === 'partner' ? "bg-emerald-500/20 text-emerald-400" :
                        user.role === 'partner_admin' ? "bg-teal-500/20 text-teal-400" :
                        "bg-slate-500/20 text-slate-400"
                      )}>
                        {user.profile_image_url ? (
                          <img src={user.profile_image_url} alt="" className="w-full h-full object-cover" />
                        ) : (
                          user.display_name?.[0]?.toUpperCase() || user.full_name?.[0]?.toUpperCase() || user.email?.[0]?.toUpperCase() || 'U'
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-medium text-foreground text-sm">{user.display_name || user.full_name || '–'}</span>
                          {user.account_status === 'suspended' && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/30 font-medium">차단</span>
                          )}
                          {user.account_status === 'inactive_warning' && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400 border border-orange-500/30 font-medium">미접속 경고</span>
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground truncate">{user.email}</p>
                      </div>
                    </div>

                    <div className="text-[11px]">
                      <p className="text-muted-foreground mb-1">소속사</p>
                      <select
                        value={user.affiliation || ''}
                        disabled={!isAdmin}
                        onChange={e => handleAffiliationChange(user.id, e.target.value, user.role)}
                        className="w-full text-xs px-2 py-1.5 rounded-md border border-border bg-accent text-foreground appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                      >
                        <option value="">미지정</option>
                        <optgroup label="운영사">
                          {HQ_LIST.map(name => <option key={name} value={name}>{name}</option>)}
                        </optgroup>
                        <optgroup label="파트너사">
                          {partners.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </optgroup>
                      </select>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      {isAdmin ? (
                        <select
                          value={user.role || 'guest'}
                          onChange={e => handleRoleChange(user.id, e.target.value)}
                          className={cn("text-xs px-2.5 py-1 rounded-md border font-medium appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring", roleConf.color)}
                          style={{ background: 'transparent' }}
                        >
                          <option value="guest">Guest</option>
                          <option value="operator">Operator</option>
                          {canBeAdmin(user) && <option value="admin">Admin</option>}
                          {canBePartnerAdmin(user) && <option value="partner_admin">Partner Admin</option>}
                        </select>
                      ) : (
                        <span className={cn("text-[11px] px-2 py-0.5 rounded border font-medium", roleConf.color)}>{roleConf.label}</span>
                      )}
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        {isAdmin && user.account_status === 'suspended' && (
                          <button
                            onClick={() => base44.functions.invoke('manageUsers', { action: 'update', userId: user.id, data: { account_status: 'active' } }).then(load)}
                            className="p-1 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"
                            title="계정 활성화"
                          >
                            <Unlock className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {isAdmin && user.id !== currentUser?.id && (
                          <button
                            onClick={() => handleDelete(user.id)}
                            className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                            title="사용자 삭제"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* User table */}
          <div className="hidden md:block rounded-lg border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {['사용자', '이메일', '소속사', '역할', ''].map(col => (
                    <th key={col} className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  Array(5).fill(0).map((_, i) => (
                    <tr key={i} className="border-b border-border">
                      {Array(5).fill(0).map((_, j) => (
                        <td key={j} className="px-4 py-3"><div className="h-3 bg-accent rounded animate-pulse w-28" /></td>
                      ))}
                    </tr>
                  ))
                ) : loadError ? (
                  <tr><td colSpan={5} className="py-10 text-center space-y-2">
                    <p className="text-destructive text-sm">{loadError}</p>
                    <button onClick={load} className="h-8 px-3 text-xs bg-accent border border-border rounded-md hover:bg-accent/70 transition-colors">다시 시도</button>
                  </td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={5} className="py-10 text-center text-muted-foreground text-sm">사용자가 없습니다</td></tr>
                ) : (
                  filtered.map(user => {
                    const roleConf = ROLE_CONFIG[user.role] || ROLE_CONFIG.guest;
                    return (
                      <tr key={user.id} className="border-b border-border last:border-0 hover:bg-accent/50 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <div className={cn("w-7 h-7 rounded-full overflow-hidden flex items-center justify-center text-xs font-semibold shrink-0",
                              user.role === 'admin' ? "bg-primary/20 text-primary" :
                              user.role === 'operator' ? "bg-orange-500/20 text-orange-400" :
                              user.role === 'partner' ? "bg-emerald-500/20 text-emerald-400" :
                              user.role === 'partner_admin' ? "bg-teal-500/20 text-teal-400" :
                              "bg-slate-500/20 text-slate-400"
                            )}>
                              {user.profile_image_url ? (
                                <img src={user.profile_image_url} alt="" className="w-full h-full object-cover" />
                              ) : (
                                user.display_name?.[0]?.toUpperCase() || user.full_name?.[0]?.toUpperCase() || user.email?.[0]?.toUpperCase() || 'U'
                              )}
                            </div>
                            <span className="font-medium text-foreground">{user.display_name || user.full_name || '–'}</span>
                            {user.account_status === 'suspended' && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/30 font-medium whitespace-nowrap">차단</span>
                            )}
                            {user.account_status === 'inactive_warning' && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400 border border-orange-500/30 font-medium whitespace-nowrap">미접속 경고</span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{user.email}</td>
                        <td className="px-4 py-3">
                          <select
                            value={user.affiliation || ''}
                            disabled={!isAdmin}
                            onChange={e => handleAffiliationChange(user.id, e.target.value, user.role)}
                            className="h-7 w-36 px-2 text-xs bg-accent border border-border rounded-md text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 disabled:cursor-default appearance-none cursor-pointer"
                          >
                            <option value="">미지정</option>
                            <optgroup label="운영사">
                              {HQ_LIST.map(name => <option key={name} value={name}>{name}</option>)}
                            </optgroup>
                            <optgroup label="파트너사">
                              {partners.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </optgroup>
                          </select>
                        </td>
                        <td className="px-4 py-3">
                          {isAdmin ? (
                            <select
                              value={user.role || 'guest'}
                              onChange={e => handleRoleChange(user.id, e.target.value)}
                              className={cn("text-xs px-2.5 py-1 rounded-md border font-medium appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring", roleConf.color)}
                              style={{ background: 'transparent' }}
                            >
                              <option value="guest">Guest</option>
                              <option value="operator">Operator</option>
                              {canBeAdmin(user) && <option value="admin">Admin</option>}
                              {canBePartnerAdmin(user) && <option value="partner_admin">Partner Admin</option>}
                            </select>
                          ) : (
                            <span className={cn("text-[11px] px-2 py-0.5 rounded border font-medium", roleConf.color)}>
                              {roleConf.label}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
                            {user.role === 'admin' && <Shield className="w-3.5 h-3.5 text-primary" />}
                            {user.role === 'operator' && <UserCog className="w-3.5 h-3.5 text-orange-400" />}
                            {user.role === 'partner' && <Handshake className="w-3.5 h-3.5 text-emerald-400" />}
                            {user.role === 'partner_admin' && <Crown className="w-3.5 h-3.5 text-teal-400" />}
                            {isAdmin && user.account_status === 'suspended' && (
                              <button
                                onClick={() => base44.functions.invoke('manageUsers', { action: 'update', userId: user.id, data: { account_status: 'active' } }).then(load)}
                                className="p-1 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"
                                title="계정 활성화"
                              >
                                <Unlock className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {isAdmin && user.id !== currentUser?.id && (
                              <button
                                onClick={() => handleDelete(user.id)}
                                className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                                title="사용자 삭제"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}