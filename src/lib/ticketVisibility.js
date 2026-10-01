import { isPartnerOrgType } from '@/lib/roles';

/**
 * 파트너 사용자 티켓 가시성 필터 생성 (관계 기반)
 * - 비즈니스파트너(access_level='business'): 해당 비즈니스의 모든 티켓 조회
 * - 서비스파트너(access_level='service'): 자신에게 할당된 티켓만 조회
 * - 판단 기준은 org_type이 PARTNER_ORG_TYPES (role과 무관하게 파트너사 소속이면 제한 적용)
 *
 * @returns 필터 함수 (ticket) => boolean, 또는 null(제한 없음 - 운영사 계정)
 */
export function buildTicketVisibilityFilter(user, partners, servicePartners) {
  // 파트너사 소속이면 role과 무관하게 가시성 제한 적용
  if (!isPartnerOrgType(user?.org_type) || !user?.affiliation) {
    return null; // 제한 없음 (운영사 계정)
  }
  const myPartner = partners.find(p => p.id === user.affiliation);
  if (!myPartner) return () => false;
  const businessAccess = servicePartners
    .filter(sp => sp.partner_id === myPartner.id && sp.access_level === 'business')
    .map(sp => sp.business_id);
  return (ticket) => businessAccess.includes(ticket.business_id) || ticket.partner_id === myPartner.id;
}