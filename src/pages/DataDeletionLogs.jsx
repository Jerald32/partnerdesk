import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { ScrollText, ShieldCheck, Trash2, Eraser, ShieldAlert } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

const ENTITY_LABEL = {
  ticket: '티켓',
  activity: '활동 이력',
  notification: '알림',
};

const METHOD_CONFIG = {
  anonymized: { label: '비식별화', color: 'text-blue-400 bg-blue-500/10 border-blue-500/20' },
  deleted: { label: '삭제', color: 'text-red-400 bg-red-500/10 border-red-500/20' },
};

export default function DataDeletionLogs() {
  const [currentUser, setCurrentUser] = useState(null);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterEntity, setFilterEntity] = useState('');
  const [filterMethod, setFilterMethod] = useState('');

  const load = async () => {
    const me = await base44.auth.me();
    setCurrentUser(me);
    if (me?.role === 'admin') {
      const data = await base44.entities.DataDeletionLog.list('-run_date', 200);
      setLogs(data);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  if (!loading && currentUser?.role !== 'admin') {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center gap-3">
        <ShieldAlert className="w-10 h-10 text-destructive" />
        <p className="text-sm font-medium text-foreground">접근 권한이 없습니다</p>
        <p className="text-xs text-muted-foreground">이 페이지는 관리자 전용입니다.</p>
      </div>
    );
  }

  // 같은 run_date(실행 회차)별로 그룹화
  const grouped = logs.reduce((acc, log) => {
    const key = log.run_date;
    if (!acc[key]) acc[key] = [];
    acc[key].push(log);
    return acc;
  }, {});
  const runs = Object.entries(grouped).sort((a, b) => new Date(b[0]) - new Date(a[0]));

  // 요약 통계
  const totalAnonymized = logs.filter(l => l.method === 'anonymized').reduce((s, l) => s + (l.count || 0), 0);
  const totalDeleted = logs.filter(l => l.method === 'deleted').reduce((s, l) => s + (l.count || 0), 0);
  const totalRuns = runs.length;

  const filtered = logs.filter(l =>
    (!filterEntity || l.entity_type === filterEntity) &&
    (!filterMethod || l.method === filterMethod)
  );
  const filteredRuns = Object.entries(
    filtered.reduce((acc, log) => {
      const key = log.run_date;
      if (!acc[key]) acc[key] = [];
      acc[key].push(log);
      return acc;
    }, {})
  ).sort((a, b) => new Date(b[0]) - new Date(a[0]));

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">파기 이력</h2>
        <p className="text-xs text-muted-foreground mt-0.5">개인정보 보관기한(3년) 경과 데이터 비식별화·삭제 이력</p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <ScrollText className="w-3.5 h-3.5" />
            <span className="text-xs">실행 회차</span>
          </div>
          <p className="text-xl font-semibold text-foreground mt-1.5">{totalRuns}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Eraser className="w-3.5 h-3.5" />
            <span className="text-xs">비식별화 건수</span>
          </div>
          <p className="text-xl font-semibold text-blue-400 mt-1.5">{totalAnonymized.toLocaleString()}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Trash2 className="w-3.5 h-3.5" />
            <span className="text-xs">삭제 건수</span>
          </div>
          <p className="text-xl font-semibold text-red-400 mt-1.5">{totalDeleted.toLocaleString()}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setFilterEntity('')}
          className={cn("h-7 px-3 text-xs rounded-md transition-colors", filterEntity === '' ? "bg-primary text-primary-foreground" : "bg-accent text-muted-foreground hover:text-foreground")}
        >
          전체 항목
        </button>
        {Object.entries(ENTITY_LABEL).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setFilterEntity(k)}
            className={cn("h-7 px-3 text-xs rounded-md transition-colors", filterEntity === k ? "bg-primary text-primary-foreground" : "bg-accent text-muted-foreground hover:text-foreground")}
          >
            {label}
          </button>
        ))}
        <span className="w-px h-4 bg-border mx-1" />
        <button
          onClick={() => setFilterMethod('')}
          className={cn("h-7 px-3 text-xs rounded-md transition-colors", filterMethod === '' ? "bg-primary text-primary-foreground" : "bg-accent text-muted-foreground hover:text-foreground")}
        >
          전체 방식
        </button>
        {Object.entries(METHOD_CONFIG).map(([k, conf]) => (
          <button
            key={k}
            onClick={() => setFilterMethod(k)}
            className={cn("h-7 px-3 text-xs rounded-md transition-colors", filterMethod === k ? "bg-primary text-primary-foreground" : "bg-accent text-muted-foreground hover:text-foreground")}
          >
            {conf.label}
          </button>
        ))}
      </div>

      {/* Runs (grouped by execution) */}
      <div className="space-y-3">
        {loading ? (
          <div className="space-y-2">
            {Array(2).fill(0).map((_, i) => (
              <div key={i} className="h-20 bg-accent rounded-lg animate-pulse" />
            ))}
          </div>
        ) : filteredRuns.length === 0 ? (
          <div className="py-12 text-center">
            <ShieldCheck className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">파기 이력이 없습니다</p>
          </div>
        ) : (
          filteredRuns.map(([runDate, items]) => (
            <div key={runDate} className="rounded-lg border border-border bg-card overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-accent/50">
                <div className="flex items-center gap-2">
                  <ScrollText className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium text-foreground">
                    {format(new Date(runDate), 'yyyy.MM.dd HH:mm')} 실행
                  </span>
                  {items[0]?.triggered_by === 'automation' ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">자동</span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-muted-foreground border border-border">수동</span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">기준일 {items[0]?.retention_threshold}</span>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {items.map(log => {
                    const mc = METHOD_CONFIG[log.method];
                    return (
                      <tr key={log.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-2.5">
                          <span className="text-xs text-foreground">{ENTITY_LABEL[log.entity_type] || log.entity_type}</span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={cn("text-[11px] px-2 py-0.5 rounded border", mc?.color)}>{mc?.label}</span>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-foreground font-medium">{(log.count || 0).toLocaleString()}건</td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground truncate max-w-xs">{log.details || '–'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))
        )}
      </div>
    </div>
  );
}