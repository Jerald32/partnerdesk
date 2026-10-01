import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { requireVerifiedEmail } from '../../shared/verifyUser.ts';
import { requireValidSession, readSessionId } from '../../shared/sessionGuard.ts';
import { getClientIp } from '../../shared/ipUtils.ts';
import { isAllowedRole } from '../../shared/allowedRoles.ts';
import { recordAccessLog } from '../../shared/accessLog.ts';

// 개인정보 처리 화면 접속 시 접속기록을 남기는 엔드포인트
// 접속자 식별자·IP는 서버에서 확인한 값으로만 기록한다 (위조 방지)
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const denied = requireVerifiedEmail(user);
    if (denied) return denied;

    const sessionDenied = await requireValidSession(base44, user, await readSessionId(req));
    if (sessionDenied) return sessionDenied;

    if (!isAllowedRole(user.role)) {
      return Response.json({ error: '권한이 없습니다.' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    await recordAccessLog(base44, {
      user,
      ip: getClientIp(req),
      action: body?.action || '조회',
      targetType: body?.target_type,
      targetId: body?.target_id,
      subjectInfo: body?.subject_info,
      detail: body?.detail,
    });

    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}