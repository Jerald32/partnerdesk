import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import { getPasswordCycleStatus, PASSWORD_CYCLE_DAYS } from '@/lib/passwordPolicy';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { KeyRound, Mail, Loader2, CheckCircle2 } from 'lucide-react';

// 비밀번호 변경 주기(분기 1회) 안내 팝업 — 로그인 후 주기 경과 사용자에게 표시
export default function PasswordCycleNotice() {
  const { user, mfaVerified } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const status = getPasswordCycleStatus(user);
  const open = !!user && mfaVerified && status.due && !dismissed;

  const handleRequest = async () => {
    setSending(true);
    setError('');
    try {
      await base44.functions.invoke('passwordCycle', { action: 'request_reset' });
      await base44.auth.resetPasswordRequest(user.email);
      setSent(true);
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || '재설정 메일 발송에 실패했습니다.');
    } finally {
      setSending(false);
    }
  };

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) setDismissed(true); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-primary/10 mb-1">
            <KeyRound className="w-6 h-6 text-primary" aria-hidden="true" />
          </div>
          <DialogTitle>비밀번호 변경 안내</DialogTitle>
          <DialogDescription>
            비밀번호는 분기 1회({PASSWORD_CYCLE_DAYS}일) 주기로 변경하도록 권장하고 있습니다.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-border bg-accent/40 px-4 py-3 text-sm space-y-1">
          <p className="text-muted-foreground">
            마지막 변경일:{' '}
            <span className="text-foreground">
              {status.neverChanged
                ? '변경 이력 없음'
                : new Date(status.lastChanged).toLocaleDateString('ko-KR')}
            </span>
          </p>
          {!status.neverChanged && (
            <p className="text-muted-foreground">
              경과일: <span className="text-foreground">{status.daysElapsed}일</span>
            </p>
          )}
        </div>

        {sent ? (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-emerald-500/10 text-emerald-400 text-sm leading-relaxed">
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              재설정 메일을 발송했습니다. 메일의 링크에서 새 비밀번호로 변경해 주세요.
              (변경 후 다음 로그인 시 자동 반영됩니다)
            </span>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground leading-relaxed">
            아래 버튼을 누르면 등록된 이메일로 비밀번호 재설정 링크가 발송됩니다.
          </p>
        )}

        {error && (
          <p className="text-xs text-destructive">{error}</p>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={() => setDismissed(true)} disabled={sending}>
            나중에
          </Button>
          {!sent && (
            <Button onClick={handleRequest} disabled={sending}>
              {sending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  발송 중...
                </>
              ) : (
                <>
                  <Mail className="w-4 h-4 mr-2" />
                  비밀번호 변경하기
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}