import { useState } from 'react';
import { useRpcAction } from '@/hooks/useRpcAction';
import { X } from 'lucide-react';

function formatPartnerError(error) {
  const guidance = error.message === 'role_not_allowed'
    ? 'Partner 생성은 admin만 가능합니다.'
    : error.code === '28000'
      ? '앱 세션이 유효하지 않습니다. 다시 로그인해 주세요.'
      : error.code === 'PGRST202'
        ? '연결된 Supabase에서 create_partner RPC를 찾지 못했습니다.'
        : 'Partner를 생성하지 못했습니다.';
  return `${guidance} [${error.code}] ${error.message || ''}`;
}

export default function CreatePartnerModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', type: 'manufacturer', contact_name: '', contact_email: '', contact_phone: '' });
  const { run, busy: saving, error, unknown } = useRpcAction(onCreated, formatPartnerError);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const inputClass = "w-full h-8 px-3 text-sm bg-accent border border-border rounded-md text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring";
  const labelClass = "block text-xs font-medium text-muted-foreground mb-1";

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    void run('create_partner', {
      p_name: form.name.trim(), p_partner_type: form.type,
      p_contact_name: form.contact_name.trim() || null, p_contact_email: form.contact_email.trim() || null,
      p_contact_phone: form.contact_phone.trim() || null,
    }, data => typeof data?.organization_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.organization_id));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground">새 파트너 추가</h3>
          <button disabled={saving} onClick={onClose} className="p-1 rounded hover:bg-accent transition-colors">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-3">
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          <fieldset disabled={saving || unknown} className="space-y-3">
          <div>
            <label className={labelClass}>파트너명 *</label>
            <input required value={form.name} onChange={e => set('name', e.target.value)} placeholder="(주)예시파트너" className={inputClass} />
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
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>담당자명</label>
              <input value={form.contact_name} onChange={e => set('contact_name', e.target.value)} placeholder="홍길동" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>연락처</label>
              <input value={form.contact_phone} onChange={e => set('contact_phone', e.target.value)} placeholder="010-0000-0000" className={inputClass} />
            </div>
          </div>
          <div>
            <label className={labelClass}>이메일</label>
            <input type="email" value={form.contact_email} onChange={e => set('contact_email', e.target.value)} placeholder="contact@partner.com" className={inputClass} />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" disabled={saving} onClick={onClose} className="h-8 px-4 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-accent transition-colors">취소</button>
            <button type="submit" disabled={saving || unknown} className="h-8 px-4 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50">
              {saving ? '저장 중...' : '파트너 추가'}
            </button>
          </div>
          </fieldset>
        </form>
      </div>
    </div>
  );
}
