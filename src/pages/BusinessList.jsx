import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { Plus, Building2, Users, ChevronRight } from 'lucide-react';
import CreateBusinessModal from '@/components/businesses/CreateBusinessModal';

export default function BusinessList() {
  const navigate = useNavigate();
  const [businesses, setBusinesses] = useState([]);
  const [servicePartners, setServicePartners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const load = async () => {
    const [b, sp] = await Promise.all([
      base44.entities.Business.list('-created_date'),
      base44.entities.ServicePartner.list(),
    ]);
    setBusinesses(b); setServicePartners(sp);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const getPartnerCount = (businessId) => servicePartners.filter(sp => sp.business_id === businessId).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">비즈니스 관리</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{businesses.length}개 비즈니스</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 h-8 px-3 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> 비즈니스 추가
        </button>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array(6).fill(0).map((_, i) => (
            <div key={i} className="rounded-lg border border-border bg-card p-4 h-28 animate-pulse">
              <div className="h-4 bg-accent rounded w-2/3 mb-2" />
              <div className="h-3 bg-accent rounded w-full mb-1" />
              <div className="h-3 bg-accent rounded w-1/2" />
            </div>
          ))}
        </div>
      ) : businesses.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <Building2 className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">비즈니스가 없습니다</p>
          <button onClick={() => setShowCreate(true)} className="mt-3 text-xs text-primary hover:underline">
            첫 비즈니스 추가하기
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {businesses.map(business => (
            <div
              key={business.id}
              onClick={() => navigate(`/businesses/${business.id}`)}
              className="rounded-lg border border-border bg-card p-4 cursor-pointer hover:border-primary/40 hover:bg-accent transition-all group"
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-md bg-primary/20 flex items-center justify-center">
                    <Building2 className="w-3.5 h-3.5 text-primary" />
                  </div>
                  <h3 className="text-sm font-semibold text-foreground">{business.name}</h3>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
              <p className="text-xs text-muted-foreground line-clamp-2 mb-3">
                {business.description || '설명 없음'}
              </p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Users className="w-3.5 h-3.5" />
                <span>파트너 {getPartnerCount(business.id)}개</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateBusinessModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}
    </div>
  );
}