import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import PrivacyConsent from '@/pages/PrivacyConsent';

export default function ProtectedRoute({ unauthenticatedElement }) {
  const { user, isAuthenticated, isLoadingAuth, privacyConsentValid, logout } = useAuth();
  if (isLoadingAuth) return <div className="fixed inset-0 flex items-center justify-center"><div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin" /></div>;
  if (!isAuthenticated) return unauthenticatedElement || <Navigate to="/login" replace />;
  if (user.role === 'partner_admin' && !privacyConsentValid) return <PrivacyConsent />;
  if (user.role === 'guest' || (user.role === 'partner_admin' && !privacyConsentValid)) {
    return <div className="min-h-screen flex flex-col items-center justify-center gap-4">
      <p>{user.role === 'guest' ? '업무 권한이 필요합니다. 관리자에게 문의해 주세요.' : '개인정보 동의가 필요합니다. 동의 화면은 다음 전환 단계에서 연결됩니다.'}</p>
      <button onClick={() => logout(true)} className="text-primary">로그아웃</button>
    </div>;
  }
  return <Outlet />;
}
