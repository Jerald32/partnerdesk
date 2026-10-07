import { useState, useEffect } from 'react';
import { Settings2, Clock, Shield, ShieldCheck, Check, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import { base44 } from '@/api/base44Client';
import IpWhitelistManager from '@/components/settings/IpWhitelistManager';
import MfaSettingManager from '@/components/settings/MfaSettingManager';

const TABS = [
  { key: 'status', label: '상태 설정', icon: Settings2 },
  { key: 'sla', label: 'SLA 설정', icon: Clock },
  { key: 'role', label: '역할 설정', icon: Shield },
  { key: 'security', label: '보안 설정', icon: ShieldCheck },
  { key: 'ip', label: 'IP 접근 제한', icon: Globe },
];

const DEFAULT_STATUSES = [
  { key: 'new', label: '신규', color: '#64748b', desc: '새로 접수된 티켓' },
  { key: 'inprogress', label: '진행중', color: '#3b82f6', desc: '처리 중인 티켓' },
  { key: 'hold', label: '보류', color: '#f97316', desc: '보류된 티켓' },
  { key: 'done', label: '완료', color: '#10b981', desc: '처리 완료된 티켓' },
];

const DEFAULT_SLAS = [
  { priority: 'urgent', label: '긴급', response: 1, resolution: 4 },
  { priority: 'high', label: '높음', response: 4, resolution: 8 },
  { priority: 'normal', label: '보통', response: 8, resolution: 24 },
  { priority: 'low', label: '낮음', response: 24, resolution: 72 },
];

const ROLES_INFO = [
  { role: 'admin', label: 'Admin', color: 'text-primary bg-primary/10', desc: '운영사 전체 관리자 — 전체 시스템 접근', perms: ['전체 티켓 열람', '비즈니스/파트너 관리', '사용자 초대 및 권한/소속 변경', '보안·IP·MFA 설정'] },
  { role: 'operator', label: 'Operator', color: 'text-orange-400 bg-orange-500/10', desc: '운영자 — 소속사 등급에 따라 티켓 범위 결정', perms: ['운영사: 전체 티켓 열람·처리', '비즈니스파트너: 해당 비즈니스 전체 티켓 열람', '서비스파트너: 자사 배정 티켓만 열람', '티켓 생성·상태 전환·댓글 작성'] },
];

export default function Settings() {
  const [tab, setTab] = useState('status');
  const [slas, setSlas] = useState(DEFAULT_SLAS);
  const [saved, setSaved] = useState(false);
  const [user, setUser] = useState(null);

  useEffect(() => {
    base44.auth.me().then(setUser).catch(() => {});
  }, []);

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const inputClass = "h-8 px-3 text-xs bg-accent border border-border rounded-md text-foreground focus:outline-none focus:ring-1 focus:ring-ring w-20";

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">설정</h2>
        <p className="text-xs text-muted-foreground mt-0.5">시스템 설정 관리</p>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border">
        {TABS.filter(t => (t.key !== 'ip' && t.key !== 'security') || user?.role === 'admin').map(t => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors -mb-px",
                tab === t.key
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Status Config */}
      {tab === 'status' && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">티켓 상태 단계 및 색상 설정</p>
          <div className="space-y-2">
            {DEFAULT_STATUSES.map((s, idx) => (
              <div key={s.key} className="flex items-center gap-4 rounded-lg border border-border bg-card px-4 py-3">
                <span className="text-xs text-muted-foreground w-4">{idx + 1}</span>
                <div className="w-3 h-3 rounded-full shrink-0" style={{ background: s.color }} />
                <div className="flex-1">
                  <p className="text-sm font-medium text-foreground">{s.label}</p>
                  <p className="text-xs text-muted-foreground">{s.desc}</p>
                </div>
                <span className="text-xs font-mono text-muted-foreground px-2 py-1 bg-accent rounded">{s.key}</span>
                <span className="text-xs text-muted-foreground px-2 py-1 rounded" style={{ background: s.color + '20', color: s.color }}>{s.color}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">※ 상태 흐름은 고정입니다. 레이블 및 색상은 향후 커스터마이징 예정입니다.</p>
        </div>
      )}

      {/* SLA Config */}
      {tab === 'sla' && (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">우선순위별 SLA 기준 시간 설정 (단위: 시간)</p>
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {['우선순위', '응답 SLA (h)', '해결 SLA (h)', ''].map(col => (
                    <th key={col} className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {slas.map((sla, idx) => (
                  <tr key={sla.priority} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">
                      <span className={cn("text-xs px-2 py-0.5 rounded font-medium",
                        sla.priority === 'urgent' ? "bg-red-500/20 text-red-400" :
                        sla.priority === 'high' ? "bg-orange-500/20 text-orange-400" :
                        sla.priority === 'normal' ? "bg-blue-500/20 text-blue-400" :
                        "bg-slate-500/20 text-slate-400"
                      )}>
                        {sla.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="number" min={0}
                        value={sla.response}
                        onChange={e => setSlas(ss => ss.map((s, i) => i === idx ? { ...s, response: +e.target.value } : s))}
                        className={inputClass}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="number" min={0}
                        value={sla.resolution}
                        onChange={e => setSlas(ss => ss.map((s, i) => i === idx ? { ...s, resolution: +e.target.value } : s))}
                        className={inputClass}
                      />
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      응답 {sla.response}h 이내, 해결 {sla.resolution}h 이내
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            onClick={handleSave}
            className={cn(
              "flex items-center gap-1.5 h-8 px-4 text-xs font-medium rounded-md transition-colors",
              saved ? "bg-emerald-500/20 text-emerald-400" : "bg-primary text-primary-foreground hover:bg-primary/90"
            )}
          >
            {saved ? <><Check className="w-3.5 h-3.5" /> 저장됨</> : '설정 저장'}
          </button>
        </div>
      )}

      {/* Role Config */}
      {tab === 'role' && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">역할별 권한 정보</p>
          {ROLES_INFO.map(r => (
            <div key={r.role} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className={cn("text-xs font-semibold px-2.5 py-1 rounded-md uppercase tracking-wide", r.color)}>
                  {r.label}
                </span>
                <span className="text-sm text-muted-foreground">{r.desc}</span>
              </div>
              <div className="flex flex-wrap gap-2 mt-2">
                {r.perms.map(perm => (
                  <div key={perm} className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Check className="w-3 h-3 text-emerald-400" />
                    {perm}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Security Settings */}
      {tab === 'security' && user?.role === 'admin' && (
        <MfaSettingManager />
      )}

      {/* IP Access Control */}
      {tab === 'ip' && user?.role === 'admin' && (
        <IpWhitelistManager />
      )}
    </div>
  );
}