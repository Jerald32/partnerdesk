import { cn } from '@/lib/utils';

const STATUS_CONFIG = {
  new:        { label: '신규',   color: 'bg-slate-500/20 text-slate-400 border-slate-500/30' },
  inprogress: { label: '진행중', color: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  hold:       { label: '보류',   color: 'bg-orange-500/20 text-orange-400 border-orange-500/30' },
  done:       { label: '완료',   color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
};

const PRIORITY_CONFIG = {
  low:    { label: '낮음',   color: 'bg-slate-500/20 text-slate-400 border-slate-500/30' },
  normal: { label: '보통',   color: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  high:   { label: '높음',   color: 'bg-orange-500/20 text-orange-400 border-orange-500/30' },
  urgent: { label: '긴급',   color: 'bg-red-500/20 text-red-400 border-red-500/30' },
};

export function StatusBadge({ status, className }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.new;
  return (
    <span className={cn(
      "inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border",
      config.color, className
    )}>
      <span className={cn("w-1.5 h-1.5 rounded-full", 
        status === 'new' && "bg-slate-400",
        status === 'inprogress' && "bg-blue-400",
        status === 'hold' && "bg-orange-400",
        status === 'done' && "bg-emerald-400",
      )} />
      {config.label}
    </span>
  );
}

export function PriorityBadge({ priority, className }) {
  const config = PRIORITY_CONFIG[priority] || PRIORITY_CONFIG.normal;
  return (
    <span className={cn(
      "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border",
      config.color, className
    )}>
      {config.label}
    </span>
  );
}

export { STATUS_CONFIG, PRIORITY_CONFIG };