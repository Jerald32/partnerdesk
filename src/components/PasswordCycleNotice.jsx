import { useRef, useState } from 'react';
import { KeyRound, Loader2, Mail } from 'lucide-react';
import { useAuth } from '@/lib/AuthContext';
import { getAppSession } from '@/lib/appSession';
import { invokeAppAuth } from '@/lib/appAuth';
import { supabase } from '@/lib/supabaseClient';
import { getPasswordCycleStatus, PASSWORD_CYCLE_DAYS } from '@/lib/passwordPolicy';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

const DISMISSED_KEY = 'partnerdesk_password_cycle_dismissed';
const RESET_REDIRECT = 'https://partnerdesk-phi.vercel.app/reset-password';

function CycleDialog({ user, sessionId, status }) {
  const identity = `${user.id}:${sessionId}`;
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem(DISMISSED_KEY) === identity; } catch { return false; }
  });
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState('');
  const [error, setError] = useState('');
  const pending = useRef(false);
  const sent = useRef(false);
  function dismiss() {
    if (pending.current) return;
    try { sessionStorage.setItem(DISMISSED_KEY, identity); } catch { /* Current dialog can still close. */ }
    setDismissed(true);
  }
  async function requestReset() {
    if (pending.current || sent.current) return;
    pending.current = true; setSending(true); setError('');
    try {
      await invokeAppAuth('validate-session');
      const { data, error: authError } = await supabase.auth.getUser();
      const account = data?.user;
      if (authError || !account?.email_confirmed_at || account.id !== user.auth_user_id || !account.email) throw new Error('identity_unavailable');
      const { error: mailError } = await supabase.auth.resetPasswordForEmail(account.email, { redirectTo: RESET_REDIRECT });
      if (mailError) throw mailError;
      sent.current = true; setSentTo(account.email);
    } catch {
      setError('재설정 메일을 보내지 못했습니다. 로그인 상태를 확인한 후 잠시 뒤 다시 시도해 주세요.');
    } finally { pending.current = false; setSending(false); }
  }
  return <Dialog open={!dismissed} onOpenChange={open => { if (!open) dismiss(); }}>
    <DialogContent className="max-w-md">
      <DialogHeader>
        <KeyRound className="h-6 w-6 text-primary" aria-hidden="true" />
        <DialogTitle>비밀번호 변경 안내</DialogTitle>
        <DialogDescription>비밀번호는 분기 1회({PASSWORD_CYCLE_DAYS}일) 주기로 변경하는 것을 권장합니다.</DialogDescription>
      </DialogHeader>
      <div className="rounded-lg border bg-accent/40 p-3 text-sm space-y-1">
        <p>마지막 변경일: {status.neverChanged ? '변경 이력 없음' : new Date(status.lastChanged).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })}</p>
        {!status.neverChanged && <p>경과일: {status.daysElapsed}일</p>}
      </div>
      {sentTo ? <p role="status" className="text-sm text-primary break-all">{sentTo} 주소로 재설정 메일을 발송했습니다. 메일의 링크에서 새 비밀번호로 변경해 주세요. 받은 편지함과 스팸함을 확인해 주세요.</p>
        : <p className="text-sm text-muted-foreground">아래 버튼을 누르면 본인 계정의 이메일로 비밀번호 재설정 링크를 보내드립니다.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter className="gap-2">
        <Button type="button" variant="ghost" disabled={sending} onClick={dismiss}>{sentTo ? '닫기' : '나중에'}</Button>
        {!sentTo && <Button type="button" disabled={sending} onClick={requestReset}>
          {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Mail className="mr-2 h-4 w-4" aria-hidden="true" />}
          {sending ? '발송 중…' : '비밀번호 변경하기'}
        </Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export default function PasswordCycleNotice() {
  const { user, isAuthenticated, mfaVerified } = useAuth();
  const session = getAppSession();
  if (!user || !isAuthenticated || !mfaVerified || !session?.sessionId) return null;
  const status = getPasswordCycleStatus(user);
  if (!status.due) return null;
  return <CycleDialog key={`${user.id}:${session.sessionId}`} user={user} sessionId={session.sessionId} status={status} />;
}
