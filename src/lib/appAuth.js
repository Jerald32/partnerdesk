import { supabase } from './supabaseClient';
import { getAppSession } from './appSession';

const MESSAGES = {
  mfa_required: '이메일 추가 인증이 필요합니다. 현재 단계에서는 MFA 화면이 연결되지 않아 로그인할 수 없습니다.',
  origin_not_allowed: 'app-auth의 허용 Origin에 현재 앱 주소가 등록되지 않았습니다.',
  profile_not_found: 'Supabase 계정에 연결된 Profile이 없습니다.',
  account_unavailable: '사용할 수 없는 계정입니다.',
  email_not_verified: 'Supabase 계정의 이메일 인증이 필요합니다.',
  email_identity_mismatch: 'Auth 이메일과 Profile 이메일이 일치하지 않습니다.',
  ip_enforcement_not_configured: '활성 IP 제한 때문에 app-auth가 접근을 거절했습니다.',
  session_revoked: '앱 세션이 해제되었습니다. 다시 로그인해 주세요.',
  idle_expired: '15분 유휴 시간이 만료되었습니다. 다시 로그인해 주세요.',
  absolute_expired: '앱 세션의 유효시간이 만료되었습니다. 다시 로그인해 주세요.',
};

export async function invokeAppAuth(action, fields = {}) {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session) throw new Error('Supabase 로그인이 필요합니다.');
  const headers = { Authorization: 'Bearer ' + session.access_token };
  if (action === 'validate-session' || action === 'logout') {
    const appSession = getAppSession();
    if (!appSession || appSession.authUserId !== session.user.id) throw new Error('앱 세션이 없습니다. 다시 로그인해 주세요.');
    headers['X-PartnerDesk-Session'] = appSession.token;
  }
  const result = await supabase.functions.invoke('app-auth', { body: { action, ...fields }, headers });
  let body = result.data;
  if (result.error?.context instanceof Response) {
    try { body = await result.error.context.clone().json(); } catch { /* generic transport error below */ }
  }
  if (result.error || body?.success !== true) {
    const reason = body?.reason;
    const failure = new Error(MESSAGES[reason] || 'app-auth 호출에 실패했습니다. Edge Function 배포 및 연결 설정을 확인해 주세요.');
    failure.reason = reason;
    throw failure;
  }
  return body;
}
