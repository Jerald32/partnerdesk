import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { ArrowLeft, Ticket, Building2, TrendingUp, CheckCircle2, Crown, Wrench, Pencil } from 'lucide-react';
import { StatusBadge, PriorityBadge } from '@/components/ui/StatusBadge';
import EditPartnerModal from '@/components/partners/EditPartnerModal';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

const TYPE_LABELS = { manufacturer: '제조사', maintenance: '유지보수', installation: '설치', support: '지원', other: '기타' };

const ACCESS_LEVEL_LABELS = {
  business: { label: '비즈니스파트너', icon: Crown, color: 'bg-primary/20 text-primary border-primary/30' },
  service: { label: '서비스파트너', icon: Wrench, color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
};

export default function PartnerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [partner, setPartner] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [businesses, setBusinesses] = useState([]);
  const [servicePartners, setServicePartners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingPartner, setEditingPartner] = useState(null);

  const load = async () => {
    const [partners, t, b, sp] = await Promise.all([
      base44.entities.Partner.list(),
      base44.entities.Ticket.filter({ partner_id: id }, '-created_date'),
      base44.entities.Business.list(),
      base44.entities.ServicePartner.filter({ partner_id: id }),
    ]);
    setPartner(partners.find(p => p.id === id) || null);
    setTickets(t); setBusinesses(b); setServicePartners(sp);
    setLoading(false);
  };

  useEffect(() => { load(); }, [id]);

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (!partner) return <div className="text-center py-16 text-muted-foreground">파트너를 찾을 수 없습니다</div>;

  const activeTickets = tickets.filter(t => t.status !== 'done').length;
  const doneTickets = tickets.filter(t => t.status === 'done').length;
  const onTimeTickets = tickets.filter(t => {
    if (t.status !== 'done' || !t.resolved_at) return false;
    const hrs = (new Date(t.resolved_at) - new Date(t.created_date)) / 3600000;
    return hrs <= 24;
  }).length;
  const slaPerf = doneTickets > 0 ? Math.round((onTimeTickets / doneTickets) * 100) : null;

  const connectedBusinesses = servicePartners.map(sp => ({
    ...sp,
    business: businesses.find(b => b.id === sp.business_id),
  }));

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/partners')} className="p-1 rounded hover:bg-accent transition-colors">
          <ArrowLeft className="w-4 h-4 text-muted-foreground" />
        </button>
        <div className="w-9 h-9 rounded-full overflow-hidden bg-emerald-500/20 flex items-center justify-center text-sm font-semibold text-emerald-400">
          {partner.logo_url ? <img src={partner.logo_url} alt="" className="w-full h-full object-cover" /> : partner.name?.[0]?.toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold text-foreground">{partner.name}</h2>
          <p className="text-xs text-muted-foreground">{TYPE_LABELS[partner.type]} {partner.contact_email && `· ${partner.contact_email}`}</p>
          {partner.description && <p className="text-xs text-muted-foreground mt-1">{partner.description}</p>}
        </div>
        <button
          onClick={() => setEditingPartner(partner)}
          className="flex items-center gap-1.5 h-8 px-3 text-xs font-medium bg-accent border border-border rounded-md hover:bg-accent/70 transition-colors shrink-0"
        >
          <Pencil className="w-3.5 h-3.5" /> 편집
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: '전체 티켓', value: tickets.length, icon: Ticket, color: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-500/20' },
          { label: '진행중', value: activeTickets, icon: TrendingUp, color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-500/20' },
          { label: '완료', value: doneTickets, icon: CheckCircle2, color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
          { label: 'SLA 준수율', value: slaPerf !== null ? `${slaPerf}%` : '–', icon: TrendingUp, color: slaPerf >= 80 ? 'text-emerald-400' : 'text-orange-400', bg: 'bg-accent border-border' },
        ].map(stat => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className={`rounded-lg border p-4 ${stat.bg}`}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-muted-foreground">{stat.label}</span>
                <Icon className={`w-4 h-4 ${stat.color}`} />
              </div>
              <div className={`text-2xl font-bold ${stat.color}`}>{stat.value}</div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Connected Businesses */}
        <div className="rounded-lg border border-border bg-card">
          <div className="px-4 py-3 border-b border-border">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Building2 className="w-4 h-4 text-muted-foreground" /> 연결된 비즈니스
            </h3>
          </div>
          {connectedBusinesses.length === 0 ? (
            <div className="py-6 text-center text-muted-foreground text-sm">연결된 비즈니스 없음</div>
          ) : (
            <div className="divide-y divide-border">
              {connectedBusinesses.map(cs => {
                const levelConf = ACCESS_LEVEL_LABELS[cs.access_level] || ACCESS_LEVEL_LABELS.service;
                const LevelIcon = levelConf.icon;
                return (
                  <div key={cs.id} className="px-4 py-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-foreground">{cs.business?.name || '–'}</p>
                      <span className={cn("inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded border", levelConf.color)}>
                        <LevelIcon className="w-3 h-3" /> {levelConf.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                      {cs.role && <span>{cs.role}</span>}
                      <span>응답 {cs.sla_response_hours}h · 해결 {cs.sla_resolution_hours}h</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Ticket List */}
        <div className="lg:col-span-2 rounded-lg border border-border bg-card">
          <div className="px-4 py-3 border-b border-border">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Ticket className="w-4 h-4 text-muted-foreground" /> 배정된 티켓
            </h3>
          </div>
          {tickets.length === 0 ? (
            <div className="py-6 text-center text-muted-foreground text-sm">배정된 티켓 없음</div>
          ) : (
            <div className="divide-y divide-border max-h-80 overflow-y-auto">
              {tickets.slice(0, 20).map(t => (
                <div
                  key={t.id}
                  onClick={() => navigate(`/tickets/${t.id}`)}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-accent cursor-pointer transition-colors"
                >
                  <span className="font-mono text-xs text-muted-foreground">#{t.id?.slice(-6)}</span>
                  <span className="flex-1 text-sm text-foreground truncate">{t.title}</span>
                  <StatusBadge status={t.status} />
                  <span className="text-xs text-muted-foreground">{format(new Date(t.created_date), 'MM/dd')}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {editingPartner && (
        <EditPartnerModal
          partner={editingPartner}
          onClose={() => setEditingPartner(null)}
          onSaved={() => { setEditingPartner(null); load(); }}
        />
      )}
    </div>
  );
}