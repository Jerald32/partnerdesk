// 소속사 등급 (org_type)
export const OPERATOR_COMPANY = 'operator_company';
export const PARTNER_ORG_TYPES = ['partner'];
export const ORG_TYPE_LABELS = {
  operator_company: '운영사',
  partner: '파트너',
};
export const isPartnerOrgType = (orgType) => PARTNER_ORG_TYPES.includes(orgType);

// 접근 허용 역할 — 이 목록에 없으면 게스트로 취급하여 내 계정(/my) 외 접근 제한
export const ALLOWED_ROLES = ['admin', 'operator', 'partner_admin'];
export const isGuest = (role) => !ALLOWED_ROLES.includes(role);

/**
 * 파트너사 소속 사용자 여부.
 * 데이터 격리는 role이 아닌 org_type(소속사 등급)으로 판정한다.
 * 비즈니스별 business/service 접근 범위는 ServicePartner.access_level에서 별도 관리된다.
 */
export const isPartnerUser = (user) => {
  if (!user) return false;
  return PARTNER_ORG_TYPES.includes(user.org_type);
};

// 레거시 호환 alias
export const isPartnerRole = (user) => isPartnerUser(user);