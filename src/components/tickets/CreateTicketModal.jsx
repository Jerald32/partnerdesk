import { useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { X } from 'lucide-react';
import AddressField from '@/components/tickets/AddressField';
import { useAuth } from '@/lib/AuthContext';
import { isCompanyMember } from '@/lib/roles';

export default function CreateTicketModal({ businesses, partners, servicePartners = [], onClose, onCreated }) {
  const { user } = useAuth();
  const availableBusinesses = isCompanyMember(user) ? businesses : businesses.filter(business =>
    servicePartners.some(relation => relation.business_id === business.id
      && relation.partner_organization_id === user?.organization_id && relation.access_level === 'business'));
  const REQUEST_TYPES = [
    '장애/고장', '설치 요청', '점검/유지보수', '교체 요청',
    '소프트웨어 오류', '네트워크 문제', '이전/철거', '기타',
  ];

  const [form, setForm] = useState({
    title: '', description: '', request_type: '', request_detail: '',
    business_id: '', partner_id: '',
    priority: 'normal', customer_name: '', customer_company: '', customer_contact: '',
    address: '', address_detail: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const submitting = useRef(false);
  const availablePartners = partners.filter(partner => servicePartners.some(relation =>
    relation.business_id === form.business_id && relation.partner_organization_id === partner.id));

  const set = (k, v) => setForm(f => ({ ...f, [k]: v, ...(k === 'business_id' ? { partner_id: '' } : {}) }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError('');
    let retryAllowed = true;
    let createdTicket;
    try {
      // 제목 자동 생성: 요청사항 기반 (없으면 요청 유형 사용)
      const autoTitle = (form.request_detail || '').trim() || form.request_type || '티켓';
      // 서버에서 속도 제한(1분 5개) 검증 후 생성
      const { data, error: rpcError } = await supabase.rpc('create_ticket', {
        p_business_id: form.business_id,
        p_title: autoTitle.slice(0, 100),
        p_description: form.description || null,
        p_request_type: form.request_type || null,
        p_request_detail: form.request_detail || null,
        p_priority: form.priority,
        p_customer_name: form.customer_name || null,
        p_customer_company: form.customer_company || null,
        p_customer_contact: form.customer_contact || null,
        p_address: form.address || null,
        p_address_detail: form.address_detail || null,
        p_assigned_partner_organization_id: form.partner_id || null,
      });
      if (rpcError) throw rpcError;
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!data || !uuid.test(data.id) || data.status !== 'new' ||
          !Number.isInteger(data.version) || data.version < 1 ||
          !(data.assigned_partner_organization_id === null || uuid.test(data.assigned_partner_organization_id))) {
        throw new Error('invalid_create_response');
      }
      retryAllowed = false;
      createdTicket = data;
    } catch (err) {
      // Missing/transport responses cannot prove that the transaction did not commit.
      if (!err?.code || err.message === 'invalid_create_response') {
        retryAllowed = false;
        setOutcomeUnknown(true);
        setError('생성 결과를 확인할 수 없습니다. 중복 생성을 피하려면 이 창을 닫고 목록을 새로고침해 확인해 주세요.');
      } else {
        const messages = {
          ticket_create_rate_limit_exceeded: '1분에 최대 5건까지 생성할 수 있습니다. 잠시 후 다시 시도해 주세요.',
          business_not_found_or_forbidden: '선택한 비즈니스를 사용할 수 없습니다. 목록을 새로고침해 주세요.',
          business_partner_relation_required: '선택한 비즈니스와 파트너의 연결을 확인해 주세요.',
          partner_assignment_forbidden: '다른 파트너 조직에는 배정할 수 없습니다.',
          business_partner_access_required: '이 Business에서는 배정된 Ticket만 처리할 수 있습니다. 새 Ticket은 Company 또는 Business Partner에 요청해 주세요.',
          address_too_long: '주소와 상세주소는 각각 200자 이하여야 합니다.',
        };
        setError(messages[err.message] || '티켓 생성에 실패했습니다. 로그인 세션과 입력값, 접근 권한을 확인해 주세요.');
      }
    } finally {
      setSaving(false);
      if (retryAllowed) submitting.current = false;
    }
    // List refresh errors must never be reported as a failed creation.
    if (createdTicket) onCreated(createdTicket);
  };

  const inputClass = "w-full h-8 px-3 text-sm bg-accent border border-border rounded-md text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring";
  const selectClass = "w-full h-8 px-3 text-sm bg-accent border border-border rounded-md text-foreground focus:outline-none focus:ring-1 focus:ring-ring appearance-none cursor-pointer";
  const labelClass = "block text-xs font-medium text-muted-foreground mb-1";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground">새 티켓 생성</h3>
          <button disabled={saving} onClick={onClose} className="p-1 rounded hover:bg-accent transition-colors">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-3">
          {error && (
            <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-xs">{error}</div>
          )}
          <div>
            <label className={labelClass}>비즈니스 *</label>
            <select required value={form.business_id} onChange={e => set('business_id', e.target.value)} className={selectClass}>
              <option value="">비즈니스 선택</option>
              {availableBusinesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            {!availableBusinesses.length && <p className="text-xs text-muted-foreground">새 Ticket을 생성할 수 있는 Business가 없습니다. 배정된 Ticket은 목록에서 처리해 주세요.</p>}
          </div>
          <div>
            <label className={labelClass}>상호</label>
            <input value={form.customer_company} onChange={e => set('customer_company', e.target.value)} placeholder="예: OO상사, OO마트" className={inputClass} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>고객명</label>
              <input value={form.customer_name} onChange={e => set('customer_name', e.target.value)} placeholder="홍길동" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>연락처</label>
              <input value={form.customer_contact} onChange={e => set('customer_contact', e.target.value)} placeholder="010-0000-0000" className={inputClass} />
            </div>
          </div>
          <AddressField
            value={{ address: form.address, address_detail: form.address_detail }}
            onChange={addr => { set('address', addr.address); set('address_detail', addr.address_detail); }}
          />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>요청 유형 *</label>
              <select required value={form.request_type} onChange={e => set('request_type', e.target.value)} className={selectClass}>
                <option value="">유형 선택</option>
                {REQUEST_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className={labelClass}>파트너 배정</label>
              <select disabled={!form.business_id || saving} value={form.partner_id} onChange={e => set('partner_id', e.target.value)} className={selectClass}>
                <option value="">파트너 선택 (선택사항)</option>
                {availablePartners.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className={labelClass}>요청사항</label>
            <textarea
              value={form.request_detail}
              onChange={e => set('request_detail', e.target.value)}
              placeholder="고객이 요청한 내용을 입력하세요..."
              rows={2}
              className="w-full px-3 py-2 text-sm bg-accent border border-border rounded-md text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            />
          </div>
          <div>
            <label className={labelClass}>설명</label>
            <textarea
              value={form.description}
              onChange={e => set('description', e.target.value)}
              placeholder="문제 상황을 자세히 설명해주세요..."
              rows={3}
              className="w-full px-3 py-2 text-sm bg-accent border border-border rounded-md text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            />
          </div>
          <div>
            <label className={labelClass}>우선순위</label>
            <select value={form.priority} onChange={e => set('priority', e.target.value)} className={selectClass}>
              <option value="low">낮음</option>
              <option value="normal">보통</option>
              <option value="high">높음</option>
              <option value="urgent">긴급</option>
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" disabled={saving} onClick={onClose} className="h-8 px-4 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-accent transition-colors">
              취소
            </button>
            <button type="submit" disabled={saving || outcomeUnknown} className="h-8 px-4 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50">
              {saving ? '생성 중...' : '티켓 생성'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
