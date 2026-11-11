// 비밀번호 생성 규칙: 8자 이상 + 영문 대문자/소문자/숫자/특수문자 각 1개 이상
export const PASSWORD_RULE_TEXT =
  '비밀번호는 8자 이상이며, 영문 대문자·소문자·숫자·특수문자를 각각 1개 이상 포함해야 합니다. 공백·한글은 사용할 수 없습니다.';

// Same symbols as Supabase Auth's lower_upper_letters_digits_symbols policy.
export const PASSWORD_SYMBOLS = '!@#$%^&*()_+-=[]{};\'\\:"|<>?,./`~';

export function validatePassword(pw) {
  const password = typeof pw === 'string' ? pw : '';
  const missing = [];
  if (/[\s\p{White_Space}\p{Script=Hangul}]/u.test(password)) missing.push('공백·한글 사용 금지');
  if (new TextEncoder().encode(password).length > 72) missing.push('최대 72바이트');
  if (Array.from(password).length < 8) missing.push('8자 이상');
  if (!/[A-Z]/.test(password)) missing.push('영문 대문자');
  if (!/[a-z]/.test(password)) missing.push('영문 소문자');
  if (!/[0-9]/.test(password)) missing.push('숫자');
  if (!Array.from(password).some(character => PASSWORD_SYMBOLS.includes(character))) missing.push('특수문자');
  return { valid: missing.length === 0, missing };
}
