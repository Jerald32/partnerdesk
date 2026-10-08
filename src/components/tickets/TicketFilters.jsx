import { Search, X } from 'lucide-react';

const STATUS_OPTIONS = [
  { value: '', label: '전체 상태' },
  { value: 'new', label: '신규' },
  { value: 'inprogress', label: '진행중' },
  { value: 'hold', label: '보류' },
  { value: 'done', label: '완료' },
];

const PRIORITY_OPTIONS = [
  { value: '', label: '전체 우선순위' },
  { value: 'urgent', label: '긴급' },
  { value: 'high', label: '높음' },
  { value: 'normal', label: '보통' },
  { value: 'low', label: '낮음' },
];

const selectClass = "h-7 px-2.5 text-xs bg-accent border border-border rounded-md text-foreground focus:outline-none focus:ring-1 focus:ring-ring appearance-none cursor-pointer";

export default function TicketFilters({ filters, onChange, businesses = [], partners = [], currentUser = null }) {
  const set = (key, val) => onChange({ ...filters, [key]: val });
  const hasActive = Object.values(filters).some(v => v);
  const canShowMine = currentUser && ['admin','operator'].includes(currentUser.role);

  return (
    <div className="flex flex-col gap-2.5">
      {/* Status tab buttons */}
      <div className="flex flex-wrap items-center gap-1.5">
        {STATUS_OPTIONS.map(o => (
          <button
            key={o.value}
            onClick={() => set('status', o.value)}
            className={`h-7 px-3 text-xs rounded-md font-medium transition-colors border ${
              (filters.status || '') === o.value
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-accent text-muted-foreground border-border hover:text-foreground'
            }`}
          >
            {o.label}
          </button>
        ))}
        <div className="w-px h-5 bg-border mx-1" />
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="티켓 검색..."
            value={filters.search || ''}
            onChange={e => set('search', e.target.value)}
            className="h-7 pl-8 pr-3 w-full sm:w-48 text-xs bg-accent border border-border rounded-md text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
      <select value={filters.priority || ''} onChange={e => set('priority', e.target.value)} className={selectClass}>
        {PRIORITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>

      <button
        onClick={() => set('unassigned', !filters.unassigned)}
        className={`h-7 px-3 text-xs rounded-md font-medium transition-colors border ${
          filters.unassigned
            ? 'bg-orange-500/20 text-orange-400 border-orange-500/30'
            : 'bg-accent text-muted-foreground border-border hover:text-foreground'
        }`}
      >
        미배정만 보기
      </button>

      {canShowMine && (
        <button
          onClick={() => set('mine', !filters.mine)}
          className={`h-7 px-3 text-xs rounded-md font-medium transition-colors border ${
            filters.mine
              ? 'bg-primary/20 text-primary border-primary/30'
              : 'bg-accent text-muted-foreground border-border hover:text-foreground'
          }`}
        >
          내 배정 보기
        </button>
      )}

      {businesses.length > 0 && (
        <select value={filters.business_id || ''} onChange={e => set('business_id', e.target.value)} className={selectClass}>
          <option value="">전체 비즈니스</option>
          {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      )}

      {partners.length > 0 && (
        <select value={filters.partner_id || ''} onChange={e => set('partner_id', e.target.value)} className={selectClass}>
          <option value="">전체 파트너</option>
          {partners.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}

      {hasActive && (
        <button
          onClick={() => onChange({ search: '', status: '', priority: '', business_id: '', partner_id: '', unassigned: false, mine: false })}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="w-3 h-3" /> 초기화
        </button>
      )}
      </div>
    </div>
  );
}