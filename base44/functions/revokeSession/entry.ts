import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

// 로그아웃 처리: 세션 무효화 시각을 서버 전용 엔티티(UserSession)에 기록한다.
// 이후 해당 계정의 모든 백엔드 함수 요청은 requireValidSession에서 401로 거부된다 (토큰 재사용 차단, 전체 기기 적용).
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const nowIso = new Date().toISOString();
    const sessions = await base44.asServiceRole.entities.UserSession.filter(
      { user_id: user.id },
      '-updated_date',
      1
    );
    if (sessions.length > 0) {
      await base44.asServiceRole.entities.UserSession.update(sessions[0].id, {
        session_revoked_at: nowIso,
      });
    } else {
      await base44.asServiceRole.entities.UserSession.create({
        user_id: user.id,
        session_revoked_at: nowIso,
      });
    }

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}