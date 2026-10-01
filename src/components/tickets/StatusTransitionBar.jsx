import { cn } from '@/lib/utils';
import { Check, ChevronRight } from 'lucide-react';

const STATUSES = [
  { key: 'new', label: '신규', color: 'border-slate-500 text-slate-400', activeColor: 'bg-slate-500/20 border-slate-500 text-slate-300' },
  { key: 'inprogress', label: '진행중', color: 'border-blue-500 text-blue-400', activeColor: 'bg-blue-500/20 border-blue-500 text-blue-300' },
  { key: 'hold', label: '보류', color: 'border-orange-500 text-orange-400', activeColor: 'bg-orange-500/20 border-orange-500 text-orange-300' },
  { key: 'done', label: '완료', color: 'border-emerald-500 text-emerald-400', activeColor: 'bg-emerald-500/20 border-emerald-500 text-emerald-300' },
];

export default function StatusTransitionBar({ currentStatus, onTransition, disabled = false }) {
  const currentIdx = STATUSES.findIndex(s => s.key === currentStatus);

  return (
    <div className="flex items-center gap-1">
      {STATUSES.map((s, idx) => {
        const isActive = s.key === currentStatus;
        const isPast = idx < currentIdx;
        
        return (
          <div key={s.key} className="flex items-center gap-1">
            <button
              onClick={() => !isActive && !disabled && onTransition(s.key)}
              disabled={disabled || isActive}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-all duration-150",
                isActive
                  ? s.activeColor + " cursor-default ring-1 ring-offset-0"
                  : isPast
                  ? "border-border text-muted-foreground bg-transparent opacity-60"
                  : s.color + " bg-transparent hover:bg-accent cursor-pointer",
                disabled && "cursor-not-allowed opacity-50"
              )}
            >
              {isPast && <Check className="w-3 h-3" />}
              {s.label}
            </button>
            {idx < STATUSES.length - 1 && (
              <ChevronRight className="w-3 h-3 text-muted-foreground/40" />
            )}
          </div>
        );
      })}
    </div>
  );
}