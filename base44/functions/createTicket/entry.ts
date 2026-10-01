import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireVerifiedEmail } from '../../shared/verifyUser.ts';
import { requireValidSession, readSessionId } from '../../shared/sessionGuard.ts';
import { isAllowedRole } from '../../shared/allowedRoles.ts';

const RATE_LIMIT_COUNT = 5;     // 1분간 최대 생성 허용 개수
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

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

    // 역할 검증: 승인된 등급(admin/operator/partner_admin)만 티켓 생성 가능
    if (!isAllowedRole(user.role)) {
      return Response.json({ error: '티켓 생성 권한이 없습니다. 관리자에게 등급 승인을 요청해주세요.' }, { status: 403 });
    }

    const body = await req.json();

    // 필수 필드 검증
    if (!body?.title || !body?.business_id) {
      return Response.json({ error: '제목과 비즈니스는 필수 입력입니다.' }, { status: 400 });
    }

    // 주소(선택 입력): 값이 있을 때만 형식 검증
    const MAX_ADDRESS_LEN = 200;
    for (const field of ['address', 'address_detail']) {
      const v = body[field];
      if (v != null && v !== '' && (typeof v !== 'string' || v.length > MAX_ADDRESS_LEN)) {
        return Response.json({ error: '주소 형식이 올바르지 않습니다. (최대 200자)' }, { status: 400 });
      }
    }

    // 속도 제한: 최근 1분간 해당 사용자가 생성한 티켓 수 확인 (서버 기준 — 클라이언트 우회 불가)
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
    const recentTickets = await base44.asServiceRole.entities.Ticket.filter(
      { created_by_id: user.id, created_date: { $gte: windowStart } },
      '-created_date',
      RATE_LIMIT_COUNT + 1
    );
    if (recentTickets && recentTickets.length >= RATE_LIMIT_COUNT) {
      return Response.json(
        { error: `티켓 생성 요청이 너무 많습니다. 1분에 최대 ${RATE_LIMIT_COUNT}개까지 생성할 수 있습니다. 잠시 후 다시 시도해주세요.` },
        { status: 429 }
      );
    }

    // 사용자 스코프로 생성 (created_by_id 자동 기록)
    const ticket = await base44.entities.Ticket.create(body);
    return Response.json({ success: true, ticket });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}