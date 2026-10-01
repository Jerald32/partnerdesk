import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { X } from 'lucide-react';

export default function CreateBusinessModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', description: '', is_active: true });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const inputClass = "w-full h-8 px-3 text-sm bg-accent border border-border rounded-md text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring";

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    await base44.entities.Business.create(form);
    onCreated();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground">새 비즈니스 추가</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent transition-colors">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">비즈니스명 *</label>
            <input required value={form.name} onChange={e => set('name', e.target.value)} placeholder="예: 이마트24" className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">설명</label>
            <textarea
              value={form.description}
              onChange={e => set('description', e.target.value)}
              placeholder="비즈니스 설명을 입력하세요..."
              rows={3}
              className="w-full px-3 py-2 text-sm bg-accent border border-border rounded-md text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="h-8 px-4 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-accent transition-colors">취소</button>
            <button type="submit" disabled={saving} className="h-8 px-4 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50">
              {saving ? '저장 중...' : '비즈니스 추가'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}