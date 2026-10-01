import { useState } from 'react';
import { Shield, FileText, AlertTriangle } from 'lucide-react';

export default function ConsentModal({ onAgree, onCancel, saving }) {
  const [agreed1, setAgreed1] = useState(false);
  const [agreed2, setAgreed2] = useState(false);
  const canSubmit = agreed1 && agreed2;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-2xl max-h-[85vh] overflow-y-auto">
        <div className="p-5 space-y-4">
          <div className="flex items-center gap-2 pb-3 border-b border-border">
            <Shield className="w-5 h-5 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">보안 및 개인정보 처리 동의</h3>
          </div>

          {/* Security notice */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-orange-400" />
              <h4 className="text-xs font-semibold text-foreground">중요 보안 알림</h4>
            </div>
            <ul className="text-[11px] text-muted-foreground space-y-1 pl-5 list-disc leading-relaxed">
              <li>등급 승격 시 고객 정보, 티켓 내역 등 민감 데이터에 대한 접근 권한이 확대됩니다.</li>
              <li>열람한 정보는 업무 목적 외 사용을 엄격히 금지하며, 위반 시 계정 정지 및 법적 책임이 발생할 수 있습니다.</li>
              <li>모든 데이터 접근 기록은 감사 로그로 보관됩니다.</li>
            </ul>
          </div>

          {/* Privacy policy */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5 text-primary" />
              <h4 className="text-xs font-semibold text-foreground">개인정보 처리 지침</h4>
            </div>
            <div className="text-[11px] text-muted-foreground space-y-1.5 leading-relaxed bg-accent rounded-md p-3 max-h-32 overflow-y-auto">
              <p>본 요청에 입력된 개인정보(이름, 이메일, 소속 정보)는 등급 변경 승인 및 계정 관리 목적으로만 수집·이용됩니다.</p>
              <p>수집된 정보는 관리자 검토 후 승인/거부 처리에 활용되며, 목적 달성 후 관련 법령에 따라 안전하게 폐기됩니다.</p>
              <p>개인정보 처리에 대한 문의는 관리자에게 요청하시기 바랍니다.</p>
            </div>
          </div>

          {/* Consent checkboxes */}
          <div className="space-y-2.5 pt-2 border-t border-border">
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" checked={agreed1} onChange={e => setAgreed1(e.target.checked)} className="mt-0.5 accent-primary w-4 h-4 shrink-0" />
              <span className="text-[11px] text-foreground">보안 알림을 확인했으며, 권한 확대에 따른 책임을 이해합니다. (필수)</span>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" checked={agreed2} onChange={e => setAgreed2(e.target.checked)} className="mt-0.5 accent-primary w-4 h-4 shrink-0" />
              <span className="text-[11px] text-foreground">개인정보 처리 지침에 동의합니다. (필수)</span>
            </label>
          </div>

          {/* Buttons */}
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onCancel} disabled={saving} className="h-8 px-4 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-accent transition-colors disabled:opacity-50">취소</button>
            <button onClick={onAgree} disabled={!canSubmit || saving} className="h-8 px-4 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50">
              {saving ? '제출 중...' : '동의 후 제출'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}