import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { X, Upload, Trash2 } from 'lucide-react';

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
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const inputClass = "w-full h-8 px-3 text-sm bg-accent border border-border rounded-md text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring";
  const labelClass = "block text-xs font-medium text-muted-foreground mb-1";

  const handleLogoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const { file_url } = await base44.integrations.Core.UploadFile({ file });
    set('logo_url', file_url);
    setUploading(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    await base44.entities.Partner.update(partner.id, form);
    onSaved();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border sticky top-0 bg-card z-10">
          <h3 className="text-sm font-semibold text-foreground">파트너 편집</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent transition-colors">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-3">
          <div>
            <label className={labelClass}>로고</label>
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg border border-border bg-accent overflow-hidden flex items-center justify-center shrink-0">
                {form.logo_url ? (
                  <img src={form.logo_url} alt="logo" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-sm text-muted-foreground font-semibold">{form.name?.[0]?.toUpperCase() || 'P'}</span>
                )}
              </div>
              <label className="flex items-center gap-1.5 h-8 px-3 text-xs font-medium bg-accent border border-border rounded-md cursor-pointer hover:bg-accent/70 transition-colors">
                <Upload className="w-3.5 h-3.5" /> {uploading ? '업로드 중...' : '이미지 선택'}
                <input type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" disabled={uploading} />
              </label>
              {form.logo_url && (
                <button type="button" onClick={() => set('logo_url', '')} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors">
                  <Trash2 className="w-3.5 h-3.5" /> 삭제
                </button>
              )}
            </div>
          </div>
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
            <button type="button" onClick={onClose} className="h-8 px-4 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-accent transition-colors">취소</button>
            <button type="submit" disabled={saving} className="h-8 px-4 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50">
              {saving ? '저장 중...' : '저장'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}