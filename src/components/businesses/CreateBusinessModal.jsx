import { useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { X } from 'lucide-react';

export default function CreateBusinessModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', description: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const submitting = useRef(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const inputClass = "w-full h-8 px-3 text-sm bg-accent border border-border rounded-md text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring";

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting.current) return;
    if (!form.name.trim()) {
      setError('비즈니스명을 입력해 주세요.');
      return;
    }
    submitting.current = true;
    setSaving(true);
    setError('');
    let retryAllowed = true;
    let createdBusiness;
    try {
      const { data, error: rpcError } = await supabase.rpc('create_business', {
        p_name: form.name,
        p_description: form.description || null,
      });
      if (rpcError) throw rpcError;
      if (!data || typeof data.id !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.id)) {
        throw new Error('invalid_create_response');
      }
      retryAllowed = false;
      createdBusiness = data;
    } catch (err) {
      if (!err?.code || err.message === 'invalid_create_response') {
        retryAllowed = false;
        setOutcomeUnknown(true);
        setError('생성 결과를 확인할 수 없습니다. 중복 생성을 피하려면 이 창을 닫고 목록을 새로고침해 확인해 주세요.');
      } else {
        setError(err.message === 'business_name_required'
          ? '비즈니스명을 입력해 주세요.'
          : '비즈니스 생성에 실패했습니다. 로그인 세션과 생성 권한을 확인해 주세요.');
      }
    } finally {
      setSaving(false);
      if (retryAllowed) submitting.current = false;
    }
    // A subsequent list refresh failure is not a failed creation.
    if (createdBusiness) onCreated(createdBusiness);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground">새 비즈니스 추가</h3>
          <button disabled={saving} onClick={onClose} className="p-1 rounded hover:bg-accent transition-colors">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-3">
          {error && <div role="alert" className="p-3 rounded-lg bg-destructive/10 text-destructive text-xs">{error}</div>}
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
            <button type="button" disabled={saving} onClick={onClose} className="h-8 px-4 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-accent transition-colors">취소</button>
            <button type="submit" disabled={saving || outcomeUnknown} className="h-8 px-4 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50">
              {saving ? '저장 중...' : '비즈니스 추가'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
