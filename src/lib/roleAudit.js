export const changeTypeLabel = value => ({direct:'관리자 직접 변경',request_approved:'요청 승인'}[value] || '처리 방식 확인 필요');
const roles = {admin:'관리자',operator:'운영자',guest:'미승인',partner_admin:'파트너 관리자'};
export const roleLabel = (role,type) => `${type === 'operator' ? 'Company · ' : type === 'partner' ? 'Partner · ' : ''}${roles[role] || role || '기록 없음'}`;
export function auditTime(value) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '기록 없음';
  return new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(value));
}
export function roleChanges(row) {
  const changes=[];
  if (row.role_before !== row.role_after || row.org_type_before !== row.org_type_after) changes.push({label:'권한',before:roleLabel(row.role_before,row.org_type_before),after:roleLabel(row.role_after,row.org_type_after)});
  if (row.affiliation_before !== row.affiliation_after) changes.push({label:'소속',before:row.organization_before_name || '소속명 확인 불가',after:row.organization_after_name || '소속명 확인 불가'});
  return changes;
}
