import { cn } from '@/lib/utils';
import { Clock, AlertTriangle } from 'lucide-react';

export default function SlaBar({ createdAt, slaHours = 24, compact = false }) {
  const now = new Date();
  const created = new Date(createdAt);
  const elapsed = (now - created) / (1000 * 60 * 60); // hours
  const percent = Math.min((elapsed / slaHours) * 100, 100);
  const remaining = Math.max(slaHours - elapsed, 0);
  const isWarning = percent >= 75 && percent < 100;
  const isBreach = percent >= 100;

  const barColor = isBreach
    ? 'bg-red-500'
    : isWarning
    ? 'bg-orange-400'
    : 'bg-primary';

  const textColor = isBreach
    ? 'text-red-400'
    : isWarning
    ? 'text-orange-400'
    : 'text-muted-foreground';

  const formatRemaining = (hrs) => {
    if (hrs <= 0) return '초과';
    if (hrs < 1) return `${Math.round(hrs * 60)}분`;
    return `${Math.round(hrs)}시간`;
  };

  if (compact) {
    return (
      <div className="flex items-center gap-1.5 w-full">
        {(isWarning || isBreach) && (
          <AlertTriangle className={cn("w-3 h-3 shrink-0", isBreach ? "text-red-400" : "text-orange-400")} />
        )}
        <div className="flex-1 h-1 bg-border rounded-full overflow-hidden">
          <div className={cn("h-full rounded-full transition-all", barColor)} style={{ width: `${percent}%` }} />
        </div>
        <span className={cn("text-[10px] shrink-0", textColor)}>
          {isBreach ? '초과' : `${Math.round(percent)}%`}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <div className={cn("flex items-center gap-1", textColor)}>
          <Clock className="w-3.5 h-3.5" />
          <span>SLA {isBreach ? '초과' : isWarning ? '경고' : '정상'}</span>
        </div>
        <span className={cn("font-medium", textColor)}>
          {isBreach ? `${Math.round(elapsed - slaHours)}시간 초과` : `${formatRemaining(remaining)} 남음`}
        </span>
      </div>
      <div className="h-1.5 bg-border rounded-full overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-500", barColor)}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{Math.round(elapsed * 10) / 10}h 경과</span>
        <span>기준 {slaHours}h</span>
      </div>
    </div>
  );
}