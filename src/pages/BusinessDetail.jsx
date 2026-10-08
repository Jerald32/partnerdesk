import { isCompanyMember, isCompanyAdmin } from '@/lib/roles';
import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/lib/AuthContext';
import { invokeAppAuth } from '@/lib/appAuth';
import { ArrowLeft, Plus, Trash2, Handshake, Clock, Crown, Wrench } from 'lucide-react';
import EditBusinessFieldsModal from '@/components/businesses/EditBusinessFieldsModal';
import { cn } from '@/lib/utils';

const ACCESS_LEVEL_LABELS = {
  business: { label: '비즈니스파트너', icon: Crown, color: 'bg-primary/20 text-primary border-primary/30' },
  service: { label: '서비스파트너', icon: Wrench, color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
};

export default function BusinessDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(null);
  const [business, setBusiness] = useState(null);
  const [servicePartners, setServicePartners] = useState([]);
  const [allPartners, setAllPartners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadedId, setLoadedId] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [ticketCount, setTicketCount] = useState(0);
  const [addingPartner, setAddingPartner] = useState(false);
  const [newPartnerForm, setNewPartnerForm] = useState({ partner_id: '', access_level: 'service', role: '', sla_response_hours: 4, sla_resolution_hours: 24 });

  const { user } = useAuth();
  const canManage = isCompanyAdmin(user);
  const canEditBusiness = isCompanyMember(user);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const pending = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    setLoading(true); setError(''); setBusiness(null); setServicePartners([]); setAllPartners([]); setAddingPartner(false); setEditing(null);
    setTickets([]); setTicketCount(0);
    async function readAll(query) {
      const rows = [];
      while (!controller.signal.aborted) {
        const { data, error, count } = await query().range(rows.length, rows.length + 499).abortSignal(controller.signal);
        if (error) throw error;
        if (!data?.length) break;
        rows.push(...data);
        if (count !== null && rows.length >= count) break;
      }
      return rows;
    }
    async function load() {
      try {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '')) throw new Error('invalid_id');
        await invokeAppAuth('validate-session');
        if (controller.signal.aborted) return;
        const { data: row, error } = await supabase.from('businesses').select('id,name,description,is_active,created_at,updated_at')
          .eq('id', id).abortSignal(controller.signal).maybeSingle();
        if (error) throw error;
        if (!row || controller.signal.aborted) return;
        const relations = await readAll(() => supabase.from('service_partners')
          .select('id,partner_organization_id,access_level,role_description,sla_response_hours,sla_resolution_hours,updated_at', { count: 'exact' })
          .eq('business_id', id).order('id'));
        const organizations = [];
        if (canManage) {
          organizations.push(...await readAll(() => supabase.from('organizations')
            .select('id,name,is_active', { count: 'exact' }).eq('type', 'partner').order('name').order('id')));
        } else {
          const ids = [...new Set(relations.map(r => r.partner_organization_id))];
          for (let offset = 0; offset < ids.length; offset += 100) {
            const { data, error } = await supabase.from('organizations').select('id,name,is_active').eq('type', 'partner')
              .in('id', ids.slice(offset, offset + 100)).abortSignal(controller.signal);
            if (error) throw error;
            organizations.push(...data);
          }
        }
        const details = [];
        for (let offset = 0; offset < organizations.length; offset += 100) {
          const { data, error } = await supabase.from('partner_details').select('organization_id,partner_type')
            .in('organization_id', organizations.slice(offset, offset + 100).map(o => o.id)).abortSignal(controller.signal);
          if (error) throw error;
          details.push(...data);
        }
        const { data: ticketRows, error: ticketError, count } = await supabase.from('tickets')
          .select('id,title,status', { count: 'exact' }).eq('business_id', id)
          .order('created_at', { ascending: false }).order('id').range(0, 19).abortSignal(controller.signal);
        if (ticketError) throw ticketError;
        if (controller.signal.aborted) return;
        setBusiness(row); setServicePartners(relations);
        setTickets(ticketRows); setTicketCount(count ?? ticketRows.length);
        setAllPartners(organizations.map(o => ({ ...o, detail: details.find(d => d.organization_id === o.id) })));
      } catch {
        if (!controller.signal.aborted) setError('비즈니스를 불러오지 못했습니다. 로그인 세션과 조회 권한을 확인한 뒤 새로고침해 주세요.');
      } finally { if (!controller.signal.aborted) { setLoadedId(id); setLoading(false); } }
    }
    void load();
    return () => { controller.abort(); if (generation.current === current) ++generation.current; };
  }, [id, user?.id, canManage, refresh]);

  async function mutate(rpc, args) {
    if (pending.current || loading || loadedId !== id || !canManage || !business) return;
    pending.current = true; setSaving(true); setNotice('');
    const current = generation.current;
    try {
      const { data, error } = await supabase.rpc(rpc, args);
      if (error) throw error;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data?.id || '') ||
          (args.p_service_partner_id && data.id !== args.p_service_partner_id) ||
          (rpc === 'change_service_partner_access_level' && data.access_level !== args.p_access_level)) throw new Error('invalid_response');
      if (generation.current !== current) return;
      setNotice('저장되었습니다.'); setAddingPartner(false);
      setNewPartnerForm({ partner_id: '', access_level: 'service', role: '', sla_response_hours: 4, sla_resolution_hours: 24 });
      setRefresh(v => v + 1);
    } catch (failure) {
      if (generation.current !== current) return;
      setNotice(failure.code === '23503' ? '이 파트너에 배정된 Ticket이 남아 있습니다. Ticket의 파트너 배정을 먼저 변경하거나 해제해 주세요.'
        : failure.code === '23505' ? '이미 연결된 파트너입니다. 최신 연결 목록을 확인해 주세요.'
        : !failure.code ? '처리 결과를 확인할 수 없습니다. 자동 재시도하지 않습니다. 최신 연결 목록을 확인해 주세요.'
        : failure.message === 'business_partner_limit' ? '비즈니스파트너는 한 곳만 연결할 수 있습니다.'
        : failure.code === '28000' ? '세션이 만료되었습니다. 다시 로그인해 주세요.'
        : '저장하지 못했습니다. 접근 권한과 입력값을 확인해 주세요.');
      if (!failure.code || failure.code === '23505' || failure.code === 'P0002') setRefresh(v => v + 1);
    } finally { pending.current = false; setSaving(false); }
  }
  const handleAddPartner = () => {
    if (!availablePartners.some(p => p.id === newPartnerForm.partner_id) ||
        (newPartnerForm.access_level === 'business' && hasBusinessPartner) ||
        !Number.isFinite(newPartnerForm.sla_response_hours) || newPartnerForm.sla_response_hours < 0 ||
        !Number.isFinite(newPartnerForm.sla_resolution_hours) || newPartnerForm.sla_resolution_hours < 0) return;
    void mutate('link_service_partner', {
      p_business_id: id, p_partner_organization_id: newPartnerForm.partner_id,
      p_access_level: newPartnerForm.access_level, p_role_description: newPartnerForm.role.trim() || null,
      p_sla_response_hours: newPartnerForm.sla_response_hours, p_sla_resolution_hours: newPartnerForm.sla_resolution_hours,
    });
  };
  const handleRemovePartner = spId => { if (!pending.current && window.confirm('파트너 연결을 해제하시겠습니까? 해당 파트너의 Business 접근권한도 변경됩니다.')) void mutate('unlink_service_partner', { p_service_partner_id: spId }); };
  const handleAccessLevelChange = (spId, level) => {
    if (level === 'business' && servicePartners.some(sp => sp.id !== spId && sp.access_level === 'business')) return;
    void mutate('change_service_partner_access_level', { p_service_partner_id: spId, p_access_level: level });
  };

  const assignedPartnerIds = servicePartners.map(sp => sp.partner_organization_id);
  const availablePartners = allPartners.filter(p => p.is_active && p.detail && !assignedPartnerIds.includes(p.id));
  const hasBusinessPartner = servicePartners.some(sp => sp.access_level === 'business');

  const inputClass = "h-8 px-3 text-xs bg-accent border border-border rounded-md text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring";
  const selectClass = inputClass + " appearance-none cursor-pointer";

  if (loading || loadedId !== id) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (error) return <div role="alert" className="text-center py-16 text-muted-foreground">{notice && <p>{notice}</p>}{error}</div>;

  if (!business) return <div className="text-muted-foreground text-center py-16">비즈니스를 찾을 수 없습니다</div>;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/businesses')} className="p-1 rounded hover:bg-accent transition-colors">
          <ArrowLeft className="w-4 h-4 text-muted-foreground" />
        </button>
        <div>
          <h2 className="text-lg font-semibold text-foreground">{business.name}</h2>
          {business.description && <p className="text-xs text-muted-foreground mt-0.5">{business.description}</p>}
        </div>
        {canEditBusiness && <button disabled={saving} onClick={() => setEditing({ business })} className="text-xs text-primary">Business 수정</button>}
      </div>

      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
      <p className="text-xs text-muted-foreground">{business.is_active ? '활성' : '비활성'}</p>
      {/* Connected Partners */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <div className="flex items-center gap-2">
            <Handshake className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">연결된 파트너</h3>
            <span className="text-xs text-muted-foreground">({servicePartners.length})</span>
          </div>
          {canManage && <button
            disabled={saving}
            onClick={() => setAddingPartner(v => !v)}
            className={cn("flex items-center gap-1 h-7 px-3 text-xs font-medium rounded-md transition-colors", addingPartner ? "bg-accent text-muted-foreground" : "bg-primary text-primary-foreground hover:bg-primary/90")}
          >
            <Plus className="w-3 h-3" /> {addingPartner ? '취소' : '파트너 추가'}
          </button>}
        </div>

        {/* Add partner form */}
        {addingPartner && canManage && (
          <div className="px-5 py-4 border-b border-border bg-accent/50">
            {availablePartners.length === 0 ? (
              <div className="text-xs text-muted-foreground py-2">
                연결할 파트너가 없습니다. 파트너 관리에서 먼저 파트너를 등록해 주세요.
              </div>
            ) : (
              <fieldset disabled={saving} className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">파트너 *</label>
                  <select value={newPartnerForm.partner_id} onChange={e => setNewPartnerForm(f => ({ ...f, partner_id: e.target.value }))} className={selectClass}>
                    <option value="">파트너 선택</option>
                    {availablePartners.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">권한 등급 *</label>
                  <select value={newPartnerForm.access_level} onChange={e => setNewPartnerForm(f => ({ ...f, access_level: e.target.value }))} className={selectClass}>
                    <option value="service">서비스파트너</option>
                    {!hasBusinessPartner && <option value="business">비즈니스파트너</option>}
                  </select>
                  {hasBusinessPartner && <p className="text-[11px] text-muted-foreground mt-1">비즈니스파트너는 1개만 연결 가능</p>}
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">역할</label>
                  <input value={newPartnerForm.role} onChange={e => setNewPartnerForm(f => ({ ...f, role: e.target.value }))} placeholder="예: 주 담당" className={inputClass + " w-28"} />
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">응답 SLA (h)</label>
                  <input type="number" value={newPartnerForm.sla_response_hours} onChange={e => setNewPartnerForm(f => ({ ...f, sla_response_hours: +e.target.value }))} className={inputClass + " w-20"} />
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">해결 SLA (h)</label>
                  <input type="number" value={newPartnerForm.sla_resolution_hours} onChange={e => setNewPartnerForm(f => ({ ...f, sla_resolution_hours: +e.target.value }))} className={inputClass + " w-20"} />
                </div>
                <div className="flex gap-2">
                  <button onClick={handleAddPartner} className="h-8 px-3 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors">추가</button>
                  <button onClick={() => setAddingPartner(false)} className="h-8 px-3 text-xs text-muted-foreground rounded-md hover:bg-accent transition-colors">취소</button>
                </div>
              </fieldset>
            )}
          </div>
        )}

        {servicePartners.length === 0 ? (
          <div className="py-10 text-center text-muted-foreground text-sm">연결된 파트너가 없습니다</div>
        ) : (
          <div className="divide-y divide-border">
            {[...servicePartners]
              .sort((a, b) => (a.access_level === 'business' ? -1 : 1) - (b.access_level === 'business' ? -1 : 1))
              .map(sp => {
              const partner = allPartners.find(p => p.id === sp.partner_organization_id);
              const levelConf = ACCESS_LEVEL_LABELS[sp.access_level] || ACCESS_LEVEL_LABELS.service;
              const LevelIcon = levelConf.icon;
              return (
                <div key={sp.id} className="flex items-center gap-4 px-5 py-3.5 hover:bg-accent/50 transition-colors">
                  <div className="w-7 h-7 rounded-full bg-emerald-500/20 flex items-center justify-center text-xs font-semibold text-emerald-400">
                    {partner?.name?.[0]?.toUpperCase() || 'P'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-foreground">{partner?.name || '조회 가능한 파트너 정보 없음'}</span>
                      {partner?.detail && <span className="text-xs text-muted-foreground">{partner.detail.partner_type}</span>}
                      <span className={cn("inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded border", levelConf.color)}>
                        <LevelIcon className="w-3 h-3" /> {levelConf.label}
                      </span>
                      {sp.role_description && <span className="text-xs text-muted-foreground px-1.5 py-0.5 bg-accent rounded">{sp.role_description}</span>}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> 응답 {sp.sla_response_hours}h</span>
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> 해결 {sp.sla_resolution_hours}h</span>
                    </div>
                  </div>
                  {canManage && <button disabled={saving} onClick={() => setEditing({ relation: sp })} className="text-xs text-primary">역할/SLA 수정</button>}
                  {canManage && <select
                    disabled={saving}
                    value={sp.access_level || 'service'}
                    onChange={e => handleAccessLevelChange(sp.id, e.target.value)}
                    className={cn("text-[11px] px-2 py-1 rounded-md border font-medium appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring", levelConf.color)}
                    style={{ background: 'transparent' }}
                    title="권한 등급 변경"
                  >
                    <option value="service">서비스파트너</option>
                    <option value="business" disabled={sp.access_level !== 'business' && hasBusinessPartner}>비즈니스파트너</option>
                  </select>}
                  {canManage && <button
                    disabled={saving}
                    onClick={() => handleRemovePartner(sp.id)}
                    className="p-1.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {editing && (editing.business ? canEditBusiness : canManage) && <EditBusinessFieldsModal {...editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setRefresh(v => v + 1); }} />}
      <div className="rounded-lg border border-border bg-card">
        <h3 className="px-5 py-3.5 border-b border-border text-sm font-semibold">Ticket ({ticketCount}) · 최근 20건</h3>
        {tickets.length === 0 && <p className="p-5 text-sm text-muted-foreground">조회 가능한 Ticket이 없습니다.</p>}
        {tickets.map(ticket => <button key={ticket.id} onClick={() => navigate(`/tickets/${ticket.id}`)}
          className="flex w-full justify-between gap-3 px-5 py-3 text-left text-sm hover:bg-accent border-b border-border last:border-0">
          <span className="truncate">{ticket.title}</span><span className="text-xs text-muted-foreground">{ticket.status}</span>
        </button>)}
      </div>
    </div>
  );
}
