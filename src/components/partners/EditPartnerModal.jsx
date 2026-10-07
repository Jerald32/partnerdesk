import { useState } from 'react';
import { useRpcAction } from '@/hooks/useRpcAction';
import { X } from 'lucide-react';

export default function EditPartnerModal({ partner, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: partner.name || '',
    type: partner.type || 'other',
    contact_name: partner.contact_name || '',
    contact_email: partner.contact_email || '',
    contact_phone: partner.contact_phone || '',
    description: partner.description || '',
    logo_url: partner.logo_url || '',
  });
  const { run, busy: saving, error, unknown } = useRpcAction(onSaved);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const inputClass = "w-full h-8 px-3 text-sm bg-accent border border-border rounded-md text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring";
  const labelClass = "block text-xs font-medium text-muted-foreground mb-1";

  const handleSubmit = async (e) => {
    e.preventDefault();
    void run('update_partner', {
      p_partner_organization_id: partner.id,
      p_name: form.name.trim(), p_partner_type: form.type,
      p_contact_name: form.contact_name.trim() || null, p_contact_email: form.contact_email.trim() || null,
      p_contact_phone: form.contact_phone.trim() || null,
      p_description: form.description.trim() || null,
    }, data => typeof data?.organization_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.organization_id) && data.organization_id === partner.id);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border sticky top-0 bg-card z-10">
          <h3 className="text-sm font-semibold text-foreground">파트너 편집</h3>
          <button disabled={saving} onClick={onClose} className="p-1 rounded hover:bg-accent transition-colors">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-3">
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          <fieldset disabled={saving || unknown} className="space-y-3">
          <div>
            <label className={labelClass}>파트너명 *</label>
            <input required value={form.name} onChange={e => set('name', e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>유형</label>
            <select value={form.type} onChange={e => set('type', e.target.value)} className={inputClass + " appearance-none cursor-pointer"}>
              <option value="manufacturer">제조사</option>
              <option value="maintenance">유지보수</option>
              <option value="installation">설치</option>
              <option value="support">지원</option>
              <option value="other">기타</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>설명</label>
            <textarea value={form.description} onChange={e => set('description', e.target.value)} placeholder="파트너사 소개" rows={3} className="w-full px-3 py-2 text-sm bg-accent border border-border rounded-md text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>담당자명</label>
              <input value={form.contact_name} onChange={e => set('contact_name', e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>연락처</label>
              <input value={form.contact_phone} onChange={e => set('contact_phone', e.target.value)} className={inputClass} />
            </div>
          </div>
          <div>
            <label className={labelClass}>이메일</label>
            <input type="email" value={form.contact_email} onChange={e => set('contact_email', e.target.value)} className={inputClass} />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" disabled={saving} onClick={onClose} className="h-8 px-4 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-accent transition-colors">취소</button>
            <button type="submit" disabled={saving || unknown} className="h-8 px-4 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50">
              {saving ? '저장 중...' : '저장'}
            </button>
          </div>
          </fieldset>
        </form>
      </div>
    </div>
  );
}