import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { isPartnerRole } from '@/lib/roles';
import { ArrowLeft, Paperclip, User, Building2, Tag, Calendar, Clock, UserCheck, Eye, Store } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { StatusBadge, PriorityBadge } from '@/components/ui/StatusBadge';
import SlaBar from '@/components/ui/SlaBar';
import StatusTransitionBar from '@/components/tickets/StatusTransitionBar';
import ActivityFeed from '@/components/tickets/ActivityFeed';
import TicketAddressCard from '@/components/tickets/TicketAddressCard';
import { format } from 'date-fns';
import { buildTicketVisibilityFilter } from '@/lib/ticketVisibility';
import { maskName, maskPhone, regionSummary } from '@/lib/mask';
import { logAccess } from '@/lib/accessLog';

export default function TicketDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [currentUser, setCurrentUser] = useState(null);
  const [ticket, setTicket] = useState(null);
  const [activities, setActivities] = useState([]);
  const [businesses, setBusinesses] = useState([]);
  const [partners, setPartners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showViewHistory, setShowViewHistory] = useState(false);

  const loadTicket = async () => {
    const [me, tickets, acts, bizs, parts, sps] = await Promise.all([
      base44.auth.me(),
      base44.entities.Ticket.list(),
      base44.entities.Activity.filter({ ticket_id: id }, '-created_date'),
      base44.entities.Business.list(),
      base44.entities.Partner.list(),
      base44.entities.ServicePartner.list(),
    ]);
    setCurrentUser(me);
    const t = tickets.find(t => t.id === id);
    // Partner 역할 + 파트너사 소속: 관계 기반 가시성 검증 (비즈니스파트너=해당 비즈니스 전체, 서비스파트너=할당된 티켓)
    if (isPartnerRole(me) && t) {
      const visibilityFilter = buildTicketVisibilityFilter(me, parts, sps);
      if (visibilityFilter && !visibilityFilter(t)) {
        navigate('/tickets');
        return;
      }
    }
    setTicket(t || null);
    setActivities(acts);
    setBusinesses(bizs);
    setPartners(parts);
    setLoading(false);

    // 미배정 티켓을 operator가 처음 열면 자동 배정
    if (t && me && !t.operator_id && me.role === 'operator') {
      const opName = me.full_name || me.email;
      await base44.entities.Ticket.update(id, { operator_id: me.id, operator_name: opName });
      await base44.entities.Activity.create({
        ticket_id: id,
        user_id: me.id,
        user_name: opName,
        user_role: me.role,
        type: 'assignment',
        content: `담당자 자동 배정: ${opName}`,
        is_internal: false,
      });
      setTicket({ ...t, operator_id: me.id, operator_name: opName });
    }

    // 조회 감사 로그 기록
    if (t && me) {
      await base44.entities.Activity.create({
        ticket_id: id,
        user_id: me.id,
        user_name: me.full_name || me.email,
        user_role: me.role,
        type: 'view',
        content: `[조회] ${me.full_name || me.email} (${me.role}) 님이 티켓을 조회했습니다.`,
        is_internal: true,
      });

      // 접속기록: 개인정보(고객명·연락처·주소) 처리
      logAccess({
        action: '조회',
        target_type: '티켓 상세',
        target_id: id,
        subject_info: `${t.customer_name ? maskName(t.customer_name) : '고객명 없음'} · ${maskPhone(t.customer_contact)} · ${regionSummary(t.address)}`,
        detail: '티켓 상세 화면 접속 (고객 개인정보 열람)',
      });
    }
  };

  const handleToggleAssign = async () => {
    if (!ticket || !currentUser) return;
    const isMine = ticket.operator_id === currentUser.id;
    if (isMine) {
      await base44.entities.Ticket.update(id, { operator_id: '', operator_name: '' });
      await base44.entities.Activity.create({
        ticket_id: id,
        user_id: currentUser.id,
        user_name: currentUser.full_name || currentUser.email,
        user_role: currentUser.role,
        type: 'assignment',
        content: `담당자 배정 해제`,
        is_internal: false,
      });
      setTicket({ ...ticket, operator_id: '', operator_name: '' });
    } else {
      const opName = currentUser.full_name || currentUser.email;
      await base44.entities.Ticket.update(id, { operator_id: currentUser.id, operator_name: opName });
      await base44.entities.Activity.create({
        ticket_id: id,
        user_id: currentUser.id,
        user_name: opName,
        user_role: currentUser.role,
        type: 'assignment',
        content: `담당자 배정: ${opName}`,
        is_internal: false,
      });
      setTicket({ ...ticket, operator_id: currentUser.id, operator_name: opName });
    }
  };

  useEffect(() => { loadTicket(); }, [id]);

  const handleStatusChange = async (newStatus) => {
    const oldStatus = ticket.status;
    await base44.entities.Ticket.update(id, { status: newStatus, ...(newStatus === 'done' ? { resolved_at: new Date().toISOString() } : {}) });
    await base44.entities.Activity.create({
      ticket_id: id,
      type: 'status_change',
      content: `상태 변경: ${statusLabel[oldStatus]} → ${statusLabel[newStatus]}`,
      is_internal: false,
      user_name: 'Current User',
      user_role: 'admin',
    });
    loadTicket();
  };

  const handlePartnerChange = async (partnerId) => {
    await base44.entities.Ticket.update(id, { partner_id: partnerId });
    await base44.entities.Activity.create({
      ticket_id: id,
      type: 'assignment',
      content: `파트너 배정: ${partners.find(p => p.id === partnerId)?.name || '–'}`,
      is_internal: false,
      user_name: 'Current User',
      user_role: 'admin',
    });
    loadTicket();
  };

  const statusLabel = { new: '신규', inprogress: '진행중', hold: '보류', done: '완료' };

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (!ticket) return (
    <div className="text-center py-16 text-muted-foreground">티켓을 찾을 수 없습니다</div>
  );

  const business = businesses.find(b => b.id === ticket.business_id);
  const partner = partners.find(p => p.id === ticket.partner_id);

  return (
    <div className="space-y-4">
      {/* Back + Status Bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={() => navigate('/tickets')} className="p-1 rounded hover:bg-accent transition-colors">
          <ArrowLeft className="w-4 h-4 text-muted-foreground" />
        </button>
        <span className="text-xs font-mono text-muted-foreground">#{id?.slice(-6)}</span>
        {!isPartnerRole(currentUser) && (
          <StatusTransitionBar currentStatus={ticket.status} onTransition={handleStatusChange} />
        )}
        {isPartnerRole(currentUser?.role) && <StatusBadge status={ticket.status} />}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* Left - 티켓 정보 (상단) → SLA (하단) */}
        <div className="space-y-4">
          {/* 티켓 제목 + 상태/우선순위 */}
          <div className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-lg font-semibold text-foreground mb-3">{ticket.title}</h2>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={ticket.status} />
              <PriorityBadge priority={ticket.priority} />
            </div>
            {/* Attachments */}
            {ticket.attachments?.length > 0 && (
              <div className="mt-4 pt-4 border-t border-border">
                <h4 className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
                  <Paperclip className="w-3.5 h-3.5" /> 첨부파일
                </h4>
                <div className="flex flex-wrap gap-2">
                  {ticket.attachments.map((att, i) => (
                    <a key={i} href={att.url} target="_blank" rel="noreferrer"
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-accent hover:bg-border text-xs text-foreground transition-colors">
                      <Paperclip className="w-3 h-3 text-muted-foreground" />
                      {att.name}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 티켓 정보 */}
          <div className="rounded-lg border border-border bg-card p-4 space-y-3">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">티켓 정보</h4>

            <MetaRow icon={Building2} label="비즈니스" value={business?.name || '–'} />
            <MetaRow icon={User} label="고객명" value={ticket.customer_name || '–'} />
            <MetaRow icon={Store} label="상호" value={ticket.customer_company || '–'} />
            <MetaRow icon={Tag} label="연락처" value={ticket.customer_contact || '–'} />
            <MetaRow icon={UserCheck} label="담당자" value={ticket.operator_name || '미배정'} />
            <MetaRow icon={Calendar} label="생성일" value={format(new Date(ticket.created_date), 'yyyy/MM/dd HH:mm')} />
            {ticket.resolved_at && (
              <MetaRow icon={Clock} label="완료일" value={format(new Date(ticket.resolved_at), 'yyyy/MM/dd HH:mm')} />
            )}

            {/* 담당자 배정 토글 - admin/operator only */}
            {!isPartnerRole(currentUser) && (
              <div className="pt-2 border-t border-border">
                <label className="flex items-center justify-between cursor-pointer">
                  <span className="text-xs font-medium text-muted-foreground">나에게 배정</span>
                  <Switch
                    checked={ticket.operator_id === currentUser.id}
                    onCheckedChange={handleToggleAssign}
                  />
                </label>
              </div>
            )}

            {/* Partner assignment - admin/operator only */}
            {!isPartnerRole(currentUser) && (
              <div className="pt-2 border-t border-border">
                <label className="text-xs font-medium text-muted-foreground block mb-1.5">파트너 배정</label>
                <select
                  value={ticket.partner_id || ''}
                  onChange={e => handlePartnerChange(e.target.value)}
                  className="w-full h-7 px-2.5 text-xs bg-accent border border-border rounded-md text-foreground focus:outline-none focus:ring-1 focus:ring-ring appearance-none cursor-pointer"
                >
                  <option value="">파트너 미배정</option>
                  {partners.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            )}
          </div>

          {/* 현장 지원 출동 주소 */}
          <TicketAddressCard
            ticket={ticket}
            editable={!isPartnerRole(currentUser)}
            onSaved={loadTicket}
          />

          {/* 고객 요청사항 / 설명 */}
          {(ticket.request_detail || ticket.description) && (
            <div className="rounded-lg border border-border bg-card p-4 space-y-3">
              {ticket.request_detail && (
                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">고객 요청사항</h4>
                  <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap">{ticket.request_detail}</p>
                </div>
              )}
              {ticket.description && (
                <div className={ticket.request_detail ? 'pt-3 border-t border-border' : ''}>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">설명</h4>
                  <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap">{ticket.description}</p>
                </div>
              )}
            </div>
          )}

          {/* SLA 현황 */}
          <div className="rounded-lg border border-border bg-card p-4">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">SLA 현황</h4>
            <SlaBar createdAt={ticket.created_date} slaHours={24} />
          </div>
        </div>

        {/* Right - 타임라인(상단) → 상담 내용 기록(하단) */}
        <div className="xl:col-span-2 space-y-4">
          {/* 타임라인 (최신순) */}
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">타임라인</h4>
              <button
                onClick={() => setShowViewHistory(v => !v)}
                className={cn(
                  "flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md border transition-colors",
                  showViewHistory ? "bg-primary/15 text-primary border-primary/30" : "bg-accent text-muted-foreground border-border hover:text-foreground"
                )}
              >
                <Eye className="w-3 h-3" /> 조회 이력
              </button>
            </div>
            <div className="space-y-2.5">
              {activities
                .filter(a => a.type === 'status_change' || a.type === 'assignment')
                .slice(0, 6)
                .map(act => (
                  <div key={act.id} className="flex items-start gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-foreground leading-tight">{act.content}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {format(new Date(act.created_date), 'MM/dd HH:mm')}
                      </p>
                    </div>
                  </div>
                ))}
              {activities.filter(a => a.type === 'status_change' || a.type === 'assignment').length === 0 && (
                <p className="text-xs text-muted-foreground">이벤트 없음</p>
              )}
            </div>
            {showViewHistory && (
              <div className="mt-3 pt-3 border-t border-border">
                <div className="max-h-48 overflow-y-auto space-y-2 pr-1">
                  {activities.filter(a => a.type === 'view').length === 0 ? (
                    <p className="text-xs text-muted-foreground">조회 이력 없음</p>
                  ) : (
                    activities.filter(a => a.type === 'view').map(act => (
                      <div key={act.id} className="flex items-start gap-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground mt-1.5 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-muted-foreground leading-tight">{act.content}</p>
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            {format(new Date(act.created_date), 'MM/dd HH:mm')}
                          </p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 상담 내용 기록 */}
          <div className="rounded-lg border border-border bg-card p-5 h-[520px] flex flex-col">
            <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
              상담 내용 기록
              <span className="text-xs text-muted-foreground font-normal">({activities.filter(a => a.type === 'comment' || a.type === 'note').length})</span>
            </h3>
            <div className="flex-1 overflow-hidden">
              <ActivityFeed
                ticketId={id}
                activities={activities.filter(a => a.type === 'comment' || a.type === 'note')}
                onRefresh={loadTicket}
                userRole="admin"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MetaRow({ icon: Icon, label, value }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <span className="text-xs text-muted-foreground w-14 shrink-0">{label}</span>
      <span className="text-xs text-foreground truncate">{value}</span>
    </div>
  );
}