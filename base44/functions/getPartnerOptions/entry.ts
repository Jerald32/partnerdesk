import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireVerifiedEmail } from '../../shared/verifyUser.ts';
import { requireValidSession, readSessionId } from '../../shared/sessionGuard.ts';

// 승격(RoleRequest) 요청 폼용 최소 파트너 정보 제공 — id/이름만 반환 (연락처 등 마스터 데이터 미노출)
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

    const partners = await base44.asServiceRole.entities.Partner.filter({ is_active: true }, 'name', 500);
    return Response.json({ partners: partners.map((p) => ({ id: p.id, name: p.name })) });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}