// 기기(브라우저) 단위 세션 식별자 보관 및 세션 종료(중복 로그인·무효화·재인증 만료) 처리
// localStorage를 사용하므로 같은 브라우저의 여러 탭은 하나의 접속으로 인정된다.
const SESSION_KEY = 'pd_session_id';

export function setSessionId(id) {
  if (id) localStorage.setItem(SESSION_KEY, id);
}

export function getSessionId() {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch (e) {
    return null;
  }
}

export function clearSessionId() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch (e) {
    // 접근 불가 환경에서는 무시
  }
}

// 인증 관련 세션 캐시 정리
export function clearAuthCache() {
  Object.keys(sessionStorage).forEach((key) => {
    if (key.startsWith('mfa_verified_') || key.startsWith('mfa_enabled_') || key.startsWith('ip_allowed_')) {
      sessionStorage.removeItem(key);
    }
  });
  clearIpDenied();
}

// 미등록 IP 차단 상태 — 이메일 인증(2차 인증) 완료 전에도 차단 안내 화면을 표시하기 위해 보관한다.
// (인증 전에는 세션 검증이 적용되는 요청을 보내지 않으므로, 서버가 인증 단계에서 알려준 차단 정보를 여기에 남긴다)
const IP_DENIED_KEY = 'pd_ip_denied';

export function markIpDenied(ip) {
  try {
    sessionStorage.setItem(IP_DENIED_KEY, ip || '');
  } catch (e) {
    // 접근 불가 환경에서는 무시
  }
}

export function clearIpDenied() {
  try {
    sessionStorage.removeItem(IP_DENIED_KEY);
  } catch (e) {
    // 접근 불가 환경에서는 무시
  }
}

// 차단된 경우 차단 당시 IP, 차단된 적이 없으면 null
export function getIpDenied() {
  try {
    return sessionStorage.getItem(IP_DENIED_KEY);
  } catch (e) {
    return null;
  }
}

// 세션 종료 처리 핸들러 — AuthContext가 등록하며, 등록 전에는 즉시 로그인 화면으로 이동한다
let sessionEndedHandler = null;

export function setSessionEndedHandler(fn) {
  sessionEndedHandler = fn;
}

export function notifySessionEnded(reason) {
  if (sessionEndedHandler) sessionEndedHandler(reason);
  else window.location.href = `/login?reason=${reason}`;
}