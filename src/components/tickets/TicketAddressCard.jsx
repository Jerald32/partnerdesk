import { useState } from 'react';
import { MapPin, Pencil } from 'lucide-react';
import AddressField from './AddressField';

export default function TicketAddressCard({ ticket, editable = false, disabled = false, onSave }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState({ address: ticket.address || '', address_detail: ticket.address_detail || '' });
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <MapPin className="w-3.5 h-3.5" /> 현장 지원 출동 주소
        </h4>
        {editable && <button disabled={disabled} onClick={() => { setValue({ address: ticket.address || '', address_detail: ticket.address_detail || '' }); setEditing(true); }} className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md border border-border bg-accent text-muted-foreground">
          <Pencil className="w-3 h-3" /> 주소 수정
        </button>}
      </div>

      {editing ? <fieldset disabled={disabled} className="space-y-2">
        <AddressField value={value} onChange={setValue} />
        <div className="flex justify-end gap-2 text-xs">
          <button onClick={() => setEditing(false)}>취소</button>
          <button onClick={async () => { if (await onSave(value)) setEditing(false); }}>저장</button>
        </div>
      </fieldset> : ticket.address ? (
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
