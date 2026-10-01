import { Outlet, useLocation, Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { getIpDenied } from '@/lib/session';
import { isGuest, isPartnerRole } from '@/lib/roles';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';

const DefaultFallback = () => (
  <div className="fixed inset-0 flex items-center justify-center">
    <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
  </div>
);

export default function ProtectedRoute({ fallback = <DefaultFallback />, unauthenticatedElement }) {
  const { isAuthenticated, isLoadingAuth, authError, user, mfaVerified, privacyConsentValid, emailVerified, ipAllowed } = useAuth();
  const location = useLocation();

  if (isLoadingAuth) {
    return fallback;
  }

  if (authError) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    }
    return unauthenticatedElement;
  }

  if (!isAuthenticated) {
    return unauthenticatedElement;
  }

  // 이메일 미인증 사용자 차단 화면으로 강제 이동
  if (!emailVerified && location.pathname !== '/email-verify-required') {
    return <Navigate to="/email-verify-required" replace />;
  }

  // IP 접근 제한 (최우선 검사)
  // 인증(이메일 인증번호) 완료 전에는 IP 확인 요청을 보내지 않으므로, 서버가 인증 단계에서 알려준
  // 차단 상태도 함께 반영한다. 차단 안내 화면 자체는 인증 완료 전에도 표시할 수 있다.
  if (getIpDenied() !== null || !ipAllowed) {
    return location.pathname === '/ip-denied' ? <Outlet /> : <Navigate to="/ip-denied" replace />;
  }

  // MFA 미인증 시 인증 페이지로 강제 이동 (/mfa-verify 자체는 제외)
  if (!mfaVerified && location.pathname !== '/mfa-verify') {
    return <Navigate to="/mfa-verify" replace />;
  }

  // 개인정보보호 서약서 미제출자 서약서 페이지로 강제 이동 (파트너 역할만)
  if (mfaVerified && !privacyConsentValid && isPartnerRole(user) && location.pathname !== '/privacy-consent') {
    return <Navigate to="/privacy-consent" replace />;
  }

  // Guest 등급(user/guest 등 미승인 역할)은 내 계정(/my) 외 모든 페이지 접근 차단
  if (isGuest(user?.role) && location.pathname !== '/my') {
    return <Navigate to="/my" replace />;
  }

  return <Outlet />;
}