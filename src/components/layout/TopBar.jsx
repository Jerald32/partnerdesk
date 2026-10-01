import { Search, ChevronDown, Menu } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';

export default function TopBar({ title = '', subtitle = '', onToggleMobileNav = () => {} }) {
  const navigate = useNavigate();
  const [searchVal, setSearchVal] = useState('');

  return (
    <header className="fixed top-0 left-0 right-0 md:left-56 h-16 md:h-12 z-20 flex items-center px-4 sm:px-5 gap-3"
      style={{ background: 'hsl(var(--background))', borderBottom: '1px solid hsl(var(--border))' }}>
      
      {/* Mobile menu toggle */}
      <button onClick={onToggleMobileNav} className="md:hidden -ml-4 flex items-center justify-center w-28 h-16 rounded-md hover:bg-accent active:bg-accent transition-colors" aria-label="메뉴 열기">
        <Menu className="w-8 h-8 text-foreground" />
      </button>

      {/* Page title */}
      <div className="flex items-center gap-2 min-w-0">
        {title && <h1 className="text-sm font-semibold text-foreground truncate">{title}</h1>}
        {subtitle && <>
          <span className="text-muted-foreground text-sm">/</span>
          <span className="text-sm text-muted-foreground truncate">{subtitle}</span>
        </>}
      </div>

      <div className="flex-1" />

      {/* Search */}
      <div className="relative hidden md:flex items-center">
        <Search className="absolute left-2.5 w-3.5 h-3.5 text-muted-foreground" />
        <input
          type="text"
          placeholder="티켓 검색..."
          value={searchVal}
          onChange={e => setSearchVal(e.target.value)}
          className="w-52 h-7 pl-7 pr-3 text-xs bg-accent border border-border rounded-md text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

    </header>
  );
}