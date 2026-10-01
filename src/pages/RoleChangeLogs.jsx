import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { ShieldCheck, RefreshCw } from 'lucide-react';
import { format } from 'date-fns';

const ROLE_LABEL = { admin: 'Admin', operator: 'Operator', partner_admin: 'Partner Admin', partner: 'Partner', guest: 'Guest', user: 'Guest' };
const ORG_TYPE_LABEL = { operator_company: '운영사', partner: '파트너' };

const roleText = (v) => (v ? ROLE_LABEL[v] || v : '–');
const orgText = (v) => (v ? ORG_TYPE_LABEL[v] || v : '–');
const dt = (v) => (v ? format(new Date(v), 'yyyy.MM.dd HH:mm') : '–');

function ChangeRow({ log, partnersById }) {
  const affiliationText = (v) => (!v ? '–' : partnersById[v] || v);
  const roleChanged = log.role_before !== log.role_after;
  const orgChanged = log.org_type_before !== log.org_type_after;
  const affChanged = log.affiliation_before !== log.affiliation_after;

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-2.5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-foreground">{log.target_name || '–'}</span>
            <span className="text-xs text-muted-foreground">{log.target_email}</span>
            <span className="text-[11px] px-2 py-0.5 rounded border bg-accent text-muted-foreground border-border">
              {log.change_type === 'request_approved' ? '요청 승인' : '관리자 직접 변경'}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">변경일시 {dt(log.changed_at)}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
        <div className="rounded-md border border-border px-3 py-2">
          <p className="text-muted-foreground mb-0.5">등급</p>
          <p className={roleChanged ? 'text-foreground font-medium' : 'text-muted-foreground'}>
            {roleText(log.role_before)} <span className="text-muted-foreground">→</span> {roleText(log.role_after)}
          </p>
        </div>
        <div className="rounded-md border border-border px-3 py-2">
          <p className="text-muted-foreground mb-0.5">소속사 등급</p>
          <p className={orgChanged ? 'text-foreground font-medium' : 'text-muted-foreground'}>
            {orgText(log.org_type_before)} <span className="text-muted-foreground">→</span> {orgText(log.org_type_after)}
          </p>
        </div>
        <div className="rounded-md border border-border px-3 py-2">
          <p className="text-muted-foreground mb-0.5">소속사</p>
          <p className={affChanged ? 'text-foreground font-medium' : 'text-muted-foreground'}>
            {affiliationText(log.affiliation_before)} <span className="text-muted-foreground">→</span> {affiliationText(log.affiliation_after)}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <p>
          신청자: <span className="text-foreground">{log.requester_name || '–'}</span>
          {log.requester_email && <span className="ml-1">({log.requester_email})</span>}
          <span className="ml-1">· 신청일시 {dt(log.requested_at)}</span>
        </p>
        <p>
          승인·실행자: <span className="text-foreground">{log.actor_name || '–'}</span>
          <span className="ml-1">({roleText(log.actor_role)})</span>
          <span className="ml-1">· {log.actor_email}</span>
        </p>
        <p>
          접속 IP: <span className="text-foreground font-mono">{log.actor_ip || '확인 불가'}</span>
        </p>
        <p>
          실행 경로: <span className="text-foreground font-mono">{log.source_api || '–'}</span>
        </p>
      </div>

      <div className="text-[11px]">
        <p className="text-muted-foreground">
          신청 사유: <span className="text-foreground">{log.request_reason || '–'}</span>
        </p>
        <p className="text-muted-foreground">
          발급(승인) 사유: <span className="text-foreground">{log.issue_reason || '–'}</span>
        </p>
      </div>
    </div>
  );
}

export default function RoleChangeLogs() {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [partnersById, setPartnersById] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [me, list, count, partners] = await Promise.all([
        base44.auth.me(),
        base44.entities.RoleChangeLog.list('-changed_at', 200),
        base44.entities.RoleChangeLog.count(),
        base44.entities.Partner.list(),
      ]);
      if (me?.role !== 'admin') {
        setError('권한 변경 이력은 관리자만 조회할 수 있습니다.');
        setLogs([]);
        setTotal(0);
        return;
      }
      const map = {};
      partners.forEach((p) => { map[p.id] = p.name; });
      setPartnersById(map);
      setLogs(list);
      setTotal(count);
    } catch (err) {
      setError(err?.message || '이력을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-primary" /> 권한 변경 이력
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            총 {total}건 · 신청자·승인자·접속 IP·변경 전후 권한·사유가 함께 기록됩니다
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 h-8 px-3 text-xs font-medium border border-border text-muted-foreground rounded-md hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50"
        >
          <RefreshCw className="w-3.5 h-3.5" /> 새로고침
        </button>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array(3).fill(0).map((_, i) => (
            <div key={i} className="h-40 bg-accent rounded-lg animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="py-10 text-center text-destructive text-sm">{error}</div>
      ) : logs.length === 0 ? (
        <div className="py-10 text-center text-muted-foreground text-sm">권한 변경 이력이 없습니다</div>
      ) : (
        <div className="space-y-2">
          {logs.map((log) => (
            <ChangeRow key={log.id} log={log} partnersById={partnersById} />
          ))}
        </div>
      )}
    </div>
  );
}