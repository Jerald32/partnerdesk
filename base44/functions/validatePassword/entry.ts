import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { requireVerifiedEmail } from '../../shared/verifyUser.ts';

export default async function(req) {
  try {
    // 이메일 인증 미완료 사용자 차단 (비로그인 사전 가입 요청은 통과)
    const base44 = createClientFromRequest(req);
    if (await base44.auth.isAuthenticated()) {
      const user = await base44.auth.me();
      const denied = requireVerifiedEmail(user);
      if (denied) return denied;
    }

    const body = await req.json();
    const pw = typeof body?.password === 'string' ? body.password : '';

    // 클라이언트(src/lib/password.js)와 동일한 규칙: 8자 이상 + 영문 대소문자/숫자/특수문자 각 1개 이상
    const missing = [];
    if (pw.length < 8) missing.push('8자 이상');
    if (!/[A-Z]/.test(pw)) missing.push('영문 대문자');
    if (!/[a-z]/.test(pw)) missing.push('영문 소문자');
    if (!/[0-9]/.test(pw)) missing.push('숫자');
    if (!/[^A-Za-z0-9]/.test(pw)) missing.push('특수문자');

    return Response.json({ valid: missing.length === 0, missing });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}