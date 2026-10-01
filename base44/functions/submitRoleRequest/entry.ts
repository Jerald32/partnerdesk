import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { requireVerifiedEmail } from '../../shared/verifyUser.ts';
import { requireValidSession, readSessionId } from '../../shared/sessionGuard.ts';

const ALLOWED_ROLES = ['operator', 'partner_admin'];
const ALLOWED_ORG_TYPES = ['operator_company', 'partner'];

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

    const body = await req.json().catch(() => ({}));
    const { requested_role, requested_org_type, justification, company } = body;

    // 클라이언트 제공값은 화이트리스트로 검증 — 허용되지 않은 등급/소속 등급은 거부
    if (!requested_role || !ALLOWED_ROLES.includes(requested_role)) {
      return Response.json({ error: 'Invalid requested_role' }, { status: 400 });
    }
    if (!requested_org_type || !ALLOWED_ORG_TYPES.includes(requested_org_type)) {
      return Response.json({ error: 'Invalid requested_org_type' }, { status: 400 });
    }
    if (!justification || typeof justification !== 'string' || !justification.trim()) {
      return Response.json({ error: 'Missing justification' }, { status: 400 });
    }

    // 중복 요청 방지: 대기 중 요청이 있으면 거부
    const existing = await base44.entities.RoleRequest.filter({ user_id: user.id, status: 'pending' }, '-created_date', 1);
    if (existing.length > 0) {
      return Response.json({ error: '이미 대기 중인 변경 요청이 있습니다.' }, { status: 409 });
    }

    // 신원/현재 등급/현재 소속/동의 시각은 서버(auth.me)에서 확정 — 클라이언트 위조 불가
    const created = await base44.entities.RoleRequest.create({
      user_id: user.id,
      user_name: user.display_name || user.full_name || '',
      user_email: user.email,
      current_role: user.role || 'guest',
      current_org_type: user.org_type || '',
      current_affiliation: user.affiliation || '',
      requested_role,
      requested_org_type,
      justification: justification.trim().slice(0, 2000),
      company: company || '',
      status: 'pending',
      consent_agreed: true,
      consent_agreed_at: new Date().toISOString(),
    });

    return Response.json({ request: created });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}