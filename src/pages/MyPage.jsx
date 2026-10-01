import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { secureLogout } from '@/lib/logout';
import { User, ArrowUpCircle, Shield, UserCog, Handshake, Ghost, LogOut, Crown, Pencil, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ORG_TYPE_LABELS } from '@/lib/roles';
import RoleRequestForm from '@/components/users/RoleRequestForm';
import ProfileEditForm from '@/components/users/ProfileEditForm';

const ROLE_CONFIG = {
  admin:         { label: 'Admin',         icon: Shield,    color: 'bg-primary/20 text-primary border-primary/30' },
  operator:      { label: 'Operator',      icon: UserCog,   color: 'bg-orange-500/20 text-orange-400 border-orange-500/30' },
  partner_admin: { label: 'Partner Admin', icon: Crown,    color: 'bg-teal-500/20 text-teal-400 border-teal-500/30' },
  guest:         { label: 'Guest',         icon: Ghost,     color: 'bg-slate-500/20 text-slate-400 border-slate-500/30' },
};

export default function MyPage() {
  const [user, setUser] = useState(null);
  const [partners, setPartners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pendingRequest, setPendingRequest] = useState(null);

  const load = async () => {
    const me = await base44.auth.me();
    setUser(me);
    base44.entities.Partner.list().then(setPartners).catch(() => {});
    if (me?.role !== 'admin') {
      const requests = await base44.entities.RoleRequest.filter({ user_id: me.id }, '-created_date', 1);
      const latest = requests[0];
      if (latest && latest.status === 'pending') setPendingRequest(latest);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  if (loading) {
    return (
      <div className="space-y-4 max-w-lg">
        {Array(3).fill(0).map((_, i) => <div key={i} className="h-12 bg-accent rounded-lg animate-pulse" />)}
      </div>
    );
  }

  const roleConf = ROLE_CONFIG[user?.role] || ROLE_CONFIG.guest;
  const RoleIcon = roleConf.icon;
  const canRequestChange = user?.role !== 'admin';

  return (
    <div className="space-y-5 max-w-lg">
      <div>
        <h2 className="text-lg font-semibold text-foreground">내 계정</h2>
        <p className="text-xs text-muted-foreground mt-0.5">계정 정보 및 등급 확인</p>
      </div>

      {/* Profile card / edit */}
      {editing ? (
        <ProfileEditForm
          currentUser={user}
          roleColor={roleConf.color}
          onSaved={() => { setEditing(false); load(); }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className={cn("w-10 h-10 rounded-full overflow-hidden flex items-center justify-center text-sm font-bold", roleConf.color)}>
                {user?.profile_image_url ? (
                  <img src={user.profile_image_url} alt="profile" className="w-full h-full object-cover" />
                ) : (
                  user?.full_name?.[0]?.toUpperCase() || user?.email?.[0]?.toUpperCase() || 'U'
                )}
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">{user?.display_name || user?.full_name || '–'}</p>
                {user?.job_title && <p className="text-xs text-muted-foreground">{user.job_title}</p>}
                <p className="text-xs text-muted-foreground">{user?.email}</p>
              </div>
            </div>
            <button
              onClick={() => setEditing(true)}
              className="flex items-center gap-1.5 h-8 px-3 text-xs font-medium border border-border rounded-md hover:bg-accent transition-colors text-muted-foreground hover:text-foreground shrink-0"
            >
              <Pencil className="w-3.5 h-3.5" /> 편집
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <p className="text-muted-foreground">역할</p>
                {canRequestChange && !pendingRequest && (
                  <button onClick={() => setShowRequestForm(true)} className="text-[10px] text-primary hover:underline">변경 요청</button>
                )}
              </div>
              <span className={cn("inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border font-medium", roleConf.color)}>
                <RoleIcon className="w-3.5 h-3.5" />
                {roleConf.label}
              </span>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <p className="text-muted-foreground">소속</p>
                {canRequestChange && !pendingRequest && (
                  <button onClick={() => setShowRequestForm(true)} className="text-[10px] text-primary hover:underline">변경 요청</button>
                )}
              </div>
              <p className="text-foreground">
                {user?.org_type === 'operator_company'
                  ? (user?.affiliation || '–')
                  : (partners.find(p => p.id === user?.affiliation)?.name || user?.affiliation || '–')}
              </p>
              <p className="text-[10px] text-muted-foreground">{ORG_TYPE_LABELS[user?.org_type] || '–'}</p>
            </div>
            <div className="space-y-1">
              <p className="text-muted-foreground">직책</p>
              <p className="text-foreground">{user?.job_title || '–'}</p>
            </div>
          </div>
        </div>
      )}

      {/* Logout */}
      <div className="pt-2 flex items-center gap-2">
        <button
          onClick={() => secureLogout('/login')}
          className="flex items-center gap-2 h-9 px-4 text-sm font-medium text-destructive border border-destructive/30 rounded-md hover:bg-destructive/10 transition-colors"
        >
          <LogOut className="w-4 h-4" /> 로그아웃
        </button>
        <Link
          to="/privacy"
          className="flex items-center gap-2 h-9 px-4 text-sm font-medium text-foreground border border-border rounded-md hover:bg-accent transition-colors"
        >
          <ShieldCheck className="w-4 h-4 text-primary" /> 개인정보보호 조치사항
        </Link>
      </div>

      {/* 소속/역할 변경 요청 — 관리자 외 모든 사용자 */}
      {canRequestChange && (
        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-foreground">소속/역할 변경 요청</p>
              <p className="text-xs text-muted-foreground mt-0.5">소속사 또는 역할 변경 시 관리자 승인이 필요합니다</p>
            </div>
            {!showRequestForm && !pendingRequest && (
              <button
                onClick={() => setShowRequestForm(true)}
                className="shrink-0 flex items-center gap-1.5 h-8 px-3 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors whitespace-nowrap"
              >
                <ArrowUpCircle className="w-3.5 h-3.5" /> 변경 요청
              </button>
            )}
          </div>

          {pendingRequest && !showRequestForm && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-orange-500/10 border border-orange-500/20 text-xs text-orange-400">
              <ArrowUpCircle className="w-3.5 h-3.5 shrink-0" />
              <span>소속/역할 변경 요청이 관리자 승인 대기 중입니다</span>
            </div>
          )}

          {showRequestForm && (
            <RoleRequestForm
              currentUser={user}
              onSubmitted={() => { setShowRequestForm(false); load(); }}
            />
          )}
        </div>
      )}
    </div>
  );
}