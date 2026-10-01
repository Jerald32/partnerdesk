import { ShieldAlert } from 'lucide-react';
import { useAuth } from '@/lib/AuthContext';

const MESSAGES = {
  concurrent_login: {
    title: '접속이 종료되었습니다',
    desc: '다른 기기에서 로그인하여 이 기기의 접속이 종료되었습니다. 잠시 후 로그인 화면으로 이동합니다.',
  },
  session_revoked: {
    title: '접속이 종료되었습니다',
    desc: '해당 계정의 세션이 로그아웃 처리되어 접속이 종료되었습니다. 잠시 후 로그인 화면으로 이동합니다.',
  },
  reauth_required: {
    title: '재인증이 필요합니다',
    desc: '보안을 위해 주기적 재인증이 필요합니다. 잠시 후 로그인 화면으로 이동합니다.',
  },
};

export default function SessionEndedNotice() {
  const { sessionEndedReason } = useAuth();
  if (!sessionEndedReason) return null;

  const message = MESSAGES[sessionEndedReason] || MESSAGES.concurrent_login;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/95 backdrop-blur-sm px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-center space-y-3 shadow-lg">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-destructive/10">
          <ShieldAlert className="w-6 h-6 text-destructive" />
        </div>
        <p className="text-sm font-semibold text-foreground">{message.title}</p>
        <p className="text-xs text-muted-foreground leading-relaxed">{message.desc}</p>
      </div>
    </div>
  );
}