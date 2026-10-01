import Sidebar from './Sidebar';
import TopBar from './TopBar';
import { Outlet } from 'react-router-dom';

export default function AppLayout({ title, subtitle, userRole = 'admin' }) {
  return (
    <div className="min-h-screen bg-background">
      <Sidebar userRole={userRole} />
      <TopBar title={title} subtitle={subtitle} />
      <main className="ml-56 pt-12 min-h-screen">
        <div className="p-5">
          <Outlet />
        </div>
      </main>
    </div>
  );
}