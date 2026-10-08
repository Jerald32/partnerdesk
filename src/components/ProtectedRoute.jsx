import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import PrivacyConsent from '@/pages/PrivacyConsent';
import RoleRequestForm from '@/components/users/RoleRequestForm';

export default function ProtectedRoute({ unauthenticatedElement }) {
  const { user, isAuthenticated, isLoadingAuth, privacyConsentValid, logout } = useAuth();
  if (isLoadingAuth) return <div className="fixed inset-0 flex items-center justify-center"><div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin" /></div>;
  if (!isAuthenticated) return unauthenticatedElement || <Navigate to="/login" replace />;
  if (user.role === 'partner_admin' && !privacyConsentValid) return <PrivacyConsent />;
  if (user.role === 'guest') {
    return <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6">
      <p>관리자 승인 대기 중입니다. 업무 데이터는 승인 후 이용할 수 있습니다.</p>
      <p className="text-sm">소속 조직을 선택하여 권한을 요청해 주세요. 조직이 없다면 관리자에게 문의해 주세요.</p>
      <p className="text-sm">승인이 완료되면 로그아웃 후 다시 로그인해 주세요.</p>
      <RoleRequestForm />
      <button onClick={() => logout(true)} className="text-primary">로그아웃</button>
    </div>;
  }
  return <Outlet />;
}
