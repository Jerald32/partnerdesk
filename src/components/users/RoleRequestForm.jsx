import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { ArrowUpCircle, CheckCircle2 } from 'lucide-react';
import ConsentModal from '@/components/users/ConsentModal';

const HQ_LIST = ['SK쉴더스'];

const ORG_TYPE_OPTIONS = [
  { value: 'operator_company', label: '운영사 (SK Shieldus)' },
  { value: 'partner', label: '파트너' },
];

const ROLE_OPTIONS = [
  { value: 'operator', label: 'Operator (운영자)' },
  { value: 'partner_admin', label: 'Partner Admin (파트너 관리자)' },
];

// 현재 소속/역할 표시용 라벨
const ORG_TYPE_LABEL = { operator_company: '운영사', partner: '파트너' };
const ROLE_LABEL = { admin: 'Admin', operator: 'Operator', partner_admin: 'Partner Admin', guest: 'Guest' };

export default function RoleRequestForm({ currentUser, onSubmitted }) {
  const [form, setForm] = useState({
    requested_role: currentUser?.role === 'partner_admin' ? 'partner_admin' : 'operator',
    requested_org_type: currentUser?.org_type && ORG_TYPE_LABEL[currentUser.org_type] ? currentUser.org_type : 'operator_company',
    justification: '',
    company: currentUser?.affiliation || '',
  });
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [showConsent, setShowConsent] = useState(false);
  const [partners, setPartners] = useState([]);

  useEffect(() => {
    // 마스터 데이터 RLS로 Guest 직접 조회가 차단되므로, 승격 요청용 최소 정보(id/이름)만 백엔드에서 제공
    base44.functions.invoke('getPartnerOptions')
      .then(res => setPartners(res?.data?.partners || []))
      .catch(() => {});
  }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const affiliationOptions =
    form.requested_org_type === 'operator_company'
      ? HQ_LIST.map(name => ({ value: name, label: name }))
      : partners.map(p => ({ value: p.id, label: p.name }));

  const handleSubmit = (e) => {
    e.preventDefault();
    setShowConsent(true);
  };

  const finalSubmit = async () => {
    setSaving(true);
    setSubmitError('');
    try {
      // 서버에서 본인 확인 후 요청 생성 — 신원/현재 등급 필드는 클라이언트가 전송하지 않음
      await base44.functions.invoke('submitRoleRequest', {
        requested_role: form.requested_role,
        requested_org_type: form.requested_org_type,
        justification: form.justification,
        company: form.company,
      });
      setShowConsent(false);
      setDone(true);
      onSubmitted?.();
    } catch (err) {
      setSubmitError(err?.data?.error || err?.message || '요청 제출에 실패했습니다. 잠시 후 다시 시도해주세요.');
      setShowConsent(false);
    } finally {
      setSaving(false);
    }
  };

  const selectClass = "w-full h-8 px-3 text-sm bg-accent border border-border rounded-md text-foreground focus:outline-none focus:ring-1 focus:ring-ring appearance-none cursor-pointer";
  const labelClass = "block text-xs font-medium text-muted-foreground mb-1";

  if (done) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center gap-3">
        <CheckCircle2 className="w-10 h-10 text-emerald-400" />
        <p className="text-sm font-medium text-foreground">소속/역할 변경 요청이 제출되었습니다</p>
        <p className="text-xs text-muted-foreground">관리자 승인 후 변경사항이 적용됩니다.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
      <div className="flex items-center gap-2 mb-1">
        <ArrowUpCircle className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">소속/역할 변경 요청</h3>
      </div>
      <div className="text-xs text-muted-foreground space-y-0.5">
        <p>현재 역할: <span className="text-foreground font-medium">{ROLE_LABEL[currentUser?.role] || currentUser?.role}</span></p>
        <p>현재 소속: <span className="text-foreground font-medium">{ORG_TYPE_LABEL[currentUser?.org_type] || '–'} · {currentUser?.affiliation || '–'}</span></p>
        <p className="pt-1">관리자 승인 후 소속 및 역할이 변경됩니다.</p>
      </div>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className={labelClass}>요청 역할 *</label>
          <select
            required
            value={form.requested_role}
            onChange={e => set('requested_role', e.target.value)}
            className={selectClass}
          >
            {ROLE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className={labelClass}>소속사 등급 *</label>
          <select
            required
            value={form.requested_org_type}
            onChange={e => { set('requested_org_type', e.target.value); set('company', ''); }}
            className={selectClass}
          >
            {ORG_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className={labelClass}>소속 회사 <span className="text-muted-foreground/60">(선택)</span></label>
          <select value={form.company} onChange={e => set('company', e.target.value)} className={selectClass}>
            <option value="">선택 안함</option>
            {affiliationOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className={labelClass}>요청 사유 *</label>
          <textarea
            required
            value={form.justification}
            onChange={e => set('justification', e.target.value)}
            placeholder="소속/역할 변경을 요청하는 사유를 입력해주세요..."
            rows={3}
            className="w-full px-3 py-2 text-sm bg-accent border border-border rounded-md text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
          />
        </div>
        <button
          type="submit"
          disabled={saving}
          className="w-full h-9 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {saving ? '제출 중...' : '변경 요청 제출'}
        </button>
      </form>

      {submitError && (
        <p className="text-xs text-destructive">{submitError}</p>
      )}

      {showConsent && (
        <ConsentModal
          onAgree={finalSubmit}
          onCancel={() => setShowConsent(false)}
          saving={saving}
        />
      )}
    </div>
  );
}