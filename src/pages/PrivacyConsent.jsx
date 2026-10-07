import { useState } from 'react';
import { useRpcAction } from '@/hooks/useRpcAction';
import { useAuth } from '@/lib/AuthContext';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, FileText } from 'lucide-react';
import AuthLayout from '@/components/AuthLayout';

const PLEDGE_TEXT = `개인정보보호 서약서

본인은 협력사 임직원으로서 PartnerDesk 시스템을 이용함에 있어, 다음 사항을 성실히 준수할 것을 서약합니다.

1. 개인정보보호법 등 관련 법령 및 회사의 개인정보처리방침을 준수한다.
2. 시스템 내 개인정보를 본인의 업무 수행 목적 외에는 사용하지 않는다.
3. 업무상 알게 된 개인정보를 제3자에게 누설하거나 제공하지 않는다.
4. 시스템 계정 및 비밀번호를 타인에게 공유하거나 대여하지 않는다.
5. 시스템 내 기밀정보를 외부로 유출하지 않는다.
6. 퇴사 또는 업무 종료 시 즉시 시스템 접근 권한을 반납한다.

본 서약을 위반할 경우, 관련 법령에 따라 민·형사상 책임을 질 수 있음을 인지하고 있습니다.`;

export default function PrivacyConsent() {
  const { checkUserAuth, logout } = useAuth();
  const [agreed, setAgreed] = useState(false);
  const { run, busy: loading, error, unknown } = useRpcAction(() => { void checkUserAuth(); });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!agreed) return;
    void run('record_privacy_consent', { p_agreed: true }, data => typeof data?.id === 'string' && data.consent_type === 'privacy_pledge' && typeof data.pledge_version === 'string');
  };

  return (
    <AuthLayout
      icon={FileText}
      title="개인정보보호 서약서"
      subtitle="연 1회 개인정보보호 서약서 제출이 필요합니다"
    >
      {error && (
        <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          {error}
        </div>
      )}

      <div className="mb-6 p-4 rounded-lg bg-accent border border-border max-h-64 overflow-y-auto">
        <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-sans leading-relaxed">{PLEDGE_TEXT}</pre>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="flex items-start gap-3">
          <Checkbox
            id="consent-agree"
            checked={agreed}
            onCheckedChange={(checked) => setAgreed(checked === true)}
            className="mt-0.5"
          />
          <label htmlFor="consent-agree" className="text-sm text-foreground cursor-pointer">
            위 서약서 내용을 읽었으며, 성실히 준수할 것에 동의합니다.
          </label>
        </div>

        <Button type="submit" className="w-full h-12 font-medium" disabled={loading || unknown || !agreed}>
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              제출 중...
            </>
          ) : (
            '서약서 제출'
          )}
        </Button>
      </form>
      <button onClick={() => logout(true)} className="mt-4 text-xs text-muted-foreground">Sign out</button>
    </AuthLayout>
  );
}