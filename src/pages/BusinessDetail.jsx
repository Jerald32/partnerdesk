import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { ArrowLeft, Plus, Trash2, Handshake, Clock, Crown, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';

const ACCESS_LEVEL_LABELS = {
  business: { label: '비즈니스파트너', icon: Crown, color: 'bg-primary/20 text-primary border-primary/30' },
  service: { label: '서비스파트너', icon: Wrench, color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
};

export default function BusinessDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [business, setBusiness] = useState(null);
  const [servicePartners, setServicePartners] = useState([]);
  const [allPartners, setAllPartners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addingPartner, setAddingPartner] = useState(false);
  const [newPartnerForm, setNewPartnerForm] = useState({ partner_id: '', access_level: 'service', role: '', sla_response_hours: 4, sla_resolution_hours: 24 });

  const load = async () => {
    const [bizs, sps, parts] = await Promise.all([
      base44.entities.Business.list(),
      base44.entities.ServicePartner.filter({ business_id: id }),
      base44.entities.Partner.list(),
    ]);
    setBusiness(bizs.find(b => b.id === id) || null);
    setServicePartners(sps);
    setAllPartners(parts);
    setLoading(false);
  };

  useEffect(() => { load(); }, [id]);

  const handleAddPartner = async () => {
    if (!newPartnerForm.partner_id) return;
    if (newPartnerForm.access_level === 'business' && hasBusinessPartner) {
      alert('비즈니스파트너는 비즈니스당 1개만 연결할 수 있습니다.');
      return;
    }
    await base44.entities.ServicePartner.create({ ...newPartnerForm, business_id: id });
    setAddingPartner(false);
    setNewPartnerForm({ partner_id: '', access_level: 'service', role: '', sla_response_hours: 4, sla_resolution_hours: 24 });
    load();
  };

  const handleRemovePartner = async (spId) => {
    await base44.entities.ServicePartner.delete(spId);
    load();
  };

  const handleAccessLevelChange = async (spId, newLevel) => {
    if (newLevel === 'business' && servicePartners.some(sp => sp.id !== spId && sp.access_level === 'business')) {
      alert('비즈니스파트너는 비즈니스당 1개만 연결할 수 있습니다.');
      load();
      return;
    }
    await base44.entities.ServicePartner.update(spId, { access_level: newLevel });
    load();
  };

  const assignedPartnerIds = servicePartners.map(sp => sp.partner_id);
  const availablePartners = allPartners.filter(p => !assignedPartnerIds.includes(p.id));
  const hasBusinessPartner = servicePartners.some(sp => sp.access_level === 'business');

  const inputClass = "h-8 px-3 text-xs bg-accent border border-border rounded-md text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring";
  const selectClass = inputClass + " appearance-none cursor-pointer";

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );

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
      </div>

      {/* Connected Partners */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <div className="flex items-center gap-2">
            <Handshake className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">연결된 파트너</h3>
            <span className="text-xs text-muted-foreground">({servicePartners.length})</span>
          </div>
          <button
            onClick={() => setAddingPartner(v => !v)}
            className={cn("flex items-center gap-1 h-7 px-3 text-xs font-medium rounded-md transition-colors", addingPartner ? "bg-accent text-muted-foreground" : "bg-primary text-primary-foreground hover:bg-primary/90")}
          >
            <Plus className="w-3 h-3" /> {addingPartner ? '취소' : '파트너 추가'}
          </button>
        </div>

        {/* Add partner form */}
        {addingPartner && (
          <div className="px-5 py-4 border-b border-border bg-accent/50">
            {availablePartners.length === 0 ? (
              <div className="text-xs text-muted-foreground py-2">
                연결할 파트너가 없습니다. 파트너 관리에서 먼저 파트너를 등록해 주세요.
              </div>
            ) : (
              <div className="flex flex-wrap items-end gap-3">
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
              </div>
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
              const partner = allPartners.find(p => p.id === sp.partner_id);
              const levelConf = ACCESS_LEVEL_LABELS[sp.access_level] || ACCESS_LEVEL_LABELS.service;
              const LevelIcon = levelConf.icon;
              return (
                <div key={sp.id} className="flex items-center gap-4 px-5 py-3.5 hover:bg-accent/50 transition-colors">
                  <div className="w-7 h-7 rounded-full bg-emerald-500/20 flex items-center justify-center text-xs font-semibold text-emerald-400">
                    {partner?.name?.[0]?.toUpperCase() || 'P'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-foreground">{partner?.name || '–'}</span>
                      <span className={cn("inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded border", levelConf.color)}>
                        <LevelIcon className="w-3 h-3" /> {levelConf.label}
                      </span>
                      {sp.role && <span className="text-xs text-muted-foreground px-1.5 py-0.5 bg-accent rounded">{sp.role}</span>}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> 응답 {sp.sla_response_hours}h</span>
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> 해결 {sp.sla_resolution_hours}h</span>
                    </div>
                  </div>
                  <select
                    value={sp.access_level || 'service'}
                    onChange={e => handleAccessLevelChange(sp.id, e.target.value)}
                    className={cn("text-[11px] px-2 py-1 rounded-md border font-medium appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring", levelConf.color)}
                    style={{ background: 'transparent' }}
                    title="권한 등급 변경"
                  >
                    <option value="service">서비스파트너</option>
                    <option value="business" disabled={sp.access_level !== 'business' && hasBusinessPartner}>비즈니스파트너</option>
                  </select>
                  <button
                    onClick={() => handleRemovePartner(sp.id)}
                    className="p-1.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}