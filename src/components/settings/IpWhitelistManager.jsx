import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Plus, Trash2, Globe, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Switch } from '@/components/ui/switch';

export default function IpWhitelistManager() {
  const [ips, setIps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newIp, setNewIp] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [restrictionEnabled, setRestrictionEnabled] = useState(true);
  const [settingId, setSettingId] = useState(null);
  const [toggling, setToggling] = useState(false);

  const load = async () => {
    try {
      const [list, settings] = await Promise.all([
        base44.entities.IpWhitelist.filter({ is_active: true }),
        base44.entities.SystemSetting.filter({ key: 'ip_restriction_enabled' }),
      ]);
      setIps(list);
      if (settings.length > 0) {
        setSettingId(settings[0].id);
        setRestrictionEnabled(settings[0].value !== 'false');
      } else {
        setSettingId(null);
        setRestrictionEnabled(true);
      }
    } catch (e) {
      setError('IP 목록 조회 실패');
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleToggleRestriction = async (enabled) => {
    setToggling(true);
    try {
      if (settingId) {
        await base44.entities.SystemSetting.update(settingId, { value: String(enabled) });
      } else {
        const created = await base44.entities.SystemSetting.create({ key: 'ip_restriction_enabled', value: String(enabled) });
        setSettingId(created.id);
      }
      setRestrictionEnabled(enabled);
    } catch (e) {
      setError('설정 변경 실패');
    } finally {
      setToggling(false);
    }
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!newIp) return;
    setAdding(true);
    setError('');
    try {
      await base44.entities.IpWhitelist.create({
        ip_address: newIp.trim(),
        description: newDesc.trim(),
        is_active: true,
      });
      setNewIp('');
      setNewDesc('');
      load();
    } catch (err) {
      setError(err?.message || 'IP 등록 실패');
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('이 IP를 삭제하시겠습니까?')) return;
    try {
      await base44.entities.IpWhitelist.delete(id);
      load();
    } catch (err) {
      setError('삭제 실패');
    }
  };

  return (
    <div className="space-y-4">
      {/* Restriction on/off toggle */}
      <div className="rounded-lg border border-border bg-card p-4 flex items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          {restrictionEnabled ? (
            <ShieldCheck className="w-5 h-5 text-emerald-400 mt-0.5 shrink-0" />
          ) : (
            <ShieldAlert className="w-5 h-5 text-orange-400 mt-0.5 shrink-0" />
          )}
          <div>
            <p className="text-sm font-medium text-foreground">IP 접근 제한 {restrictionEnabled ? '적용중' : '중단됨'}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {restrictionEnabled
                ? '등록된 IP만 접근 가능합니다. 토글을 끄면 모든 IP에서 임시 접근이 가능합니다.'
                : '현재 모든 IP에서 접근 가능합니다. 보안을 위해 사용 후 다시 켜주세요.'}
            </p>
          </div>
        </div>
        <Switch
          checked={restrictionEnabled}
          onCheckedChange={handleToggleRestriction}
          disabled={toggling}
        />
      </div>

      <p className="text-xs text-muted-foreground">
        허용된 IP에서만 시스템 접근이 가능합니다. (관리자 포함 모든 사용자 적용) 등록된 IP가 없으면 모든 IP에서 접근 가능합니다.
      </p>

      {/* Add form */}
      <form onSubmit={handleAdd} className="rounded-lg border border-border bg-card p-4 space-y-3">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">IP 추가</h3>
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-xs text-muted-foreground mb-1">IP 주소</label>
            <input
              type="text" required
              value={newIp}
              onChange={e => setNewIp(e.target.value)}
              placeholder="218.238.50.65"
              className="h-8 w-48 px-3 text-sm bg-accent border border-border rounded-md text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring font-mono"
            />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">설명</label>
            <input
              type="text"
              value={newDesc}
              onChange={e => setNewDesc(e.target.value)}
              placeholder="본사 네트워크"
              className="h-8 w-40 px-3 text-sm bg-accent border border-border rounded-md text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <button
            type="submit" disabled={adding}
            className="flex items-center gap-1.5 h-8 px-4 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" /> 추가
          </button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </form>

      {/* IP list */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              {['IP 주소', '설명', ''].map(col => (
                <th key={col} className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={3} className="py-8 text-center text-muted-foreground text-sm">불러오는 중...</td></tr>
            ) : ips.length === 0 ? (
              <tr>
                <td colSpan={3} className="py-8 text-center text-muted-foreground text-sm">
                  <Globe className="w-6 h-6 mx-auto mb-2 opacity-50" />
                  등록된 IP가 없습니다 (모든 IP 접근 허용)
                </td>
              </tr>
            ) : (
              ips.map(ip => (
                <tr key={ip.id} className="border-b border-border last:border-0 hover:bg-accent/50 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-foreground">{ip.ip_address}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{ip.description || '–'}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleDelete(ip.id)}
                      className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                      title="삭제"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}