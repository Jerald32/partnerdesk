import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { requireVerifiedEmail } from '../../shared/verifyUser.ts';
import { requireValidSession, readSessionId } from '../../shared/sessionGuard.ts';

// 비밀번호 변경 주기(분기 1회) 안내용 서버 처리
// - request_reset: 재설정 메일 요청 일시 기록 → 요청 후 첫 로그인 시 변경 완료로 반영(mfaVerifyCode)
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // 이메일 인증 미완료 사용자 차단
    const denied = requireVerifiedEmail(user);
    if (denied) return denied;

    // 세션 무효화(로그아웃)·재인증 만료(8시간)·중복 로그인 확인
    const sessionDenied = await requireValidSession(base44, user, await readSessionId(req));
    if (sessionDenied) return sessionDenied;

    const body = await req.json().catch(() => ({}));
    if (body?.action !== 'request_reset') {
      return Response.json({ error: 'Invalid action' }, { status: 400 });
    }

    await base44.asServiceRole.entities.User.update(user.id, {
      password_reset_requested_at: new Date().toISOString(),
    });

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}