// 승인된 등급만 티켓/마스터 데이터 접근 허용 (Guest 및 미승인 역할 차단)
export const ALLOWED_ROLES = ['admin', 'operator', 'partner_admin'];

export function isAllowedRole(role?: string): boolean {
  return ALLOWED_ROLES.includes(role);
}