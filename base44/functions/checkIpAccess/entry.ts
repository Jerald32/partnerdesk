import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { requireVerifiedEmail } from '../../shared/verifyUser.ts';
import { requireValidSession, readSessionId } from '../../shared/sessionGuard.ts';
import { evaluateIpAccess } from '../../shared/ipUtils.ts';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // 이메일 인증 미완료 사용자 차단
    const denied = requireVerifiedEmail(user);
    if (denied) return denied;

    // 세션 무효화(로그아웃)·재인증 만료(8시간) 확인 — 토큰 재사용 차단
    const sessionDenied = await requireValidSession(base44, user, await readSessionId(req));
    if (sessionDenied) return sessionDenied;

    // 화이트리스트 판정 (관리자를 포함한 모든 사용자에게 동일 적용)
    const result = await evaluateIpAccess(base44, req);
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}