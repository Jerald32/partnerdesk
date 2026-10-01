import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { requireVerifiedEmail } from '../../shared/verifyUser.ts';
import { evaluateIpAccess, ipDeniedResponse } from '../../shared/ipUtils.ts';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // 이메일 인증 미완료 사용자 차단
    const denied = requireVerifiedEmail(user);
    if (denied) return denied;

    // 미등록 IP에서는 인증번호 발송 자체를 차단 (인증 시도 차단)
    const ipAccess = await evaluateIpAccess(base44, req);
    if (!ipAccess.allowed) return ipDeniedResponse(ipAccess);

    // 잠금 상태에서는 인증번호 발송도 차단 (재발송으로 잠금 우회 방지)
    if (user.mfa_locked_until && new Date(user.mfa_locked_until) > new Date()) {
      const remainMin = Math.ceil((new Date(user.mfa_locked_until) - new Date()) / 60000);
      return Response.json(
        { error: `인증번호 5회 실패로 계정이 잠금되었습니다. (약 ${remainMin}분 후 해제) 관리자에게 문의해 주세요.` },
        { status: 423 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const force = body?.force === true;

    // 중복 발송 방지: 1분 이내 발송된 미사용 토큰이 있으면 자동 발송 생략 (재발송 버튼 force 제외)
    if (!force) {
      const recent = await base44.asServiceRole.entities.MfaToken.filter(
        { user_id: user.id, consumed: false },
        '-created_date',
        1
      );
      if (recent.length > 0 && new Date(recent[0].created_date) > new Date(Date.now() - 60 * 1000)) {
        return Response.json({
          success: true,
          skipped: true,
          message: '최근 발송된 인증번호가 있습니다. 이메일을 확인해 주세요.',
        });
      }
    }

    // 6자리 인증번호 생성
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    // 기존 미사용 토큰 삭제 후 새 토큰 생성
    await base44.asServiceRole.entities.MfaToken.deleteMany({ user_id: user.id, consumed: false });
    await base44.asServiceRole.entities.MfaToken.create({
      user_id: user.id,
      user_email: user.email,
      code,
      expires_at: expiresAt,
      consumed: false,
    });

    // 이메일 발송 (등록된 사용자만 수신 가능)
    await base44.integrations.Core.SendEmail({
      to: user.email,
      subject: '[PartnerDesk] 로그인 인증번호',
      body: [
        'PartnerDesk 로그인 인증번호입니다.',
        '',
        '인증번호: ' + code,
        '',
        '유효시간: 5분',
        '',
        '본인이 요청하지 않은 경우 즉시 비밀번호를 변경해 주세요.',
      ].join('\n'),
    });

    return Response.json({ success: true, message: '인증번호가 이메일로 발송되었습니다.' });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}