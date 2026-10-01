// 이메일 인증 미완료 사용자 접근 차단 (보안 감사 보완 통제)
// - 요청 컨텍스트 사용자(app-user 토큰) 기준으로 판단
// - is_verified가 명시적으로 false인 경우에만 차단하여 기존 인증 사용자 잠금 방지
export function requireVerifiedEmail(user) {
  if (user && user.is_verified === false) {
    return Response.json(
      { error: '이메일 인증이 완료되지 않아 접근이 차단되었습니다. 이메일 인증 후 이용해 주세요.' },
      { status: 403 }
    );
  }
  return null;
}