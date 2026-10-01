import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { Plus, Handshake, ChevronRight, Ticket, Pencil } from 'lucide-react';
import CreatePartnerModal from '@/components/partners/CreatePartnerModal';
import EditPartnerModal from '@/components/partners/EditPartnerModal';
import PartnerMobileCard from '@/components/partners/PartnerMobileCard';

const TYPE_LABELS = {
  manufacturer: '제조사',
  maintenance: '유지보수',
  installation: '설치',
  support: '지원',
  other: '기타',
};

export default function PartnerList() {
  const navigate = useNavigate();
  const [partners, setPartners] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [servicePartners, setServicePartners] = useState([]);
  const [businesses, setBusinesses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editingPartner, setEditingPartner] = useState(null);

  const load = async () => {
    const [p, t, sp, b] = await Promise.all([
      base44.entities.Partner.list('-created_date'),
      base44.entities.Ticket.list(),
      base44.entities.ServicePartner.list(),
      base44.entities.Business.list(),
    ]);
    setPartners(p); setTickets(t); setServicePartners(sp); setBusinesses(b);
    setLoading(false);
  };

  const getPartnerBusinesses = (partnerId) => {
    const ids = servicePartners.filter(sp => sp.partner_id === partnerId).map(sp => sp.business_id);
    return businesses.filter(b => ids.includes(b.id)).map(b => b.name);
  };

  useEffect(() => { load(); }, []);

  const getActiveTickets = (partnerId) => tickets.filter(t => t.partner_id === partnerId && t.status !== 'done').length;
  const getDoneTickets = (partnerId) => tickets.filter(t => t.partner_id === partnerId && t.status === 'done').length;
  const getSlaPerf = (partnerId) => {
    const done = tickets.filter(t => t.partner_id === partnerId && t.status === 'done');
    if (!done.length) return null;
    const onTime = done.filter(t => {
      const hrs = (new Date(t.resolved_at || t.updated_date) - new Date(t.created_date)) / 3600000;
      return hrs <= 24;
    }).length;
    return Math.round((onTime / done.length) * 100);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">파트너 관리</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{partners.length}개 파트너</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 h-8 px-3 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> 파트너 추가
        </button>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-2">
        {loading ? (
          <div className="py-10 text-center text-muted-foreground text-sm">불러오는 중...</div>
        ) : partners.length === 0 ? (
          <div className="py-10 text-center text-muted-foreground text-sm">파트너가 없습니다</div>
        ) : (
          partners.map(partner => (
            <PartnerMobileCard
              key={partner.id}
              partner={partner}
              businessNames={getPartnerBusinesses(partner.id)}
              activeCount={getActiveTickets(partner.id)}
              doneCount={getDoneTickets(partner.id)}
              sla={getSlaPerf(partner.id)}
              onClick={() => navigate(`/partners/${partner.id}`)}
              onEdit={setEditingPartner}
            />
          ))
        )}
      </div>

      {/* Table */}
      <div className="hidden md:block rounded-lg border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              {['파트너명', '담당 비즈니스', '유형', '진행중 티켓', '완료 티켓', 'SLA 성과', ''].map(col => (
                <th key={col} className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array(4).fill(0).map((_, i) => (
                <tr key={i} className="border-b border-border">
                  {Array(7).fill(0).map((_, j) => (
                    <td key={j} className="px-4 py-3">
                      <div className="h-3 bg-accent rounded animate-pulse w-24" />
                    </td>
                  ))}
                </tr>
              ))
            ) : partners.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-10 text-center text-muted-foreground text-sm">파트너가 없습니다</td>
              </tr>
            ) : (
              partners.map(partner => {
                const sla = getSlaPerf(partner.id);
                return (
                  <tr
                    key={partner.id}
                    onClick={() => navigate(`/partners/${partner.id}`)}
                    className="border-b border-border last:border-0 hover:bg-accent cursor-pointer transition-colors group"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-7 h-7 rounded-full overflow-hidden bg-emerald-500/20 flex items-center justify-center text-xs font-semibold text-emerald-400">
                          {partner.logo_url ? <img src={partner.logo_url} alt="" className="w-full h-full object-cover" /> : partner.name?.[0]?.toUpperCase()}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-foreground">{partner.name}</p>
                          {partner.contact_email && <p className="text-[11px] text-muted-foreground">{partner.contact_email}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {getPartnerBusinesses(partner.id).length > 0
                          ? getPartnerBusinesses(partner.id).map(name => (
                              <span key={name} className="text-[11px] px-1.5 py-0.5 bg-primary/10 text-primary rounded border border-primary/20">
                                {name}
                              </span>
                            ))
                          : <span className="text-xs text-muted-foreground">–</span>
                        }
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-muted-foreground px-2 py-0.5 bg-accent rounded border border-border">
                        {TYPE_LABELS[partner.type] || partner.type}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 text-xs text-orange-400">
                        <Ticket className="w-3.5 h-3.5" />
                        <span className="font-medium">{getActiveTickets(partner.id)}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground font-medium">{getDoneTickets(partner.id)}</td>
                    <td className="px-4 py-3">
                      {sla !== null ? (
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-1.5 bg-border rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${sla >= 80 ? 'bg-emerald-500' : sla >= 60 ? 'bg-orange-400' : 'bg-red-500'}`}
                              style={{ width: `${sla}%` }}
                            />
                          </div>
                          <span className={`text-xs font-medium ${sla >= 80 ? 'text-emerald-400' : sla >= 60 ? 'text-orange-400' : 'text-red-400'}`}>
                            {sla}%
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">–</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditingPartner(partner); }}
                          className="p-1.5 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"
                          title="편집"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {showCreate && (
        <CreatePartnerModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}

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