import { supabase } from './supabaseClient';
import { getAppSession } from './appSession';

const MESSAGES = {
  mfa_required: '이메일 추가 인증이 필요합니다.',
  email_otp_not_configured: '이메일 인증 발송 설정이 준비되지 않았습니다. 관리자에게 문의해 주세요.',
  password_login_required: '이메일과 비밀번호로 다시 로그인해 주세요.',
  email_delivery_failed: '인증번호를 발송하지 못했습니다. 1분 후 다시 요청해 주세요.',
  mfa_rate_limited: '발송 횟수가 제한되었습니다. 1분 이후 다시 시도해 주세요. 15분에 최대 5회 요청할 수 있습니다.',
  mfa_locked: '인증 시도 5회로 5분간 잠겼습니다. 잠금 해제 후 인증번호를 다시 요청해 주세요.',
  code_invalid: '인증번호가 일치하지 않거나 확인할 수 없습니다.',
  challenge_invalid: '인증 요청이 유효하지 않습니다. 인증번호를 다시 요청해 주세요.',
  challenge_expired: '인증번호가 만료되었습니다. 다시 요청해 주세요.',
  challenge_consumed: '이미 사용한 인증번호입니다. 다시 로그인해 주세요.',
  origin_not_allowed: 'app-auth의 허용 Origin에 현재 앱 주소가 등록되지 않았습니다.',
  profile_not_found: '계정 등록 또는 승인 준비가 완료되지 않았습니다. 관리자에게 문의해 주세요.',
  account_disabled: '비활성화된 계정입니다. 관리자에게 문의해 주세요.',
  account_suspended: '이용이 정지된 계정입니다. 관리자에게 정지 해제를 요청해 주세요.',
  account_unavailable: '사용할 수 없는 계정입니다.',
  email_not_verified: 'Supabase 계정의 이메일 인증이 필요합니다.',
  email_identity_mismatch: 'Auth 이메일과 Profile 이메일이 일치하지 않습니다.',
  ip_enforcement_not_configured: '활성 IP 제한 때문에 app-auth가 접근을 거절했습니다.',
  session_revoked: '앱 세션이 해제되었습니다. 다시 로그인해 주세요.',
  idle_expired: '15분 유휴 시간이 만료되었습니다. 다시 로그인해 주세요.',
  absolute_expired: '앱 세션의 유효시간이 만료되었습니다. 다시 로그인해 주세요.',
};

// Only in-flight identical validations are shared. No successful validation,
// JWT identity, profile or policy is cached across requests/users/sessions.
const validations=new Map();
export async function invokeAppAuth(action, fields = {}) {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session) throw new Error('Supabase 로그인이 필요합니다.');
  const headers = { Authorization: 'Bearer ' + session.access_token };
  if (action === 'validate-session' || action === 'logout') {
    const appSession = getAppSession();
    if (!appSession || appSession.authUserId !== session.user.id) throw new Error('앱 세션이 없습니다. 다시 로그인해 주세요.');
    headers['X-PartnerDesk-Session'] = appSession.token;
  }
  const execute=async()=>{
  const result = await supabase.functions.invoke('app-auth', { body: { action, ...fields }, headers });
  let body = result.data;
  if (result.error?.context instanceof Response) {
    try { body = await result.error.context.clone().json(); } catch { /* generic transport error below */ }
  }
  if (result.error || body?.success !== true) {
    const reason = body?.reason;
    const ipDenied = result.error?.context instanceof Response
      && result.error.context.status === 403 && body?.message === 'ip_not_allowed';
    const failure = new Error(ipDenied
      ? '현재 접속 중인 네트워크는 PartnerDesk의 허용된 IP 목록에 등록되어 있지 않습니다. 회사에서 승인된 네트워크로 연결한 후 다시 로그인해 주세요. 문제가 지속되면 시스템 관리자에게 문의해 주세요.'
      : MESSAGES[reason] || 'app-auth 호출에 실패했습니다. Edge Function 배포 및 연결 설정을 확인해 주세요.');
    if (ipDenied) failure.title = '접근이 제한된 네트워크입니다.';
    failure.reason = reason;
    throw failure;
  }
  return body;
  };
  if(action!=='validate-session')return execute();
  const key=session.access_token+'\0'+headers['X-PartnerDesk-Session']+'\0'+JSON.stringify(fields);
  if(validations.has(key))return validations.get(key);
  const pending=execute().finally(()=>validations.delete(key));
  validations.set(key,pending);return pending;
}
