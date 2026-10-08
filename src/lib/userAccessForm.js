import { SIGNUP_HOLDING_ORGANIZATION } from './roles';
export const USER_ACCESS_ROLES = ['admin', 'operator', 'guest'];

export function accessOrganizations(organizations, role) {
  if (!USER_ACCESS_ROLES.includes(role)) return [];
  return organizations.filter(org => org.is_active && (role === 'guest' || org.id !== SIGNUP_HOLDING_ORGANIZATION)
    && (org.type === 'operator' || (org.type === 'partner' && (Array.isArray(org.partner_details)
      ? org.partner_details.some(detail => detail.organization_id === org.id)
      : org.partner_details?.organization_id === org.id))));
}

export function accessSaveMessage(profile, organizations, role, organization) {
  if (!USER_ACCESS_ROLES.includes(role)) return '유효한 역할을 선택해 주세요.';
  if (!accessOrganizations(organizations, role).length) return '선택한 역할에 지정할 수 있는 활성 조직이 없습니다.';
  if (!organization) return '조직을 먼저 선택해 주세요.';
  if (!accessOrganizations(organizations, role).some(org => org.id === organization)) return '현재 조직을 이 역할에 사용할 수 없습니다. 활성 조직을 다시 선택해 주세요.';
  if (role === profile.role && organization === profile.organization_id) return '역할 또는 조직을 변경하면 저장할 수 있습니다.';
  return '';
}

export function formatUserAccessError(failure) {
  const messages = {
    last_active_admin_protected: '마지막 활성 관리자의 권한은 변경할 수 없습니다. 다른 활성 관리자를 먼저 지정해 주세요.',
    role_not_allowed: '소속 조직의 Admin만 사용자 권한을 변경할 수 있습니다.',
    organization_management_forbidden: '다른 조직의 사용자나 소속을 관리할 수 없습니다. Company Admin에게 문의해 주세요.',
    holding_organization_forbidden: '승인 대기 조직에는 Admin 또는 Operator를 지정할 수 없습니다.',
    company_role_required: 'Company 관리자 권한이 필요합니다.',
    partner_details_required: '파트너 정보가 등록된 조직을 선택해야 합니다. 파트너 관리에서 등록 상태를 확인해 주세요.',
    active_organization_required: '선택한 조직이 없거나 비활성 상태입니다. 목록을 새로고침하고 다시 선택해 주세요.',
    invalid_role: '유효한 역할을 선택해 주세요.',
    profile_access_unchanged: '저장할 변경사항이 없습니다. 목록을 새로고침해 주세요.',
    profile_not_found: '사용자를 찾을 수 없습니다. 목록을 새로고침해 주세요.',
    account_unavailable: '로그인 계정을 사용할 수 없습니다. 계정 상태를 확인해 주세요.',
  };
  if (messages[failure.message]) return messages[failure.message];
  if (failure.code === '28000' || ['app_session_required', 'app_session_invalid', 'session_revoked', 'idle_expired', 'absolute_expired', 'authentication_required'].includes(failure.message)
    || ['PGRST301', 'PGRST302'].includes(failure.code)) return '로그인 또는 앱 세션이 만료되거나 해제되었습니다. 다시 로그인해 주세요.';
  if (failure.code === '42501') return '권한 변경이 허용되지 않았습니다. 소속 조직, 관리자 권한과 계정 상태를 확인해 주세요.';
  if (failure.code === 'PGRST202') return '권한 저장 기능에 연결하지 못했습니다. 운영 담당자에게 문의해 주세요.';
  return undefined;
}
