// 세션 무효화 · 절대 세션 만료(8시간) · 중복 로그인(동시접속) 검증
// 모든 백엔드 함수가 공유하는 서버 측 검증 모듈
// 세션 상태는 서버 전용 엔티티(UserSession)에만 보관되므로 클라이언트·사용자 레코드 수정으로 우회 불가
export const SESSION_TIMEOUT_HOURS = 8;
const REVOKED_EPOCH = '1970-01-01T00:00:00.000Z';

// 사용자의 세션 레코드 조회 (없으면 null — 레거시 사용자는 다음 인증 시 생성됨)
export async function loadSessionRecord(base44: any, userId: string) {
  const sessions = await base44.asServiceRole.entities.UserSession.filter(
    { user_id: userId },
    '-updated_date',
    1
  );
  return sessions[0] || null;
}

// 기기 세션 식별자 발급
export function generateSessionId() {
  return crypto.randomUUID();
}

// 요청 본문에서 클라이언트 세션 식별자 추출
// (본문을 소비하지 않도록 복제본을 읽으므로 함수 본문 파싱에 영향 없음)
export async function readSessionId(req: any) {
  try {
    const body = await req.clone().json();
    return body?.session_id || null;
  } catch (error) {
    return null;
  }
}

// 인증 요청의 User-Agent를 기기 표시명(브라우저 · OS)으로 요약 — 감사·관리 화면 표시용
export function deviceLabelFromRequest(req: any) {
  const ua = req?.headers?.get?.('user-agent') || '';
  if (!ua) return '알 수 없는 기기';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari'
    : '기타 브라우저';
  const os = /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Linux/.test(ua) ? 'Linux'
    : '기타 OS';
  return `${browser} · ${os}`;
}

// 세션 상태 판정
// revoked=로그아웃으로 무효화, expired=마지막 인증 후 8시간 경과,
// concurrent=다른 기기에서 새로 인증해 세션 식별자가 교체됨(중복 로그인)
export function evaluateSession(session: any, sessionId?: string | null) {
  if (!session) return { revoked: false, expired: false, concurrent: false };
  const revokedAt = session.session_revoked_at ? new Date(session.session_revoked_at).getTime() : null;
  const lastAuth = session.last_auth_at ? new Date(session.last_auth_at).getTime() : null;
  const revoked = !!(revokedAt && (!lastAuth || revokedAt >= lastAuth));
  const expired = !!(lastAuth && Date.now() - lastAuth > SESSION_TIMEOUT_HOURS * 3600 * 1000);
  const concurrent = !!(sessionId && session.session_id && session.session_id !== sessionId);
  return { revoked, expired, concurrent };
}

// 백엔드 함수 공용 가드: 무효화·만료·중복 로그인 세션의 요청을 거부한다 (토큰 재사용 차단)
export async function requireValidSession(base44: any, user: any, sessionId?: string | null) {
  // 정지 계정 차단 (관리자 suspend — 모든 함수에 공통 적용)
  if (user.account_status === 'suspended') {
    return Response.json(
      { error: '계정이 차단되었습니다. 관리자에게 문의해 주세요.', reason: 'suspended' },
      { status: 403 }
    );
  }

  const session = await loadSessionRecord(base44, user.id);
  const { revoked, expired, concurrent } = evaluateSession(session, sessionId);

  // 로그아웃 이후 재인증 없이 이전 토큰으로 접근 차단 (전체 기기 적용)
  if (revoked) {
    return Response.json(
      { error: '로그아웃된 세션입니다. 다시 로그인해 주세요.', reason: 'session_revoked' },
      { status: 401 }
    );
  }

  // 중복 로그인 차단: 다른 기기에서 인증해 세션 식별자가 교체된 기기의 요청 거부
  if (concurrent) {
    return Response.json(
      { error: '다른 기기에서 로그인하여 접속이 종료되었습니다. 다시 로그인해 주세요.', reason: 'concurrent_login' },
      { status: 401 }
    );
  }

  // 절대 세션 만료: 마지막 인증 후 8시간 경과 시 재인증 강제
  if (expired) {
    return Response.json(
      { error: '보안을 위해 주기적 재인증이 필요합니다. 다시 로그인해 주세요.', reason: 'reauth_required' },
      { status: 401 }
    );
  }

  return null;
}

// 인증 완료(MFA 통과) 시 세션 활성화
// 새 세션 식별자를 발급해 기존 값을 교체하므로 이전 기기 세션은 자동으로 무효화된다 (동시접속 차단)
export async function markSessionAuthenticated(base44: any, userId: string, deviceLabel?: string) {
  const nowIso = new Date().toISOString();
  const sessionId = generateSessionId();
  const data: any = {
    last_auth_at: nowIso,
    session_revoked_at: REVOKED_EPOCH,
    session_id: sessionId,
    last_seen_at: nowIso,
  };
  if (deviceLabel) data.device_label = deviceLabel;

  const sessions = await base44.asServiceRole.entities.UserSession.filter(
    { user_id: userId },
    '-updated_date',
    1
  );
  if (sessions.length > 0) {
    await base44.asServiceRole.entities.UserSession.update(sessions[0].id, data);
  } else {
    await base44.asServiceRole.entities.UserSession.create({ user_id: userId, ...data });
  }
  return sessionId;
}