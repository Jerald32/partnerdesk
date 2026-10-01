import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { requireVerifiedEmail } from '../../shared/verifyUser.ts';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // 이메일 인증 미완료 사용자 차단
    const denied = requireVerifiedEmail(user);
    if (denied) return denied;

    // MFA 활성화 여부 (기본값: 활성화)
    const settings = await base44.asServiceRole.entities.SystemSetting.filter({ key: 'mfa_enabled' });
    const enabled = !(settings.length > 0 && settings[0].value === 'false');

    return Response.json({ enabled, user_id: user.id });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}