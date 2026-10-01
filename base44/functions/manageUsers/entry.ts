import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { requireVerifiedEmail } from '../../shared/verifyUser.ts';
import { requireValidSession, readSessionId } from '../../shared/sessionGuard.ts';
import { getClientIp } from '../../shared/ipUtils.ts';

/**
 * 권한(등급·소속) 변경 이력 기록
 * - 신청자 정보·신청일시: 등급 요청(RoleRequest) 기반 변경인 경우 해당 레코드에서 서버가 직접 조회
 * - 승인자·실행자 식별정보: 실행 사용자(계정) + 접속 IP + 실행 경로(API)
 * - 접근 권한 정보: 변경 전/후 등급·소속사 등급·소속사
 * - 사유: 신청 사유 + 발급(승인) 사유
 * 실제로 권한이 바뀐 경우에만 기록한다.
 */
async function logRoleChange(admin: any, { actor, req, before, after, requestId, reason }: any) {
  const roleBefore = before?.role || null;
  const roleAfter = after?.role ?? roleBefore;
  const orgBefore = before?.org_type || null;
  const orgAfter = after?.org_type ?? orgBefore;
  const affBefore = before?.affiliation || null;
  const affAfter = after?.affiliation ?? affBefore;

  if (roleBefore === roleAfter && orgBefore === orgAfter && affBefore === affAfter) return;

  let request: any = null;
  if (requestId) {
    const found = await admin.entities.RoleRequest.filter({ id: requestId });
    request = found?.[0] || null;
  }

  await admin.entities.RoleChangeLog.create({
    target_user_id: after?.id || before?.id || '',
    target_name: after?.display_name || after?.full_name || before?.display_name || before?.full_name || '',
    target_email: after?.email || before?.email || '',
    change_type: requestId ? 'request_approved' : 'direct',
    request_id: requestId || '',
    requester_id: request?.user_id || '',
    requester_name: request?.user_name || '',
    requester_email: request?.user_email || '',
    requested_at: request?.created_date || null,
    request_reason: request?.justification || '',
    role_before: roleBefore,
    role_after: roleAfter,
    org_type_before: orgBefore,
    org_type_after: orgAfter,
    affiliation_before: affBefore,
    affiliation_after: affAfter,
    actor_id: actor?.id || '',
    actor_name: actor?.display_name || actor?.full_name || '',
    actor_email: actor?.email || '',
    actor_role: actor?.role || '',
    actor_ip: getClientIp(req),
    source_api: 'manageUsers.update',
    issue_reason: reason || request?.admin_notes || '',
    changed_at: new Date().toISOString(),
  });
}

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

    if (user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const { action } = body;
    const admin = base44.asServiceRole;

    if (action === 'list') {
      const users = await admin.entities.User.list();
      return Response.json({ users });
    }
    if (action === 'update') {
      const { userId, data, requestId, reason } = body;
      if (!userId || !data) return Response.json({ error: 'Missing userId or data' }, { status: 400 });
      const before = (await admin.entities.User.list()).find((u: any) => u.id === userId) || null;
      const updated = await admin.entities.User.update(userId, data);
      await logRoleChange(admin, { actor: user, req, before, after: updated, requestId, reason });
      return Response.json({ user: updated });
    }
    if (action === 'delete') {
      const { userId } = body;
      if (!userId) return Response.json({ error: 'Missing userId' }, { status: 400 });
      await admin.entities.User.delete(userId);
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}