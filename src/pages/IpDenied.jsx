import { secureLogout } from '@/lib/logout';
import { getIpDenied } from '@/lib/session';
import { AlertTriangle, Shield } from 'lucide-react';
import AuthLayout from '@/components/AuthLayout';

export default function IpDenied() {
  // 차단 시점에 서버가 알려준 접속 IP (이메일 인증 완료 전에도 확인 가능)
  const clientIp = getIpDenied() || '';

  return (
    <AuthLayout
      icon={AlertTriangle}
      title="접근이 제한되었습니다"
      subtitle="허용된 IP에서만 시스템에 접근할 수 있습니다"
    >
      <div className="space-y-4 text-center">
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Shield className="w-4 h-4" />
          <span>현재 IP: <span className="font-mono text-foreground">{clientIp || '확인 불가'}</span></span>
        </div>
        <p className="text-xs text-muted-foreground">
          관리자에게 허용 IP 등록을 요청해 주세요.
        </p>
        <button
          onClick={() => secureLogout('/login')}
          className="text-xs text-primary hover:underline"
        >
          로그아웃
        </button>
      </div>
    </AuthLayout>
  );
}