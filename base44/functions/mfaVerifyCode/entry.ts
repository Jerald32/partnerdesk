import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { requireVerifiedEmail } from '../../shared/verifyUser.ts';
import { evaluateIpAccess, ipDeniedResponse } from '../../shared/ipUtils.ts';
import { markSessionAuthenticated, deviceLabelFromRequest } from '../../shared/sessionGuard.ts';
import { recordAccessLog } from '../../shared/accessLog.ts';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // 이메일 인증 미완료 사용자 차단
    const denied = requireVerifiedEmail(user);
    if (denied) return denied;

    // 차단된 계정 접근 거부
    if (user.account_status === 'suspended') {
      return Response.json({ error: '계정이 차단되었습니다. 관리자에게 문의해 주세요.' }, { status: 403 });
    }

    // 미등록 IP에서는 인증(세션 발급)을 허용하지 않음
    const ipAccess = await evaluateIpAccess(base44, req);
    if (!ipAccess.allowed) return ipDeniedResponse(ipAccess);

    // MFA 잠금 확인: 인증번호 5회 실패 시 5분간 잠금
    if (user.mfa_locked_until && new Date(user.mfa_locked_until) > new Date()) {
      const remainMin = Math.ceil((new Date(user.mfa_locked_until) - new Date()) / 60000);
      return Response.json(
        { error: `인증번호 5회 실패로 계정이 잠금되었습니다. (약 ${remainMin}분 후 해제) 급하시면 관리자에게 문의해 주세요.` },
        { status: 423 }
      );
    }

    const body = await req.json();
    const code = body?.code;

    if (!code || String(code).length !== 6) {
      return Response.json({ error: '6자리 인증번호를 입력해주세요.' }, { status: 400 });
    }

    // 최근 미사용 토큰 조회
    const tokens = await base44.asServiceRole.entities.MfaToken.filter(
      { user_id: user.id, consumed: false },
      '-created_date',
      1
    );

    if (!tokens || tokens.length === 0) {
      return Response.json({ error: '인증번호를 먼저 발송해주세요.' }, { status: 400 });
    }

    const token = tokens[0];

    // 만료 확인
    if (new Date(token.expires_at) < new Date()) {
      return Response.json({ error: '인증번호가 만료되었습니다. 재발송해주세요.' }, { status: 400 });
    }

    // 코드 일치 확인 — 실패 시 서버에서 카운트, 5회 누적되면 5분 잠금
    if (token.code !== String(code)) {
      const failCount = (user.mfa_fail_count || 0) + 1;
      if (failCount >= 5) {
        await base44.asServiceRole.entities.User.update(user.id, {
          mfa_fail_count: 0,
          mfa_locked_until: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        });
        return Response.json(
          { error: '인증번호 5회 실패로 5분간 잠금 처리되었습니다. 관리자에게 문의해 주세요.' },
          { status: 423 }
        );
      }
      await base44.asServiceRole.entities.User.update(user.id, { mfa_fail_count: failCount });
      return Response.json(
        { error: `인증번호가 일치하지 않습니다. (${failCount}/5 — 5회 실패 시 5분간 잠금됩니다.)` },
        { status: 400 }
      );
    }

    // 사용 완료 처리
    await base44.asServiceRole.entities.MfaToken.update(token.id, { consumed: true });

    // 로그인 일시 및 계정 상태 갱신 (성공 시 실패 카운트 초기화)
    const updateData = { last_login_date: new Date().toISOString() };
    if (user.mfa_fail_count) updateData.mfa_fail_count = 0;
    if (user.account_status === 'inactive_warning') {
      updateData.account_status = 'active';
    }

    // 비밀번호 변경 주기: 재설정 메일 요청 후 첫 로그인 시 '변경 완료'로 기록 (분기 1회 안내 기준 갱신)
    const requestedAt = user.password_reset_requested_at ? new Date(user.password_reset_requested_at).getTime() : 0;
    const changedAt = user.password_changed_at ? new Date(user.password_changed_at).getTime() : 0;
    if (requestedAt && requestedAt > changedAt) {
      updateData.password_changed_at = new Date().toISOString();
      updateData.password_reset_requested_at = null;
    }
    await base44.asServiceRole.entities.User.update(user.id, updateData);

    // 인증 완료: 세션 활성화 — 새 세션 식별자를 발급하므로 다른 기기의 기존 세션은 자동 무효화된다(동시접속 차단)
    const sessionId = await markSessionAuthenticated(base44, user.id, deviceLabelFromRequest(req));

    // 접속기록: 로그인(인증 완료)
    await recordAccessLog(base44, {
      user,
      ip: ipAccess.ip,
      action: '로그인',
      targetType: '인증',
      subjectInfo: '본인 계정 인증 (개인정보 처리 없음)',
      detail: `기기: ${deviceLabelFromRequest(req)}`,
    });

    return Response.json({ success: true, message: '인증이 완료되었습니다.', session_id: sessionId });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}