import { ChevronRight, Ticket, Pencil } from 'lucide-react';

const TYPE_LABELS = {
  manufacturer: '제조사',
  maintenance: '유지보수',
  installation: '설치',
  support: '지원',
  other: '기타',
};

export default function PartnerMobileCard({ partner, businessNames = [], activeCount = 0, doneCount = 0, sla = null, onClick, onEdit }) {
  return (
    <div onClick={onClick} className="rounded-lg border border-border bg-card p-3 active:bg-accent cursor-pointer transition-colors">
      <div className="flex items-center gap-2.5 mb-2">
        <div className="w-8 h-8 rounded-full overflow-hidden bg-emerald-500/20 flex items-center justify-center text-sm font-semibold text-emerald-400 shrink-0">
          {partner.logo_url ? <img src={partner.logo_url} alt="" className="w-full h-full object-cover" /> : partner.name?.[0]?.toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">{partner.name}</p>
          {partner.contact_email && <p className="text-[11px] text-muted-foreground truncate">{partner.contact_email}</p>}
        </div>
        {onEdit && (
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(partner); }}
            className="p-1.5 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors shrink-0"
            title="편집"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
        <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
      </div>
      <div className="flex flex-wrap gap-1 mb-2">
        {businessNames.length > 0
          ? businessNames.map(name => (
              <span key={name} className="text-[11px] px-1.5 py-0.5 bg-primary/10 text-primary rounded border border-primary/20">{name}</span>
            ))
          : <span className="text-xs text-muted-foreground">담당 비즈니스 없음</span>}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="px-1.5 py-0.5 bg-accent rounded border border-border">{TYPE_LABELS[partner.type] || partner.type}</span>
        <span className="flex items-center gap-1 text-orange-400"><Ticket className="w-3 h-3" />진행중 {activeCount}</span>
        <span>완료 {doneCount}</span>
        {sla !== null && (
          <span className={sla >= 80 ? 'text-emerald-400 font-medium' : sla >= 60 ? 'text-orange-400 font-medium' : 'text-red-400 font-medium'}>SLA {sla}%</span>
        )}
      </div>
    </div>
  );
}