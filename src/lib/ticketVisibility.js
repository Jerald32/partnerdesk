import { ALLOWED_ROLES, isCompanyMember, isPartnerUser } from './roles';
// Optional display filter; never replaces RLS. Unknown identity fails closed.
export function buildTicketVisibilityFilter(user, _partners, servicePartners = []) {
  if (!ALLOWED_ROLES.includes(user?.role)) return () => false;
  if (isCompanyMember(user)) return () => true;
  if (!isPartnerUser(user) || !user.organization_id) return () => false;
  const relations = servicePartners.filter(sp => sp.partner_organization_id === user.organization_id);
  return ticket => relations.some(sp => sp.business_id === ticket.business_id
    && (sp.access_level === 'business' || ticket.assigned_partner_organization_id === user.organization_id));
}
