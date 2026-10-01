import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { base44 } from '@/api/base44Client';
import { secureLogout } from '@/lib/logout';
import { MailCheck, MailWarning, Loader2 } from 'lucide-react';
import AuthLayout from '@/components/AuthLayout';

export default function EmailVerificationRequired() {
  const { user, checkUserAuth } = useAuth();
  const [sending, setSending] = useState(false);
  const [rechecking, setRechecking] = useState(false);

  const handleRecheck = async () => {
    setError('');
    setRechecking(true);
    try {
      // 서버에서 최신 인증 상태를 다시 확인 (인증 완료 시 자동으로 다음 화면으로 이동)
      await checkUserAuth();
    } finally {
      setRechecking(false);
    }
  };

  // 화면 진입 시 최신 인증 상태 확인 (로그인 시점 상태로 잘못 차단되는 것 방지)
  useEffect(() => {
    handleRecheck();
  }, []);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleResend = async () => {
    setError('');
    setSending(true);
    try {
      await base44.auth.resendOtp(user.email);
      setSent(true);
    } catch (e) {
      const msg = e?.message || '';
      if (msg.toLowerCase().includes('already verified')) {
        // 이미 인증이 완료된 계정 — 최신 상태를 다시 확인
        await handleRecheck();
        return;
      }
      setError(msg || '인증 이메일 재발송에 실패했습니다.');
    } finally {
      setSending(false);
    }
  };

  return (
    <AuthLayout
      icon={MailWarning}
      title="이메일 인증이 필요합니다"
      subtitle="서비스 이용을 위해 이메일 인증을 완료해 주세요"
    >
      <div className="space-y-4 text-center">
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <MailCheck className="w-4 h-4" />
          <span>가입 이메일: <span className="font-mono text-foreground">{user?.email || ''}</span></span>
        </div>
        <p className="text-xs text-muted-foreground">
          인증 이메일의 인증번호를 통해 인증을 완료한 뒤 다시 로그인해 주세요.
          인증 이메일을 받지 못한 경우 아래 버튼으로 재발송할 수 있습니다.
        </p>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {sent && <p className="text-xs text-muted-foreground">인증 이메일이 재발송되었습니다. 메일함을 확인해 주세요.</p>}
        <div className="flex flex-col gap-2 pt-1">
          <button
            onClick={handleRecheck}
            disabled={rechecking}
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {rechecking ? (
              <>
                <Loader2 className="w-4 h-4 mr-1 inline animate-spin" />
                확인 중...
              </>
            ) : (
              '인증 완료 후 상태 다시 확인'
            )}
          </button>
          <button
            onClick={handleResend}
            disabled={sending}
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {sending ? (
              <>
                <Loader2 className="w-4 h-4 mr-1 inline animate-spin" />
                재발송 중...
              </>
            ) : (
              '인증 이메일 재발송'
            )}
          </button>
          <button
            onClick={() => secureLogout('/login')}
            className="h-9 px-4 rounded-md border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            로그아웃
          </button>
        </div>
      </div>
    </AuthLayout>
  );
}