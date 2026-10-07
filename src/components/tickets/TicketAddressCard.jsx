import { MapPin, Pencil } from 'lucide-react';

// Address updates are not enabled in this read-only stage.
export default function TicketAddressCard({ ticket }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <MapPin className="w-3.5 h-3.5" /> 현장 지원 출동 주소
        </h4>
        <button disabled title="주소 수정 준비 중" className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md border border-border bg-accent text-muted-foreground">
          <Pencil className="w-3 h-3" /> 주소 수정 (준비 중)
        </button>
      </div>

      {ticket.address ? (
        <p className="text-xs text-foreground leading-relaxed break-words">
          {ticket.address}
          {ticket.address_detail && <span className="text-muted-foreground"> {ticket.address_detail}</span>}
        </p>
      ) : (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full border border-[#2A364F] bg-[#0F172A] text-[11px] text-muted-foreground">
          미입력
        </span>
      )}
    </div>
  );
}
