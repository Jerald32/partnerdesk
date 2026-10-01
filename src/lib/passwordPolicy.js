// 비밀번호 변경 주기: 분기 1회 (90일)
export const PASSWORD_CYCLE_DAYS = 90;
export const PASSWORD_CYCLE_TEXT = `비밀번호는 분기 1회(${PASSWORD_CYCLE_DAYS}일) 주기로 변경하는 것을 권장합니다.`;

/**
 * 로그인한 모든 사용자(관리자·운영자·파트너·일반 사용자)의 비밀번호 변경 주기 경과 여부.
 */
export function getPasswordCycleStatus(user) {
  if (!user) return { due: false };

  const last = user.password_changed_at;
  if (!last) return { due: true, neverChanged: true, lastChanged: null, daysElapsed: null };

  const daysElapsed = Math.floor((Date.now() - new Date(last).getTime()) / 86400000);
  return {
    due: daysElapsed >= PASSWORD_CYCLE_DAYS,
    neverChanged: false,
    lastChanged: last,
    daysElapsed,
  };
}