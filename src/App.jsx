import { useState } from 'react';
import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, Outlet, Navigate } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider } from '@/lib/AuthContext';
import ProtectedRoute from '@/components/ProtectedRoute';
import SessionEndedNotice from '@/components/SessionEndedNotice';
import PasswordCycleNotice from '@/components/PasswordCycleNotice';

// Layout
import Sidebar from '@/components/layout/Sidebar';
import TopBar from '@/components/layout/TopBar';

// Auth Pages
import Login from '@/pages/Login';
import Register from '@/pages/Register';
import ForgotPassword from '@/pages/ForgotPassword';
import ResetPassword from '@/pages/ResetPassword';
import MfaVerify from '@/pages/MfaVerify';
import PrivacyConsent from '@/pages/PrivacyConsent';
import IpDenied from '@/pages/IpDenied';
import EmailVerificationRequired from '@/pages/EmailVerificationRequired';
import { useIdleTimeout } from '@/hooks/useIdleTimeout';

// App Pages
import Dashboard from '@/pages/Dashboard';
import TicketList from '@/pages/TicketList';
import TicketDetail from '@/pages/TicketDetail';
import BusinessList from '@/pages/BusinessList';
import BusinessDetail from '@/pages/BusinessDetail';
import PartnerList from '@/pages/PartnerList';
import PartnerDetail from '@/pages/PartnerDetail';
import UserManagement from '@/pages/UserManagement';
import Notifications from '@/pages/Notifications';
import Settings from '@/pages/Settings';
import MyPage from '@/pages/MyPage';
import DataDeletionLogs from '@/pages/DataDeletionLogs';
import RoleChangeLogs from '@/pages/RoleChangeLogs';
import AccessLogs from '@/pages/AccessLogs';
import PrivacyNotice from '@/pages/PrivacyNotice';

const PAGE_TITLES = {
  '/': '대시보드',
  '/tickets': '티켓',
  '/businesses': '비즈니스 관리',
  '/partners': '파트너 관리',
  '/users': '사용자 관리',
  '/notifications': '알림',
  '/settings': '설정',
};

function Layout() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  useIdleTimeout();
  return (
    <div className="min-h-screen bg-background font-inter">
      <Sidebar mobileNavOpen={mobileNavOpen} onCloseMobileNav={() => setMobileNavOpen(false)} />
      <TopBar onToggleMobileNav={() => setMobileNavOpen(true)} />
      <main className="pt-16 md:pt-12 min-h-screen md:ml-56">
        <div className="p-4 sm:p-5">
          <Outlet />
        </div>
      </main>
      <PasswordCycleNotice />
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <Routes>
            {/* Auth Pages */}
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/mfa-verify" element={<MfaVerify />} />

            {/* Protected App Routes */}
            <Route element={<ProtectedRoute unauthenticatedElement={<Navigate to="/login" replace />} />}>
              <Route path="/privacy-consent" element={<PrivacyConsent />} />
              <Route path="/ip-denied" element={<IpDenied />} />
              <Route path="/email-verify-required" element={<EmailVerificationRequired />} />
              <Route element={<Layout />}>
                <Route path="/" element={<Dashboard />} />
                <Route path="/tickets" element={<TicketList />} />
                <Route path="/tickets/:id" element={<TicketDetail />} />
                <Route path="/businesses" element={<BusinessList />} />
                <Route path="/businesses/:id" element={<BusinessDetail />} />
                <Route path="/partners" element={<PartnerList />} />
                <Route path="/partners/:id" element={<PartnerDetail />} />
                <Route path="/users" element={<UserManagement />} />
                <Route path="/notifications" element={<Notifications />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/data-deletion-logs" element={<DataDeletionLogs />} />
                <Route path="/role-change-logs" element={<RoleChangeLogs />} />
                <Route path="/access-logs" element={<AccessLogs />} />
                <Route path="/my" element={<MyPage />} />
                <Route path="/privacy" element={<PrivacyNotice />} />
              </Route>
            </Route>

            <Route path="*" element={<PageNotFound />} />
          </Routes>
          <SessionEndedNotice />
        </Router>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  );
}

export default App;