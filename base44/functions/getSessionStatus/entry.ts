import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireVerifiedEmail } from '../../shared/verifyUser.ts';
import { loadSessionRecord, evaluateSession, readSessionId } from '../../shared/sessionGuard.ts';

// 세션 상태 조회 — 프런트엔드가 세션 무효화/재인증 만료를 감지해 안내 후 로그인 화면으로 유도하는 데 사용
// (재로그인·MFA 진행 중에도 호출되므로 세션 가드를 적용하지 않으며, 호출자 본인의 상태만 반환함)
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // 이메일 인증 미완료 사용자 차단
    const denied = requireVerifiedEmail(user);
    if (denied) return denied;

    // 정지 계정은 무효화된 것으로 처리
    if (user.account_status === 'suspended') {
      return Response.json({ revoked: true, expired: false });
    }

    // 호출자가 제시한 기기 세션 식별자와 현재 유효 식별자를 비교해 중복 로그인 여부를 함께 반환
    const sessionId = await readSessionId(req);
    const session = await loadSessionRecord(base44, user.id);
    const status = evaluateSession(session, sessionId);

    // 이 기기가 이미 인증(2차 인증)을 마친 상태인지 판정
    // 인증 완료 여부를 서버 기록(마지막 인증 시각 + 기기 세션 식별자 일치)으로 확인하므로
    // 브라우저 임시값이 사라져도 인증 화면으로 되돌아가지 않는다.
    const authenticated = !!(
      session &&
      session.last_auth_at &&
      sessionId &&
      session.session_id === sessionId &&
      !status.revoked &&
      !status.expired &&
      !status.concurrent
    );

    return Response.json({ ...status, authenticated });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}