import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { TrendingUp, Clock, AlertTriangle, CheckCircle2, ArrowUpRight, Ticket } from 'lucide-react';
import { StatusBadge, PriorityBadge } from '@/components/ui/StatusBadge';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { format, isToday } from 'date-fns';

const KPI_CARDS = [
  { key: 'today', label: '오늘 접수', icon: Ticket, color: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-500/20' },
  { key: 'inprogress', label: '진행중', icon: TrendingUp, color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-500/20' },
  { key: 'delayed', label: '지연', icon: AlertTriangle, color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20' },
  { key: 'done', label: '완료', icon: CheckCircle2, color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
];

const PIE_COLORS = {
  new: '#64748b',
  inprogress: '#3b82f6',
  hold: '#f97316',
  done: '#10b981',
};

export default function Dashboard() {
  const navigate = useNavigate();
  const [tickets, setTickets] = useState([]);
  const [partners, setPartners] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      base44.entities.Ticket.list('-created_date', 100),
      base44.entities.Partner.list(),
    ]).then(([t, p]) => {
      setTickets(t);
      setPartners(p);
    }).finally(() => setLoading(false));
  }, []);

  const kpiData = {
    today: tickets.filter(t => isToday(new Date(t.created_date))).length,
    inprogress: tickets.filter(t => t.status === 'inprogress').length,
    delayed: tickets.filter(t => {
      if (t.status === 'done') return false;
      const hrs = (new Date() - new Date(t.created_date)) / 3600000;
      return hrs > 24;
    }).length,
    done: tickets.filter(t => t.status === 'done').length,
  };

  const statusDist = Object.entries(
    tickets.reduce((acc, t) => { acc[t.status] = (acc[t.status] || 0) + 1; return acc; }, {})
  ).map(([name, value]) => ({ name, value }));

  const partnerPerf = partners.slice(0, 5).map(p => ({
    name: p.name.length > 8 ? p.name.slice(0, 8) + '…' : p.name,
    active: tickets.filter(t => t.partner_id === p.id && t.status !== 'done').length,
    done: tickets.filter(t => t.partner_id === p.id && t.status === 'done').length,
  }));

  const urgentTickets = tickets
    .filter(t => t.priority === 'urgent' || t.status === 'hold')
    .slice(0, 6);

  const statusLabel = { new: '신규', inprogress: '진행중', hold: '보류', done: '완료' };

  return (
    <div className="space-y-5">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {KPI_CARDS.map(card => {
          const Icon = card.icon;
          return (
            <div key={card.key} className={`rounded-lg border p-4 ${card.bg}`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted-foreground">{card.label}</span>
                <Icon className={`w-4 h-4 ${card.color}`} />
              </div>
              <div className={`text-2xl font-bold ${card.color}`}>
                {loading ? '–' : kpiData[card.key]}
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Status Pie */}
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold mb-3 text-foreground">상태 분포</h3>
          {statusDist.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={160}>
                <PieChart>
                  <Pie data={statusDist} dataKey="value" cx="50%" cy="50%" innerRadius={45} outerRadius={70}>
                    {statusDist.map((entry) => (
                      <Cell key={entry.name} fill={PIE_COLORS[entry.name] || '#64748b'} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 6, fontSize: 12 }}
                    formatter={(v, n) => [v, statusLabel[n] || n]}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap gap-2 mt-1">
                {statusDist.map(s => (
                  <div key={s.name} className="flex items-center gap-1 text-[11px]">
                    <span className="w-2 h-2 rounded-full" style={{ background: PIE_COLORS[s.name] }} />
                    <span className="text-muted-foreground">{statusLabel[s.name]}</span>
                    <span className="text-foreground font-medium">{s.value}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="h-40 flex items-center justify-center text-muted-foreground text-sm">데이터 없음</div>
          )}
        </div>

        {/* Partner Performance */}
        <div className="lg:col-span-2 rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold mb-3 text-foreground">파트너 현황</h3>
          {partnerPerf.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={partnerPerf} barSize={10}>
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} width={25} />
                <Tooltip
                  contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 6, fontSize: 12 }}
                />
                <Bar dataKey="active" name="진행중" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                <Bar dataKey="done" name="완료" fill="#10b981" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-44 flex items-center justify-center text-muted-foreground text-sm">데이터 없음</div>
          )}
        </div>
      </div>

      {/* Urgent Tickets */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground">긴급 티켓</h3>
          <button onClick={() => navigate('/tickets')} className="text-xs text-primary flex items-center gap-0.5 hover:underline">
            전체 보기 <ArrowUpRight className="w-3 h-3" />
          </button>
        </div>
        {urgentTickets.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground text-sm">긴급 티켓이 없습니다</div>
        ) : (
          <div className="divide-y divide-border">
            {urgentTickets.map(ticket => (
              <div
                key={ticket.id}
                onClick={() => navigate(`/tickets/${ticket.id}`)}
                className="flex items-center gap-3 px-4 py-3 hover:bg-accent cursor-pointer transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground font-mono">#{ticket.id?.slice(-6)}</span>
                    <span className="text-sm font-medium text-foreground truncate">{ticket.title}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <StatusBadge status={ticket.status} />
                    <PriorityBadge priority={ticket.priority} />
                  </div>
                </div>
                <div className="text-xs text-muted-foreground shrink-0">
                  {format(new Date(ticket.created_date), 'MM/dd HH:mm')}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}