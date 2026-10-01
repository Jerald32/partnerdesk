import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireVerifiedEmail } from '../../shared/verifyUser.ts';
import { evaluateIpAccess, ipDeniedResponse } from '../../shared/ipUtils.ts';
import { markSessionAuthenticated, deviceLabelFromRequest } from '../../shared/sessionGuard.ts';
import { recordAccessLog } from '../../shared/accessLog.ts';

// MFA 비활성화 상태에서 로그인 완료 시점을 인증 시각으로 기록하는 경로
// (MFA 활성화 시 이 경로는 사용 불가 — 반드시 mfaVerifyCode로 인증해야 세션이 활성화됨)
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // 이메일 인증 미완료 사용자 차단
    const denied = requireVerifiedEmail(user);
    if (denied) return denied;

    if (user.account_status === 'suspended') {
      return Response.json({ error: '계정이 차단되었습니다. 관리자에게 문의해 주세요.' }, { status: 403 });
    }

    // 미등록 IP에서는 인증(세션 발급)을 허용하지 않음
    const ipAccess = await evaluateIpAccess(base44, req);
    if (!ipAccess.allowed) return ipDeniedResponse(ipAccess);

    // MFA 활성화 시 사용 불가 — 이메일 인증번호 인증(mfaVerifyCode)으로만 세션 활성화 가능
    const settings = await base44.asServiceRole.entities.SystemSetting.filter({ key: 'mfa_enabled' });
    const mfaDisabled = settings.length > 0 && settings[0].value === 'false';
    if (!mfaDisabled) {
      return Response.json(
        { error: 'MFA가 활성화되어 있습니다. 이메일 인증번호로 인증해 주세요.' },
        { status: 403 }
      );
    }

    // 새 세션 식별자 발급 — 다른 기기의 기존 세션은 자동 무효화된다(동시접속 차단)
    const sessionId = await markSessionAuthenticated(base44, user.id, deviceLabelFromRequest(req));

    // 접속기록: 로그인(세션 활성화)
    await recordAccessLog(base44, {
      user,
      ip: ipAccess.ip,
      action: '로그인',
      targetType: '인증',
      subjectInfo: '본인 계정 인증 (개인정보 처리 없음)',
      detail: `기기: ${deviceLabelFromRequest(req)}`,
    });

    return Response.json({ success: true, session_id: sessionId });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}