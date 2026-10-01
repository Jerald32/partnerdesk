import { createClient } from '@base44/sdk';
import { appParams } from '@/lib/app-params';
import { getSessionId, notifySessionEnded, markIpDenied } from '@/lib/session';

const { appId, token, functionsVersion, appBaseUrl } = appParams;

//Create a client with authentication required
export const base44 = createClient({
  appId,
  token,
  functionsVersion,
  serverUrl: '',
  requiresAuth: false,
  appBaseUrl
});

// 인증 절차에 사용되는 함수: 인증이 완료되기 전 상태 때문에 세션이 종료된 것처럼 처리되어
// 로그인 화면으로 되돌아가는 반복이 생기지 않도록 강제 로그아웃 대상에서 제외한다.
const AUTH_FLOW_FUNCTIONS = [
  'getMfaSetting',
  'mfaSendCode',
  'mfaVerifyCode',
  'activateSession',
  'getSessionStatus',
  'validatePassword',
];

// 모든 백엔드 함수 호출에 기기 세션 식별자를 자동 첨부 (중복 로그인 차단 검증용)
// 서버는 제시된 식별자가 현재 유효 식별자와 다르면 요청을 거부한다.
const invokeRaw = base44.functions.invoke.bind(base44.functions);

base44.functions.invoke = (name, data) => {
  let payload = data == null ? {} : data;
  if (typeof payload === 'object' && !(payload instanceof FormData)) {
    const sessionId = getSessionId();
    payload = sessionId ? { ...payload, session_id: sessionId } : { ...payload };
  }

  return invokeRaw(name, payload).catch((err) => {
    // 서버가 세션 무효화(로그아웃/중복 로그인/재인증 만료)로 거부한 경우 즉시 로그인 화면으로 유도
    const reason = err?.data?.reason || err?.response?.data?.reason;
    // 미등록 IP 차단: 인증 단계에서 거부된 경우에도 기존과 동일한 접근 차단 안내 화면으로 이동
    if (reason === 'ip_denied') {
      markIpDenied(err?.data?.ip || err?.response?.data?.ip);
      window.location.href = '/ip-denied';
      throw err;
    }
    if (
      (reason === 'concurrent_login' || reason === 'session_revoked' || reason === 'reauth_required') &&
      !AUTH_FLOW_FUNCTIONS.includes(name)
    ) {
      notifySessionEnded(reason);
    }
    throw err;
  });
};