import { useState, useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Shield, Loader2, Mail, RefreshCw } from 'lucide-react';
import AuthLayout from '@/components/AuthLayout';
import { setSessionId } from '@/lib/session';

// 미등록 IP 차단 응답 — 이 경우 백엔드 호출 단계에서 이미 차단 안내 화면으로 이동하므로 화면 전환을 덮어쓰지 않는다
const isIpDeniedError = (err) => (err?.data?.reason || err?.response?.data?.reason) === 'ip_denied';

export default function MfaVerify() {
  const [code, setCode] = useState(['', '', '', '', '', '']);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const inputsRef = useRef([]);

  const sentOnceRef = useRef(false);

  const sendCode = async (opts = {}) => {
    // 동일 마운트 내 자동 발송 중복 방지 (StrictMode/이중 마운트 대응)
    if (!opts.force && sentOnceRef.current) return;
    setSending(true);
    setError('');
    try {
      await base44.functions.invoke('mfaSendCode', { force: !!opts.force });
      setSent(true);
      sentOnceRef.current = true;
    } catch (err) {
      if (isIpDeniedError(err)) return;
      setError(err?.response?.data?.error || err?.message || '인증번호 발송 실패');
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    const init = async () => {
      try {
        const res = await base44.functions.invoke('getMfaSetting', {});
        if (res.data?.enabled === false && res.data?.user_id) {
          // MFA 비활성화: 서버에 인증 시각을 기록(세션 활성화)한 뒤 인증 완료 처리 후 홈으로
          try {
            const activateRes = await base44.functions.invoke('activateSession', {});
            setSessionId(activateRes.data?.session_id);
          } catch (e) {
            // 미등록 IP 차단은 차단 안내 화면으로 이미 이동하므로 재로그인 유도로 덮어쓰지 않는다
            if (isIpDeniedError(e)) return;
            // 세션 활성화 실패 시 재로그인 유도 — 재인증 주기 정책 준수
            window.location.href = '/login';
            return;
          }
          sessionStorage.setItem(`mfa_verified_${res.data.user_id}`, 'true');
          sessionStorage.setItem(`mfa_enabled_${res.data.user_id}`, 'false');
          window.location.href = '/';
          return;
        }
      } catch (e) {
        // 설정 조회 실패 시 활성화(기본값)로 진행
      }
      sendCode();
    };
    init();
  }, []);

  const handleChange = (index, value) => {
    if (!/^\d?$/.test(value)) return;
    const newCode = [...code];
    newCode[index] = value;
    setCode(newCode);
    if (value && index < 5) {
      inputsRef.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index, e) => {
    if (e.key === 'Backspace' && !code[index] && index > 0) {
      inputsRef.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (pasted.length > 0) {
      const newCode = ['', '', '', '', '', ''];
      for (let i = 0; i < pasted.length && i < 6; i++) {
        newCode[i] = pasted[i];
      }
      setCode(newCode);
      const focusIndex = Math.min(pasted.length, 5);
      inputsRef.current[focusIndex]?.focus();
    }
  };

  const handleReset = () => {
    setCode(['', '', '', '', '', '']);
    setError('');
    inputsRef.current[0]?.focus();
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const fullCode = code.join('');
    if (fullCode.length !== 6) {
      setError('6자리 인증번호를 모두 입력해주세요.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const verifyRes = await base44.functions.invoke('mfaVerifyCode', { code: fullCode });
      // 이 기기를 현재 유효 세션으로 등록 (다른 기기의 기존 세션은 서버에서 무효화됨)
      setSessionId(verifyRes.data?.session_id);
      // 인증 완료 표시는 화면 전환 보조용 — 인증 여부는 서버 기록으로도 판정되므로
      // 사용자 정보 조회가 지연·실패해도 인증 화면에 머무르지 않고 그대로 진행한다.
      try {
        const me = await base44.auth.me();
        if (me?.id) sessionStorage.setItem(`mfa_verified_${me.id}`, 'true');
      } catch (e) {
        // 무시: 서버 세션 기록으로 인증 상태가 판정됨
      }
      window.location.href = '/';
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || '인증 실패');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      icon={Shield}
      title="이메일 인증"
      subtitle="이메일로 발송된 6자리 인증번호를 입력하세요"
    >
      {error && (
        <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          {error}
        </div>
      )}

      {sent && !error && (
        <div className="mb-4 flex items-start gap-2 p-3 rounded-lg bg-primary/10 text-primary text-sm leading-relaxed">
          <Mail className="w-4 h-4 shrink-0 mt-0.5" />
          <span>인증번호가 이메일로 발송되었습니다. (유효시간 5분)</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="flex justify-center gap-1.5 sm:gap-2" onPaste={handlePaste}>
          {code.map((digit, i) => (
            <Input
              key={i}
              ref={(el) => (inputsRef.current[i] = el)}
              type="text"
              inputMode="numeric"
              maxLength={1}
              value={digit}
              onChange={(e) => handleChange(i, e.target.value)}
              onKeyDown={(e) => handleKeyDown(i, e)}
              className="w-9 h-12 sm:w-12 sm:h-14 text-center text-lg sm:text-xl font-semibold border-2 border-foreground/40 bg-input focus:border-primary focus:ring-2 focus:ring-primary/30 rounded-md"
              autoFocus={i === 0}
            />
          ))}
        </div>

        <Button type="submit" className="w-full h-12 font-medium" disabled={loading || sending}>
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              인증 중...
            </>
          ) : (
            '인증하기'
          )}
        </Button>
      </form>

      <div className="mt-6 flex items-center justify-center gap-4">
        <button
          onClick={handleReset}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          다시입력
        </button>
        <span className="text-border">|</span>
        <button
          onClick={() => sendCode({ force: true })}
          disabled={sending}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          <Mail className="w-3.5 h-3.5" />
          {sending ? '발송 중...' : '인증번호 재발송'}
        </button>
      </div>
    </AuthLayout>
  );
}