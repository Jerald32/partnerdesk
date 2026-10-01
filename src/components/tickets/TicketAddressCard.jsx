import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { MapPin, Pencil, X, Check } from 'lucide-react';
import AddressField from '@/components/tickets/AddressField';

// 티켓 상세 — 현장 지원 출동 주소 카드 (조회 + 인라인 수정)
export default function TicketAddressCard({ ticket, editable, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [value, setValue] = useState({ address: '', address_detail: '' });

  const startEdit = () => {
    setValue({ address: ticket.address || '', address_detail: ticket.address_detail || '' });
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    await base44.entities.Ticket.update(ticket.id, {
      address: value.address,
      address_detail: value.address_detail,
    });
    setSaving(false);
    setEditing(false);
    onSaved?.();
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <MapPin className="w-3.5 h-3.5" /> 현장 지원 출동 주소
        </h4>
        {editable && !editing && (
          <button
            onClick={startEdit}
            className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md border border-border bg-accent text-muted-foreground hover:text-foreground transition-colors"
          >
            <Pencil className="w-3 h-3" /> 주소 수정
          </button>
        )}
      </div>

      {editing ? (
        <div className="space-y-3">
          <AddressField value={value} onChange={setValue} />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setEditing(false)}
              className="flex items-center gap-1 h-7 px-3 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-accent transition-colors"
            >
              <X className="w-3 h-3" /> 취소
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="flex items-center gap-1 h-7 px-3 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              <Check className="w-3 h-3" /> {saving ? '저장 중...' : '저장'}
            </button>
          </div>
        </div>
      ) : ticket.address ? (
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