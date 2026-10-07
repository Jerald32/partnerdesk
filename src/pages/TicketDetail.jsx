import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/lib/AuthContext';
import { invokeAppAuth } from '@/lib/appAuth';
import { ArrowLeft, User, Building2, Tag, Calendar, Clock, UserCheck, Eye, Store } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { StatusBadge, PriorityBadge } from '@/components/ui/StatusBadge';
import SlaBar from '@/components/ui/SlaBar';
import StatusTransitionBar from '@/components/tickets/StatusTransitionBar';
import ActivityFeed from '@/components/tickets/ActivityFeed';
import TicketAddressCard from '@/components/tickets/TicketAddressCard';
import { format } from 'date-fns';

export default function TicketDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user: currentUser } = useAuth();
  const isOperator = ['admin', 'operator'].includes(currentUser?.role);
  const [error, setError] = useState(null);
  const [loadedId, setLoadedId] = useState(null);
  const [ticket, setTicket] = useState(null);
  const [activities, setActivities] = useState([]);
  const [businesses, setBusinesses] = useState([]);
  const [partners, setPartners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showViewHistory, setShowViewHistory] = useState(false);
  const [refreshCounter, setRefreshCounter] = useState(0);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const writing = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const version = ++generation.current;
    setSaving(false);
    setLoading(true);
    setError(null);
    setTicket(null);
    setActivities([]);
    setBusinesses([]);
    setPartners([]);
    setShowViewHistory(false);
    async function loadTicket() {
      try {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '')) {
          setError('올바른 티켓 주소가 아닙니다.');
          return;
        }
        await invokeAppAuth('validate-session');
        if (controller.signal.aborted) return;
        const { data: row, error: ticketError } = await supabase.from('tickets')
          .select('id,title,description,request_type,request_detail,business_id,customer_name,customer_company,customer_contact,address,address_detail,status,priority,operator_profile_id,operator_name_snapshot,assigned_partner_organization_id,created_at,resolved_at,version,retention_state')
          .eq('id', id).abortSignal(controller.signal).maybeSingle();
        if (ticketError) throw ticketError;
        if (controller.signal.aborted || !row) return;
        async function readActivities() {
          const rows = [];
          while (!controller.signal.aborted) {
            const { data, error: activityError, count } = await supabase.from('activities')
              .select('id,ticket_id,actor_profile_id,actor_name_snapshot,actor_role_snapshot,type,content,is_internal,created_at', { count: 'exact' })
              .eq('ticket_id', row.id).order('created_at', { ascending: false }).order('id')
              .range(rows.length, rows.length + 499).abortSignal(controller.signal);
            if (activityError) throw activityError;
            if (!data?.length) break;
            rows.push(...data);
            if (count !== null && rows.length >= count) break;
          }
          return rows;
        }
        async function readPartners() {
          const relations = [];
          while (!controller.signal.aborted) {
            const { data, error: relationError, count } = await supabase.from('service_partners')
              .select('id,partner_organization_id', { count: 'exact' }).eq('business_id', row.business_id)
              .order('id').range(relations.length, relations.length + 499).abortSignal(controller.signal);
            if (relationError) throw relationError;
            if (!data?.length) break;
            relations.push(...data);
            if (count !== null && relations.length >= count) break;
          }
          const ids = [...new Set([...relations.map(r => r.partner_organization_id), row.assigned_partner_organization_id].filter(Boolean))];
          const organizations = [];
          for (let offset = 0; offset < ids.length; offset += 100) {
            const { data, error: organizationError } = await supabase.from('organizations').select('id,name')
              .eq('type', 'partner').in('id', ids.slice(offset, offset + 100)).order('name').abortSignal(controller.signal);
            if (organizationError) throw organizationError;
            organizations.push(...data);
          }
          return { data: organizations, relationIds: new Set(relations.map(r => r.partner_organization_id)) };
        }
        const [businessResult, partnerResult, activityRows] = await Promise.all([
          supabase.from('businesses').select('id,name').eq('id', row.business_id)
            .abortSignal(controller.signal).maybeSingle(),
          readPartners(),
          readActivities(),
        ]);
        if (businessResult.error) throw businessResult.error;
        if (controller.signal.aborted) return;
        setTicket(row);
        setBusinesses(businessResult.data ? [businessResult.data] : []);
        setPartners(partnerResult.data.map(p => ({ ...p, selectable: partnerResult.relationIds.has(p.id) })));
        setActivities(activityRows);
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(failure.reason || failure.code === '28000'
            ? '로그인 세션을 확인할 수 없습니다. 다시 로그인해 주세요.'
            : '티켓을 불러오지 못했습니다. 로그인 세션과 조회 권한을 확인한 뒤 새로고침해 주세요.');
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoadedId(id);
          setLoading(false);
        }
      }
    }
    void loadTicket();
    return () => { controller.abort(); if (generation.current === version) ++generation.current; };
  }, [id, currentUser?.id, refreshCounter]);

  async function mutateTicket(rpc, args) {
    if (writing.current || loading || loadedId !== id || !ticket || ticket.retention_state === 'anonymized') return false;
    writing.current = true;
    const version = generation.current;
    setSaving(true);
    setNotice('');
    try {
      const { data, error: rpcError } = await supabase.rpc(rpc, args);
      if (rpcError) throw rpcError;
      const validId = typeof data?.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.id);
      if (!validId || (rpc === 'add_ticket_activity'
        ? data.ticket_id !== ticket.id || data.type !== args.p_type || data.is_internal !== (args.p_type === 'note') || !Number.isFinite(Date.parse(data.created_at))
        : data.id !== ticket.id || data.version !== ticket.version + 1 ||
          (rpc === 'change_ticket_status' ? data.status !== args.p_status : data.assigned_partner_organization_id !== args.p_assigned_partner_organization_id))) {
        throw new Error('invalid_rpc_response');
      }
      if (generation.current !== version) return true;
      setNotice('저장되었습니다.');
      setRefreshCounter(value => value + 1);
      return true;
    } catch (failure) {
      if (generation.current !== version) return false;
      if (failure.code === '40001') {
        setNotice('다른 변경으로 데이터가 갱신되었습니다. 최신 내용을 확인한 뒤 다시 시도해 주세요.');
        setRefreshCounter(value => value + 1);
      } else if (!failure.code) {
        setNotice('처리 결과를 확인할 수 없습니다. 자동 재시도하지 않습니다. 최신 기록을 확인해 주세요.');
        setRefreshCounter(value => value + 1);
      } else {
        setNotice('저장하지 못했습니다. 세션, 접근 권한과 입력값을 확인해 주세요.');
      }
      return false;
    } finally {
      writing.current = false;
      if (generation.current === version) setSaving(false);
    }
  }

  if (loading || loadedId !== id) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (error) return (
    <div role="alert" className="text-center py-16 text-muted-foreground space-y-3">
      {notice && <p>{notice}</p>}
      <p>{error}</p>
      <button onClick={() => navigate('/tickets')} className="text-primary text-sm">티켓 목록으로 돌아가기</button>
    </div>
  );

  if (!ticket) return (
    <div className="text-center py-16 text-muted-foreground space-y-3">
      <p>티켓을 찾을 수 없거나 접근 권한이 없습니다.</p>
      <button onClick={() => navigate('/tickets')} className="text-primary text-sm">티켓 목록으로 돌아가기</button>
    </div>
  );

  const business = businesses.find(b => b.id === ticket.business_id);
  const partner = partners.find(p => p.id === ticket.assigned_partner_organization_id);

  return (
    <div className="space-y-4">
      {/* Back + Status Bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={() => navigate('/tickets')} className="p-1 rounded hover:bg-accent transition-colors">
          <ArrowLeft className="w-4 h-4 text-muted-foreground" />
        </button>
        <span className="text-xs font-mono text-muted-foreground">#{id?.slice(-6)}</span>
        {['admin', 'operator', 'partner_admin'].includes(currentUser?.role) && (
          <StatusTransitionBar currentStatus={ticket.status} disabled={saving || ticket.retention_state === 'anonymized'}
            onTransition={status => mutateTicket('change_ticket_status', { p_ticket_id: ticket.id, p_status: status, p_expected_version: ticket.version })} />
        )}
      </div>
      {notice && <div role="status" className="text-sm text-muted-foreground">{notice}</div>}

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

          </div>

          {/* 티켓 정보 */}
          <div className="rounded-lg border border-border bg-card p-4 space-y-3">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">티켓 정보</h4>

            <MetaRow icon={Building2} label="비즈니스" value={business?.name || '–'} />
            <MetaRow icon={User} label="고객명" value={ticket.customer_name || '–'} />
            <MetaRow icon={Store} label="상호" value={ticket.customer_company || '–'} />
            <MetaRow icon={Tag} label="연락처" value={ticket.customer_contact || '–'} />
            <MetaRow icon={Building2} label="파트너" value={partner?.name || '–'} />
            <MetaRow icon={UserCheck} label="담당자" value={ticket.operator_name_snapshot || '미배정'} />
            <MetaRow icon={Calendar} label="생성일" value={format(new Date(ticket.created_at), 'yyyy/MM/dd HH:mm')} />
            {ticket.resolved_at && (
              <MetaRow icon={Clock} label="완료일" value={format(new Date(ticket.resolved_at), 'yyyy/MM/dd HH:mm')} />
            )}

            {/* 담당자 배정 토글 - admin/operator only */}
            {isOperator && (
              <div className="pt-2 border-t border-border">
                <label className="flex items-center justify-between cursor-pointer">
                  <span className="text-xs font-medium text-muted-foreground">나에게 배정 (준비 중)</span>
                  <Switch
                    checked={ticket.operator_profile_id === currentUser.id}
                    disabled
                  />
                </label>
              </div>
            )}

            {/* Partner assignment - admin/operator only */}
            {isOperator && (
              <div className="pt-2 border-t border-border">
                <label className="text-xs font-medium text-muted-foreground block mb-1.5">파트너 배정</label>
                <select
                  value={ticket.assigned_partner_organization_id || ''}
                  disabled={saving || ticket.retention_state === 'anonymized'}
                  onChange={event => mutateTicket('change_ticket_assignment', {
                    p_ticket_id: ticket.id, p_assigned_partner_organization_id: event.target.value || null, p_expected_version: ticket.version,
                  })}
                  className="w-full h-7 px-2.5 text-xs bg-accent border border-border rounded-md text-foreground focus:outline-none focus:ring-1 focus:ring-ring appearance-none cursor-pointer"
                >
                  <option value="">파트너 미배정</option>
                  {ticket.assigned_partner_organization_id && !partner && (
                    <option value={ticket.assigned_partner_organization_id}>조회 가능한 파트너 정보 없음</option>
                  )}
                  {partners.map(p => <option disabled={!p.selectable} key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            )}
          </div>

          {/* 현장 지원 출동 주소 */}
          <TicketAddressCard
            ticket={ticket}
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
            <SlaBar createdAt={ticket.created_at} slaHours={24} />
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
                        {format(new Date(act.created_at), 'MM/dd HH:mm')}
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
                            {format(new Date(act.created_at), 'MM/dd HH:mm')}
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
                key={ticket.id}
                activities={activities.filter(a => a.type === 'comment' || a.type === 'note')}
                userRole={currentUser?.role}
                disabled={saving || ticket.retention_state === 'anonymized'}
                onSubmit={(type, content) => mutateTicket('add_ticket_activity', { p_ticket_id: ticket.id, p_type: type, p_content: content })}
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
