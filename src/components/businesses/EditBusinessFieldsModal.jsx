import { useState } from 'react';
import { useRpcAction } from '@/hooks/useRpcAction';

export default function EditBusinessFieldsModal({ business, relation, onClose, onSaved }) {
  const row = relation || business;
  const [form, setForm] = useState(relation ? {
    role_description: row.role_description || '', sla_response_hours: row.sla_response_hours,
    sla_resolution_hours: row.sla_resolution_hours,
  } : { name: row.name, description: row.description || '', is_active: row.is_active });
  const { run, busy, error, unknown } = useRpcAction(onSaved);
  const fields = relation ? [['role_description','역할','text'],['sla_response_hours','응답 SLA (h)','number'],['sla_resolution_hours','해결 SLA (h)','number']]
    : [['name','이름','text'],['description','설명','text'],['is_active','활성','checkbox']];
  function submit(event) {
    event.preventDefault();
    void run(relation ? 'update_service_partner_terms' : 'update_business', relation ? {
      p_service_partner_id: row.id, p_role_description: form.role_description.trim() || null,
      p_sla_response_hours: Number(form.sla_response_hours), p_sla_resolution_hours: Number(form.sla_resolution_hours),
      p_expected_updated_at: row.updated_at,
    } : { p_business_id: row.id, p_name: form.name.trim(), p_description: form.description.trim() || null,
      p_is_active: form.is_active, p_expected_updated_at: row.updated_at });
  }
  return <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
    <form onSubmit={submit} className="w-full max-w-md rounded-xl border border-border bg-card p-5 space-y-3">
      <h3 className="text-sm font-semibold">{relation ? 'Partner 역할/SLA 수정' : 'Business 수정'}</h3>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <fieldset disabled={busy || unknown} className="space-y-3">
        {fields.map(([key,label,type]) => <label key={key} className="block text-xs text-muted-foreground">{label}
          <input type={type} required={key === 'name' || type === 'number'} min={type === 'number' ? 0 : undefined}
            max={type === 'number' ? 999999.99 : undefined} step={type === 'number' ? '0.01' : undefined}
            checked={type === 'checkbox' ? form[key] : undefined} value={type === 'checkbox' ? undefined : form[key]}
            onChange={event => setForm(old => ({ ...old, [key]: type === 'checkbox' ? event.target.checked : event.target.value }))}
            className={type === 'checkbox' ? 'ml-2' : 'mt-1 w-full h-8 px-3 rounded-md border border-border bg-accent text-foreground'} />
        </label>)}
      </fieldset>
      <div className="flex justify-end gap-2 text-xs">
        <button type="button" disabled={busy} onClick={onClose}>닫기</button>
        <button disabled={busy || unknown} className="rounded-md bg-primary text-primary-foreground px-3 py-2">저장</button>
      </div>
    </form>
  </div>;
}
