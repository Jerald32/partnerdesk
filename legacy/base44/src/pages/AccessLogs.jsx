import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { History, RefreshCw } from 'lucide-react';
import { format } from 'date-fns';
import AccessLogBackupPanel from '@/components/audit/AccessLogBackupPanel';

const ROLE_LABEL = { admin: 'Admin', operator: 'Operator', partner_admin: 'Partner Admin', partner: 'Partner', guest: 'Guest', user: 'Guest' };

const ACTION_STYLE = {
  '로그인': 'bg-primary/15 text-primary border-primary/30',
  '조회': 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  '출력': 'bg-orange-500/15 text-orange-400 border-orange-500/30',
};

export default function AccessLogs() {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [me, list, count] = await Promise.all([
        base44.auth.me(),
        base44.entities.AccessLog.list('-accessed_at', 200),
        base44.entities.AccessLog.count(),
      ]);
      if (me?.role !== 'admin') {
        setError('접속기록은 관리자만 조회할 수 있습니다.');
        setLogs([]);
        setTotal(0);
        return;
      }
      setLogs(list);
      setTotal(count);
    } catch (err) {
      setError(err?.message || '접속기록을 불러오지 못했습니다.');
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
            <History className="w-4 h-4 text-primary" /> 접속기록
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            총 {total}건 · 접속자 식별자, 접속 일시, 접속지 정보(IP), 처리한 정보주체의 정보, 수행 업무가 기록됩니다
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

      <AccessLogBackupPanel />

      {loading ? (
        <div className="rounded-lg border border-border bg-card p-4 space-y-2">
          {Array(8).fill(0).map((_, i) => (
            <div key={i} className="h-8 bg-accent rounded animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="py-10 text-center text-destructive text-sm">{error}</div>
      ) : logs.length === 0 ? (
        <div className="py-10 text-center text-muted-foreground text-sm">접속기록이 없습니다</div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {['접속 일시', '접속자 식별자', '접속지 정보 (IP)', '수행 업무', '업무 대상', '처리한 정보주체의 정보'].map(col => (
                    <th key={col} className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground whitespace-nowrap">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {logs.map(log => (
                  <tr key={log.id} className="border-b border-border last:border-0 hover:bg-accent/40 transition-colors">
                    <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                      {log.accessed_at ? format(new Date(log.accessed_at), 'yyyy.MM.dd HH:mm:ss') : '–'}
                    </td>
                    <td className="px-4 py-2.5 text-xs whitespace-nowrap">
                      <div className="text-foreground">{log.user_name || '–'}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {log.user_email} · {ROLE_LABEL[log.user_role] || log.user_role || '–'}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-xs font-mono text-muted-foreground whitespace-nowrap">
                      {log.user_ip || '확인 불가'}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className={`text-[11px] px-2 py-0.5 rounded border ${ACTION_STYLE[log.action] || 'bg-accent text-muted-foreground border-border'}`}>
                        {log.action || '–'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {log.target_type || '–'}
                      {log.target_id && <span className="ml-1 font-mono text-[11px]">#{log.target_id.slice(-6)}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-foreground max-w-[320px]">
                      <div className="truncate" title={log.subject_info || ''}>{log.subject_info || '–'}</div>
                      {log.detail && <div className="text-[11px] text-muted-foreground truncate" title={log.detail}>{log.detail}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}