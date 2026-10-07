import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Switch } from '@/components/ui/switch';
import { ShieldCheck, Loader2 } from 'lucide-react';

export default function MfaSettingManager() {
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const settings = await base44.entities.SystemSetting.filter({ key: 'mfa_enabled' });
      setEnabled(!(settings.length > 0 && settings[0].value === 'false'));
    } catch (e) {
      setEnabled(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleToggle = async (checked) => {
    setSaving(true);
    try {
      const settings = await base44.entities.SystemSetting.filter({ key: 'mfa_enabled' });
      const value = checked ? 'true' : 'false';
      if (settings.length > 0) {
        await base44.entities.SystemSetting.update(settings[0].id, { value });
      } else {
        await base44.entities.SystemSetting.create({ key: 'mfa_enabled', value });
      }
      setEnabled(checked);
    } catch (e) {
      // 변경 실패 시 상태 유지
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">이메일 2차 인증(MFA) 전체 적용 여부 설정</p>
      <div className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center">
            <ShieldCheck className="w-4 h-4 text-primary" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">이메일 2차 인증</p>
            <p className="text-xs text-muted-foreground mt-0.5">로그인 시 이메일로 발송된 6자리 인증번호 입력 요구</p>
          </div>
        </div>
        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        ) : (
          <Switch checked={enabled} onCheckedChange={handleToggle} disabled={saving} />
        )}
      </div>
      <p className="text-xs text-muted-foreground">※ 변경 시 다음 로그인 세션부터 적용됩니다.</p>
    </div>
  );
}