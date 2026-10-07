import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { CheckCircle2, XCircle, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';

const ROLE_LABEL = { operator: 'Operator', guest: 'Guest', admin: 'Admin', partner_admin: 'Partner Admin' };
const ORG_TYPE_LABEL = { operator_company: '운영사', partner: '파트너' };
const STATUS_CONFIG = {
  pending: { label: '대기중', color: 'text-orange-400 bg-orange-500/10 border-orange-500/20' },
  approved: { label: '승인됨', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  denied: { label: '거부됨', color: 'text-red-400 bg-red-500/10 border-red-500/20' },
};

export default function RoleRequestAdmin({ onCountChange }) {
  const [requests, setRequests] = useState([]);
  const [usersById, setUsersById] = useState({});
  const [loading, setLoading] = useState(true);
  const [denyModal, setDenyModal] = useState(null); // { request }
  const [denyNote, setDenyNote] = useState('');
  const [processing, setProcessing] = useState('');

  const load = async () => {
    const [data, usersRes] = await Promise.all([
      base44.entities.RoleRequest.list('-created_date', 100),
      base44.functions.invoke('manageUsers', { action: 'list' }),
    ]);
    // 표시용 사용자 정보는 서버에서 조회한 최신 목록 기준 (요청 레코드의 클라이언트 제공 필드는 신뢰하지 않음)
    const map = {};
    (usersRes.data.users || []).forEach(u => { map[u.id] = u; });
    setUsersById(map);
    setRequests(data);
    onCountChange?.(data.filter(r => r.status === 'pending').length);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleApprove = async (req) => {
    setProcessing(req.id);
    // 위조 방어: 요청 생성자와 대상 사용자가 불일치하면 자동 거부
    if (req.user_id !== req.created_by_id) {
      await base44.entities.RoleRequest.update(req.id, {
        status: 'denied',
        admin_notes: '요청 생성자와 대상 사용자가 일치하지 않아 자동 거부되었습니다.',
      });
      setProcessing('');
      alert('요청 생성자와 대상 사용자가 일치하지 않아 자동 거부 처리했습니다.');
      load();
      return;
    }
    // 대상 사용자 존재 여부 확인 (삭제된 사용자의 요청 방어) — 서버에서 조회한 사용자 목록 기준
    const target = usersById[req.user_id];
    if (!target) {
      await base44.entities.RoleRequest.update(req.id, {
        status: 'denied',
        admin_notes: '대상 사용자가 존재하지 않습니다 (삭제됨).',
      });
      setProcessing('');
      alert('대상 사용자가 이미 삭제되어 요청을 거부 처리했습니다.');
      load();
      return;
    }
    await Promise.all([
      base44.entities.RoleRequest.update(req.id, { status: 'approved' }),
      base44.functions.invoke('manageUsers', { action: 'update', userId: req.user_id, requestId: req.id, reason: req.justification || '등급 변경 요청 승인', data: {
        role: req.requested_role,
        ...(req.requested_org_type ? { org_type: req.requested_org_type } : {}),
        ...(req.company ? { affiliation: req.company } : {}),
      } }),
    ]);
    setProcessing('');
    load();
  };

  const handleDeny = async () => {
    if (!denyModal) return;
    setProcessing(denyModal.id);
    await base44.entities.RoleRequest.update(denyModal.id, { status: 'denied', admin_notes: denyNote });
    setDenyModal(null);
    setDenyNote('');
    setProcessing('');
    load();
  };

  const pending = requests.filter(r => r.status === 'pending');
  const others = requests.filter(r => r.status !== 'pending');

  return (
    <div className="space-y-4">
      {/* Pending */}
      {loading ? (
        <div className="space-y-2">
          {Array(2).fill(0).map((_, i) => (
            <div key={i} className="h-16 bg-accent rounded-lg animate-pulse" />
          ))}
        </div>
      ) : pending.length === 0 ? (
        <div className="py-10 text-center text-muted-foreground text-sm">대기 중인 등급 변경 요청이 없습니다</div>
      ) : (
        <div className="space-y-2">
          {pending.map(req => {
            // 서버에서 확인된 사용자 정보로 표시 — 요청 레코드의 위조 가능 필드는 신뢰하지 않음
            const target = usersById[req.user_id];
            const mismatched = req.user_id !== req.created_by_id;
            return (
            <div key={req.id} className="rounded-lg border border-orange-500/20 bg-orange-500/5 p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1 flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground">{target ? (target.display_name || target.full_name || '–') : (req.user_name || req.user_email)}</span>
                    <span className="text-xs text-muted-foreground">{target?.email || req.user_email}</span>
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border bg-orange-500/10 text-orange-400 border-orange-500/20">
                      <Clock className="w-3 h-3" /> 대기중
                    </span>
                    {mismatched && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] border bg-red-500/10 text-red-400 border-red-500/20">요청자 불일치</span>
                    )}
                    {!target && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] border bg-red-500/10 text-red-400 border-red-500/20">사용자 없음</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                    <span>현재: <span className="text-foreground">{target ? (ROLE_LABEL[target.role] || target.role) : '확인 불가'}</span></span>
                    <span>→</span>
                    <span>요청: <span className="text-primary font-medium">{ROLE_LABEL[req.requested_role]}</span>{req.requested_org_type && <span className="text-muted-foreground"> · {ORG_TYPE_LABEL[req.requested_org_type] || req.requested_org_type}</span>}</span>
                    {req.company && <span>· {req.company}</span>}
                  </div>
                  {req.justification && (
                    <p className="text-xs text-muted-foreground mt-1 truncate">{req.justification}</p>
                  )}
                  <p className="text-[11px] text-muted-foreground">{format(new Date(req.created_date), 'yyyy.MM.dd HH:mm')}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => handleApprove(req)}
                    disabled={!!processing}
                    className="flex items-center gap-1 h-7 px-3 text-xs font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-md hover:bg-emerald-500/30 transition-colors disabled:opacity-50"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" /> 승인
                  </button>
                  <button
                    onClick={() => { setDenyModal(req); setDenyNote(''); }}
                    disabled={!!processing}
                    className="flex items-center gap-1 h-7 px-3 text-xs font-medium bg-red-500/20 text-red-400 border border-red-500/30 rounded-md hover:bg-red-500/30 transition-colors disabled:opacity-50"
                  >
                    <XCircle className="w-3.5 h-3.5" /> 거부
                  </button>
                </div>
              </div>
            </div>
            );
          })}
        </div>
      )}

      {/* History */}
      {others.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">처리 내역</p>
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {['사용자', '요청 등급', '요청일', '상태', '메모'].map(col => (
                    <th key={col} className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {others.map(req => {
                  const sc = STATUS_CONFIG[req.status];
                  return (
                    <tr key={req.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5 text-xs">
                        <p className="text-foreground font-medium">{req.user_name || '–'}</p>
                        <p className="text-muted-foreground">{req.user_email}</p>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-foreground">{ROLE_LABEL[req.requested_role]}</td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{format(new Date(req.created_date), 'yyyy.MM.dd')}</td>
                      <td className="px-4 py-2.5">
                        <span className={cn("text-[11px] px-2 py-0.5 rounded border", sc?.color)}>{sc?.label}</span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{req.admin_notes || '–'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Deny Modal */}
      {denyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
          <div className="w-full max-w-sm rounded-xl border border-border bg-card shadow-2xl p-5 space-y-4">
            <h3 className="text-sm font-semibold text-foreground">등급 요청 거부</h3>
            <p className="text-xs text-muted-foreground">
              <span className="text-foreground font-medium">{denyModal.user_name}</span>님의 요청을 거부합니다.
            </p>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">거부 사유 (선택)</label>
              <textarea
                value={denyNote}
                onChange={e => setDenyNote(e.target.value)}
                placeholder="거부 사유를 입력하세요..."
                rows={3}
                className="w-full px-3 py-2 text-sm bg-accent border border-border rounded-md text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDenyModal(null)} className="h-8 px-4 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-accent transition-colors">취소</button>
              <button
                onClick={handleDeny}
                disabled={!!processing}
                className="h-8 px-4 text-xs font-medium bg-red-500/20 text-red-400 border border-red-500/30 rounded-md hover:bg-red-500/30 transition-colors disabled:opacity-50"
              >
                거부 확인
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}