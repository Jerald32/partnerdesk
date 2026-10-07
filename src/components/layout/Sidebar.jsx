import { Link, useLocation } from 'react-router-dom';
import { 
  LayoutDashboard, Ticket, Settings, Users, Building2,
  Handshake, ChevronRight, Zap, CircleUser,
  Shield, UserCog, Ghost, Crown, ScrollText, ShieldCheck, History
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/AuthContext';
import { isGuest } from '@/lib/roles';

const ROLE_CONFIG = {
  admin:         { label: 'Admin',         icon: Shield,    color: 'bg-primary/20 text-primary border-primary/30' },
  operator:      { label: 'Operator',      icon: UserCog,   color: 'bg-orange-500/20 text-orange-400 border-orange-500/30' },
  partner_admin: { label: 'Partner Admin', icon: Crown,     color: 'bg-teal-500/20 text-teal-400 border-teal-500/30' },
  guest:         { label: 'Guest',          icon: Ghost,     color: 'bg-slate-500/20 text-slate-400 border-slate-500/30' },
};

const navItems = [
  { label: '대시보드', icon: LayoutDashboard, path: '/' },
  { label: '티켓', icon: Ticket, path: '/tickets' },
  { label: '비즈니스', icon: Building2, path: '/businesses' },
  { label: '파트너', icon: Handshake, path: '/partners' },
  { label: '사용자', icon: Users, path: '/users' },
  { label: '권한 변경 이력', icon: ShieldCheck, path: '/role-change-logs', adminOnly: true },
  { label: '접속 기록', icon: History, path: '/access-logs', adminOnly: true },
  { label: '파기 이력', icon: ScrollText, path: '/data-deletion-logs' },
  { label: '설정', icon: Settings, path: '/settings' },
];

export default function Sidebar({ mobileNavOpen = false, onCloseMobileNav = () => {} }) {
  const location = useLocation();
  const { user, logout } = useAuth();

  const userRole = user?.role || 'guest';
  const roleConf = ROLE_CONFIG[userRole] || ROLE_CONFIG.guest;

  return (
    <>
      {/* Mobile backdrop */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-40 bg-black/60 md:hidden" onClick={onCloseMobileNav} />
      )}
      <aside
        className={cn(
          "fixed left-0 top-0 h-screen w-56 flex flex-col z-50 transition-transform duration-200 md:translate-x-0 md:z-30",
          mobileNavOpen ? "translate-x-0" : "-translate-x-full"
        )}
        style={{ background: 'hsl(215, 30%, 5%)', borderRight: '1px solid hsl(var(--border))' }}
      >
      
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-4 py-4 border-b border-border">
        <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center">
          <Zap className="w-4 h-4 text-white" />
        </div>
        <span className="font-semibold text-sm tracking-tight text-foreground">PartnerDesk</span>
      </div>

      {/* Role badge */}
      <div className="px-4 py-2.5 border-b border-border">
        <span className={cn(
          "text-[10px] font-semibold uppercase tracking-widest px-2 py-0.5 rounded border",
          roleConf.color
        )}>
          {roleConf.label}
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {navItems.filter((item) => ['/', '/tickets', '/businesses'].includes(item.path) && !isGuest(userRole) && (!item.adminOnly || userRole === 'admin')).map((item) => {
          const isActive = location.pathname === item.path || 
            (item.path !== '/' && location.pathname.startsWith(item.path));
          const Icon = item.icon;
          
          return (
            <Link
              key={item.path}
              to={item.path}
              onClick={onCloseMobileNav}
              className={cn(
                "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-all duration-150 group",
                isActive
                  ? "bg-primary/15 text-primary font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              )}
            >
              <Icon className={cn("w-4 h-4 shrink-0", isActive ? "text-primary" : "")} />
              <span className="flex-1">{item.label}</span>
              {isActive && <ChevronRight className="w-3 h-3 text-primary" />}
            </Link>
          );
        })}
      </nav>

      {/* My account link */}
      <div className="px-3 py-3 border-t border-border">
        <Link
          to="/"
          onClick={onCloseMobileNav}
          className={cn(
            "flex items-center gap-2.5 px-2 py-1.5 rounded-md transition-colors",
            location.pathname === '/my' ? "bg-primary/15 text-primary" : "hover:bg-accent cursor-pointer text-muted-foreground hover:text-foreground"
          )}
        >
          <div className={cn("w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold",
            roleConf.color
          )}>
            <CircleUser className="w-3.5 h-3.5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-foreground truncate">{user?.display_name || user?.full_name || user?.email}</p>
            <p className="text-[10px] text-muted-foreground truncate uppercase">{roleConf.label}</p>
          </div>
        </Link>
        <button onClick={() => logout(true)} className="px-2 mt-2 text-xs text-muted-foreground hover:text-foreground">로그아웃</button>
      </div>
      </aside>
    </>
  );
}
