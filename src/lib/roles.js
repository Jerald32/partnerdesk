// Presentation only: RLS and RPCs independently enforce authorization.
export const SIGNUP_HOLDING_ORGANIZATION = '10a8e084-c396-4a97-b301-c4ef4aa59d71';
export const OPERATOR_COMPANY = 'operator';
export const PARTNER_ORG_TYPES = ['partner'];
export const ORG_TYPE_LABELS = { operator: 'Company', partner: 'Partner (Business별 관계)' };
export const ALLOWED_ROLES = ['admin', 'operator'];
export const isGuest = role => !ALLOWED_ROLES.includes(role);
export const isPartnerOrgType = type => type === 'partner';
export const isPartnerUser = user => user?.organization_type === 'partner';
export const isPartnerRole = isPartnerUser;
export const isCompanyMember = user => ALLOWED_ROLES.includes(user?.role)
  && user?.organization_type === 'operator' && Boolean(user?.organization_id)
  && user.organization_id !== SIGNUP_HOLDING_ORGANIZATION;
export const isCompanyAdmin = user => isCompanyMember(user) && user.role === 'admin';
export const canManageUsers = user => isCompanyAdmin(user) || (isPartnerUser(user) && user.role === 'admin');
export function organizationScopeDescription(org) {
  if (!org) return '조직을 먼저 선택해 주세요.';
  if (org.id === SIGNUP_HOLDING_ORGANIZATION) return '승인 대기 조직 · Ticket 접근 불가';
  if (org.type === 'operator') return 'Company · 모든 Ticket 조회 및 처리';
  if (org.type === 'partner') {
    if (Array.isArray(org.access_relations)) {
      if (!org.access_relations.length) return 'Partner · 연결된 Business 없음 · Ticket 접근 불가';
      return org.access_relations.map(relation => `${relation.access_level === 'business' ? 'Business Partner' : 'Service Partner'} · ${relation.business?.name || relation.business_id}: ${relation.access_level === 'business' ? '모든 Ticket' : '이 조직에 배정된 Ticket만'}`).join(' / ');
    }
    return 'Business Partner: business 관계로 연결된 Business의 모든 Ticket. Service Partner: 해당 조직에 배정된 Ticket만. 관계는 Business마다 다를 수 있습니다.';
  }
  return '확인되지 않은 조직 · Ticket 접근 불가';
}
