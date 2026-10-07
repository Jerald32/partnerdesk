import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/lib/AuthContext';
import { invokeAppAuth } from '@/lib/appAuth';
import { Plus } from 'lucide-react';
import { StatusBadge, PriorityBadge } from '@/components/ui/StatusBadge';
import SlaBar from '@/components/ui/SlaBar';
import TicketFilters from '@/components/tickets/TicketFilters';
import { format } from 'date-fns';
import TicketMobileCard from '@/components/tickets/TicketMobileCard';
import CreateTicketModal from '@/components/tickets/CreateTicketModal';
import { maskName, maskPhone, regionSummary } from '@/lib/mask';

// Match Dashboard's paged reads so the Data API limit does not truncate filters.
async function readAllRows(createQuery, signal) {
  const rows = [];
  while (!signal.aborted) {
    const { data, error, count } = await createQuery()
      .range(rows.length, rows.length + 499).abortSignal(signal);
    if (error) throw error;
    if (!data?.length) return rows;
    rows.push(...data);
    if (count !== null && rows.length >= count) return rows;
  }
  return rows;
}

export default function TicketList() {
  const navigate = useNavigate();
  const { user: currentUser } = useAuth();
  const [tickets, setTickets] = useState([]);
  const [businesses, setBusinesses] = useState([]);
  const [partners, setPartners] = useState([]);
  const [servicePartners, setServicePartners] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [refreshCounter, setRefreshCounter] = useState(0);
  const [createdTicketId, setCreatedTicketId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState({ search: '', status: '', priority: '', business_id: '', partner_id: '', unassigned: false, mine: false });

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setTickets([]);
    setBusinesses([]);
    setPartners([]);
    setServicePartners([]);

    async function loadTickets() {
      try {
        // Validate without extending the session; invalid sessions may hide all rows.
        await invokeAppAuth('validate-session');
        if (controller.signal.aborted) return;
        const [ticketRows, businessRows, partnerRows, relationRows] = await Promise.all([
          readAllRows(() => supabase.from('tickets').select(
            'id,title,business_id,customer_company,customer_name,customer_contact,address,request_type,request_detail,status,priority,operator_profile_id,operator_name_snapshot,assigned_partner_organization_id,created_at,resolved_at',
            { count: 'exact' },
          ).order('created_at', { ascending: false }).order('id'), controller.signal),
          readAllRows(() => supabase.from('businesses').select('id,name', { count: 'exact' })
            .order('name').order('id'), controller.signal),
          readAllRows(() => supabase.from('organizations').select('id,name', { count: 'exact' })
            .eq('type', 'partner').order('name').order('id'), controller.signal),
          readAllRows(() => supabase.from('service_partners')
            .select('id,business_id,partner_organization_id', { count: 'exact' })
            .order('id'), controller.signal),
        ]);
        if (controller.signal.aborted) return;
        // RLS determines visibility; these filters only narrow the returned rows.
        setTickets(ticketRows);
        setBusinesses(businessRows);
        setPartners(partnerRows);
        setServicePartners(relationRows);
      } catch {
        if (!controller.signal.aborted) {
          setError(createdTicketId
            ? '티켓 생성은 완료되었지만 목록을 갱신하지 못했습니다. 다시 생성하지 말고 새로고침해 주세요.'
            : '티켓을 불러오지 못했습니다. 로그인 세션과 조회 권한을 확인한 뒤 새로고침해 주세요.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void loadTickets();
    return () => controller.abort();
  }, [currentUser?.id, refreshCounter, createdTicketId]);

  const filtered = tickets.filter(t => {
    if (filters.search && !t.title?.toLowerCase().includes(filters.search.toLowerCase()) &&
        !t.id?.includes(filters.search)) return false;
    if (filters.status && t.status !== filters.status) return false;
    if (filters.priority && t.priority !== filters.priority) return false;
    if (filters.business_id && t.business_id !== filters.business_id) return false;
    if (filters.partner_id && t.assigned_partner_organization_id !== filters.partner_id) return false;
    if (filters.unassigned && t.operator_profile_id) return false;
    if (filters.mine && (!currentUser || t.operator_profile_id !== currentUser.id)) return false;
    return true;
  });

  const getBusinessName = id => businesses.find(b => b.id === id)?.name || '–';
  const getPartnerName = id => partners.find(p => p.id === id)?.name || '–';

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">티켓</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{loading || error ? '–' : filtered.length}개 티켓</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            disabled={loading || Boolean(error)}
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 h-8 px-3 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> 티켓 생성
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-lg border border-border bg-card px-4 py-3">
        <TicketFilters filters={filters} onChange={setFilters} businesses={businesses} partners={partners} currentUser={currentUser} />
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-2">
        {loading ? (
          <div className="py-10 text-center text-muted-foreground text-sm">불러오는 중...</div>
        ) : error ? (
          <div role="alert" className="py-10 text-center text-muted-foreground text-sm">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="py-10 text-center text-muted-foreground text-sm">티켓이 없습니다</div>
        ) : (
          filtered.map(ticket => (
            <TicketMobileCard
              key={ticket.id}
              ticket={ticket}
              businesses={businesses}
              partners={partners}
              onClick={() => navigate(`/tickets/${ticket.id}`)}
            />
          ))
        )}
      </div>

      {/* Table */}
      <div className="hidden md:block rounded-lg border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                {['티켓 ID', '비즈니스', '상호', '고객', '요청 유형', '고객요청사항', '상태', '우선순위', '담당자', '파트너', 'SLA', '생성일', '완료일', '리드타임'].map(col => (
                  <th key={col} className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground whitespace-nowrap">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array(6).fill(0).map((_, i) => (
                  <tr key={i} className="border-b border-border">
                    {Array(14).fill(0).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-3 bg-accent rounded animate-pulse" style={{ width: `${40 + Math.random() * 40}%` }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : error ? (
                <tr>
                  <td role="alert" colSpan={14} className="py-10 text-center text-muted-foreground text-sm">{error}</td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={14} className="py-10 text-center text-muted-foreground text-sm">티켓이 없습니다</td>
                </tr>
              ) : (
                filtered.map(ticket => (
                  <tr
                    key={ticket.id}
                    onClick={() => navigate(`/tickets/${ticket.id}`)}
                    className="border-b border-border hover:bg-accent cursor-pointer transition-colors last:border-0"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">#{ticket.id?.slice(-6)}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{getBusinessName(ticket.business_id)}</td>
                    <td className="px-4 py-3 text-xs whitespace-nowrap">
                      <div className="text-foreground">{ticket.customer_company || '–'}</div>
                      <div className="text-[11px] text-muted-foreground">{regionSummary(ticket.address)}</div>
                    </td>
                    <td className="px-4 py-3 text-xs whitespace-nowrap">
                      <div className="text-foreground">{maskName(ticket.customer_name)}</div>
                      <div className="text-[11px] text-muted-foreground">{maskPhone(ticket.customer_contact)}</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{ticket.request_type || '–'}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground max-w-[220px]">
                      <div className="truncate">{ticket.request_detail || '–'}</div>
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={ticket.status} /></td>
                    <td className="px-4 py-3"><PriorityBadge priority={ticket.priority} /></td>
                    <td className="px-4 py-3 text-xs whitespace-nowrap">
                      {ticket.operator_name_snapshot
                        ? <span className="text-foreground">{ticket.operator_name_snapshot}</span>
                        : <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-500/15 text-slate-400 border border-slate-500/25">미배정</span>}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{getPartnerName(ticket.assigned_partner_organization_id)}</td>
                    <td className="px-4 py-3 w-28"><SlaBar createdAt={ticket.created_at} slaHours={24} compact /></td>
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      {format(new Date(ticket.created_at), 'MM/dd HH:mm')}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      {ticket.resolved_at ? format(new Date(ticket.resolved_at), 'MM/dd HH:mm') : '–'}
                    </td>
                    <td className="px-4 py-3 text-xs whitespace-nowrap">
                      {ticket.resolved_at ? (() => {
                        const mins = Math.round((new Date(ticket.resolved_at) - new Date(ticket.created_at)) / 60000);
                        if (mins < 60) return <span className="text-muted-foreground">{mins}분</span>;
                        const hrs = Math.floor(mins / 60);
                        if (hrs < 24) return <span className="text-muted-foreground">{hrs}시간 {mins % 60}분</span>;
                        return <span className="text-muted-foreground">{Math.floor(hrs / 24)}일 {hrs % 24}시간</span>;
                      })() : <span className="text-muted-foreground">–</span>}
                    </td>
                    </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showCreate && (
        <CreateTicketModal
          businesses={businesses}
          partners={partners}
          servicePartners={servicePartners}
          onClose={() => setShowCreate(false)}
          onCreated={ticket => {
            setShowCreate(false);
            setCreatedTicketId(ticket.id);
            setRefreshCounter(counter => counter + 1);
          }}
        />
      )}
    </div>
  );
}
