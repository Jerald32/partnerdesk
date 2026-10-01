// 비밀번호 생성 규칙: 8자 이상 + 영문 대문자/소문자/숫자/특수문자 각 1개 이상
export const PASSWORD_RULE_TEXT =
  '비밀번호는 8자 이상이며, 영문 대문자·소문자·숫자·특수문자를 각각 1개 이상 포함해야 합니다.';

export function validatePassword(pw) {
  const missing = [];
  if (!pw || pw.length < 8) missing.push('8자 이상');
  if (!/[A-Z]/.test(pw || '')) missing.push('영문 대문자');
  if (!/[a-z]/.test(pw || '')) missing.push('영문 소문자');
  if (!/[0-9]/.test(pw || '')) missing.push('숫자');
  if (!/[^A-Za-z0-9]/.test(pw || '')) missing.push('특수문자');
  return { valid: missing.length === 0, missing };
}