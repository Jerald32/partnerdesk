import { useState } from 'react';
import { Toaster } from '@/components/ui/toaster';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClientInstance } from '@/lib/query-client';
import { BrowserRouter, Routes, Route, Outlet, Navigate, Link } from 'react-router-dom';
import { AuthProvider } from '@/lib/AuthContext';
import ProtectedRoute from '@/components/ProtectedRoute';
import Sidebar from '@/components/layout/Sidebar';
import TopBar from '@/components/layout/TopBar';
import Login from '@/pages/Login';
import Dashboard from '@/pages/Dashboard';
import TicketList from '@/pages/TicketList';
import TicketDetail from '@/pages/TicketDetail';
import BusinessList from '@/pages/BusinessList';
import { useIdleTimeout } from '@/hooks/useIdleTimeout';

function Layout() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  useIdleTimeout();
  return <div className="min-h-screen bg-background font-inter">
    <Sidebar mobileNavOpen={mobileNavOpen} onCloseMobileNav={() => setMobileNavOpen(false)} />
    <TopBar onToggleMobileNav={() => setMobileNavOpen(true)} />
    <main className="pt-16 md:pt-12 min-h-screen md:ml-56"><div className="p-4 sm:p-5"><Outlet /></div></main>
  </div>;
}

function Unavailable() {
  return <div className="p-6 space-y-3"><p>이 화면은 Supabase 전환 준비 중입니다.</p>
    <Link to="/" className="text-primary">대시보드로 돌아가기</Link></div>;
}

export default function App() {
  return <AuthProvider><QueryClientProvider client={queryClientInstance}><BrowserRouter>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Unavailable />} />
      <Route path="/forgot-password" element={<Unavailable />} />
      <Route path="/reset-password" element={<Unavailable />} />
      <Route element={<ProtectedRoute unauthenticatedElement={<Navigate to="/login" replace />} />}>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/tickets" element={<TicketList />} />
          <Route path="/tickets/:id" element={<TicketDetail />} />
          <Route path="/businesses" element={<BusinessList />} />
          <Route path="/businesses/:id" element={<Unavailable />} />
          <Route path="*" element={<Unavailable />} />
        </Route>
      </Route>
    </Routes><Toaster />
  </BrowserRouter></QueryClientProvider></AuthProvider>;
}
