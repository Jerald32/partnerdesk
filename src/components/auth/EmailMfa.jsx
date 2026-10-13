import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function EmailMfa({ onComplete }) {
  const { mfaChallenge, verifyMfa, resendMfa, logout, authError } = useAuth();
  const [code, setCode] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [now, setNow] = useState(Date.now()), [resendAt, setResendAt] = useState(Date.now() + 60000);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const remaining = Math.max(0, Math.ceil((Date.parse(mfaChallenge?.expires_at || '') - now) / 1000)) || 0;
  async function submit(event) {
    event.preventDefault(); if (busy || !/^[0-9]{6}$/.test(code) || !remaining) return;
    setBusy(true); setError('');
    try { await verifyMfa(code); onComplete(); } catch (failure) { setError(failure.message); }
    finally { setCode(''); setBusy(false); }
  }
  async function resend() {
    if (busy || now < resendAt) return;
    setBusy(true); setError(''); setResendAt(Date.now() + 60000);
    try { await resendMfa(); setCode(''); } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="space-y-4">
    <p className="text-sm">로그인 이메일로 발송된 6자리 인증번호를 입력해 주세요.</p>
    <label className="block text-sm">인증번호<Input type="text" inputMode="numeric" autoComplete="one-time-code"
      autoFocus maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))} disabled={busy} /></label>
    <p className="text-xs text-muted-foreground">{remaining ? `남은 시간 ${Math.floor(remaining / 60)}분 ${remaining % 60}초` : '인증번호를 다시 요청해 주세요.'} · 최대 5회 시도</p>
    {(error || authError?.message) && <p role="alert" className="text-sm text-destructive">{error || authError.message}</p>}
    <Button type="submit" className="w-full" disabled={busy || code.length !== 6 || !remaining}>{busy ? '처리 중…' : '인증 확인'}</Button>
    <button type="button" className="text-xs text-primary" disabled={busy || now < resendAt} onClick={resend}>
      {now < resendAt ? `${Math.ceil((resendAt - now) / 1000)}초 후 재발송 가능` : '인증번호 재발송'}</button>
    <button type="button" className="block text-xs text-muted-foreground" disabled={busy} onClick={() => logout(false)}>취소하고 다시 로그인</button>
  </form>;
}
