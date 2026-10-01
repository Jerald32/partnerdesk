import { StatusBadge, PriorityBadge } from '@/components/ui/StatusBadge';
import SlaBar from '@/components/ui/SlaBar';
import { format } from 'date-fns';
import { maskName, maskPhone, regionSummary } from '@/lib/mask';

export default function TicketMobileCard({ ticket, businesses = [], partners = [], onClick }) {
  const getBusinessName = id => businesses.find(b => b.id === id)?.name || '–';
  const getPartnerName = id => partners.find(p => p.id === id)?.name || '–';

  return (
    <div onClick={onClick} className="rounded-lg border border-border bg-card p-3 active:bg-accent cursor-pointer transition-colors">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[11px] font-mono text-muted-foreground">#{ticket.id?.slice(-6)}</span>
        <div className="flex items-center gap-1.5">
          <StatusBadge status={ticket.status} />
          <PriorityBadge priority={ticket.priority} />
        </div>
      </div>
      <p className="text-sm font-medium text-foreground truncate mb-2">{ticket.title}</p>
      <div className="grid grid-cols-2 gap-y-1 gap-x-2 text-[11px]">
        <div className="text-muted-foreground truncate"><span className="opacity-60">비즈니스 </span>{getBusinessName(ticket.business_id)}</div>
        <div className="text-muted-foreground truncate"><span className="opacity-60">유형 </span>{ticket.request_type || '–'}</div>
        <div className="text-muted-foreground truncate">
          <span className="opacity-60">고객 </span>{maskName(ticket.customer_name)}
          <span className="block opacity-60 truncate">{maskPhone(ticket.customer_contact)}</span>
        </div>
        <div className="text-muted-foreground truncate">
          <span className="opacity-60">상호 </span>{ticket.customer_company || '–'}
          <span className="block opacity-60 truncate">{regionSummary(ticket.address)}</span>
        </div>
        <div className="text-muted-foreground truncate"><span className="opacity-60">파트너 </span>{getPartnerName(ticket.partner_id)}</div>
        <div className="text-muted-foreground truncate"><span className="opacity-60">담당자 </span>{ticket.operator_name || <span className="text-slate-400">미배정</span>}</div>
        <div className="text-muted-foreground truncate"><span className="opacity-60">생성 </span>{format(new Date(ticket.created_date), 'MM/dd HH:mm')}</div>
      </div>
      <div className="mt-2.5">
        <SlaBar createdAt={ticket.created_date} slaHours={24} compact />
      </div>
    </div>
  );
}