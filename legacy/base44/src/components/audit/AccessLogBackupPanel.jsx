import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Archive, ShieldCheck, Download, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { format } from 'date-fns';

const TRIGGER_LABEL = { automation: '자동', manual: '수동' };

export default function AccessLogBackupPanel() {
  const [backups, setBackups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);

  const loadBackups = async () => {
    const list = await base44.entities.AccessLogBackup.list('-run_date', 10);
    setBackups(list || []);
  };

  useEffect(() => {
    loadBackups()
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const runVerify = async () => {
    setBusy('verify');
    setResult(null);
    try {
      const res = await base44.functions.invoke('backupAccessLogs', { action: 'verify' });
      const d = res.data || {};
      setResult({
        ok: d.ok,
        text: d.ok
          ? `무결성 이상 없음 — 검증 ${d.checked}건 (전체 ${d.total}건)`
          : `위·변조 의심 — ${(d.issues || []).join(' / ')}`,
      });
    } catch (err) {
      setResult({ ok: false, text: err?.response?.data?.error || '무결성 검증에 실패했습니다.' });
    } finally {
      setBusy('');
    }
  };

  const runBackup = async () => {
    setBusy('backup');
    setResult(null);
    try {
      const res = await base44.functions.invoke('backupAccessLogs', {});
      const d = res.data || {};
      await loadBackups();
      setResult({ ok: d.integrity?.ok, text: `백업 완료 — ${d.log_count}건 (파일: ${d.file_name})` });
    } catch (err) {
      setResult({ ok: false, text: err?.response?.data?.error || '백업 실행에 실패했습니다.' });
    } finally {
      setBusy('');
    }
  };

  const download = async (backup) => {
    setBusy(backup.id);
    try {
      const res = await base44.functions.invoke('backupAccessLogs', { action: 'download', backup_id: backup.id });
      const url = res.data?.signed_url;
      if (url) window.open(url, '_blank');
      else setResult({ ok: false, text: '백업 파일을 내려받을 수 없습니다.' });
    } catch (err) {
      setResult({ ok: false, text: err?.response?.data?.error || '내려받기에 실패했습니다.' });
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Archive className="w-4 h-4 text-primary" /> 보관 · 백업
          </h3>
          <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
            접속기록은 등록·조회만 가능하고 수정·삭제는 차단됩니다. 기록마다 무결성 해시가 연결되어 위·변조 여부를 확인할 수
            있으며, 매일 새벽 3시에 전체 접속기록이 별도 보관용 파일로 자동 백업됩니다. 내려받는 파일에는 접속자 식별정보(이름·이메일·IP)와
            정보주체 정보가 마스킹되어 저장됩니다.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={runVerify}
            disabled={!!busy}
            className="flex items-center gap-1.5 h-8 px-3 text-xs font-medium border border-border text-muted-foreground rounded-md hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50"
          >
            {busy === 'verify' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
            무결성 검증
          </button>
          <button
            onClick={runBackup}
            disabled={!!busy}
            className="flex items-center gap-1.5 h-8 px-3 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {busy === 'backup' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Archive className="w-3.5 h-3.5" />}
            지금 백업
          </button>
        </div>
      </div>

      {result && (
        <div
          className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
            result.ok
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
              : 'border-orange-500/30 bg-orange-500/10 text-orange-400'
          }`}
        >
          {result.ok ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5" /> : <AlertTriangle className="w-3.5 h-3.5 mt-0.5" />}
          <span>{result.text}</span>
        </div>
      )}

      {loading ? (
        <div className="h-16 bg-accent rounded animate-pulse" />
      ) : backups.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">백업 이력이 없습니다. 첫 백업은 매일 새벽 3시에 자동 실행됩니다.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                {['백업 일시', '대상 건수', '무결성', '실행', '백업 파일'].map((col) => (
                  <th key={col} className="text-left px-3 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                    {b.run_date ? format(new Date(b.run_date), 'yyyy.MM.dd HH:mm') : '–'}
                  </td>
                  <td className="px-3 py-2 text-xs text-foreground whitespace-nowrap">{b.log_count ?? 0}건</td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    <span className={b.integrity_ok ? 'text-emerald-400' : 'text-orange-400'}>
                      {b.integrity_ok ? '정상' : '확인 필요'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">{TRIGGER_LABEL[b.triggered_by] || '–'}</td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    <button
                      onClick={() => download(b)}
                      disabled={!!busy || !b.file_uri}
                      className="flex items-center gap-1.5 text-primary hover:underline disabled:opacity-40 disabled:no-underline"
                    >
                      {busy === b.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                      내려받기
                    </button>
                    {b.file_hash && (
                      <span className="ml-2 font-mono text-[10px] text-muted-foreground" title={b.file_hash}>
                        #{b.file_hash.slice(0, 10)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}