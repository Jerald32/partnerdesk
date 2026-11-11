export const reviewStatus = status => ({pending:'승인 대기',approved:'승인 완료',rejected:'보완 필요',withdrawn:'요청 회수',not_requested:'요청 이력 없음'}[status] || status);
export function previousReviewMonth(now=new Date()) {
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit'}).formatToParts(now).map(p=>[p.type,p.value]));
 return new Date(Date.UTC(Number(parts.year),Number(parts.month)-2,1)).toISOString().slice(0,7);
}
export function recentReviewMonths(now=new Date()) {
 const [year,month]=previousReviewMonth(now).split('-').map(Number);
 return Array.from({length:3},(_,index)=>new Date(Date.UTC(year,month-1-index,1)).toISOString().slice(0,7));
}
export function reviewError(error) {
 if(error.code==='23505')return '해당 월에 승인 대기 또는 승인 완료된 점검이 있습니다. 현황을 새로고침해 주세요.';
 if(error.code==='22023')return '대상 월과 활성 Company 승인자를 확인하고 필수 입력값의 길이를 확인해 주세요.';
 return ({self_approval_forbidden:'본인은 승인자로 지정할 수 없습니다.',invalid_review_approver:'활성 상태의 Company 사용자를 승인자로 선택해 주세요.',
  review_already_open_or_approved:'해당 월에 승인 대기 또는 승인 완료된 점검이 있습니다.',review_already_decided:'이미 처리된 요청입니다. 새로고침해 주세요.',
  designated_approver_required:'지정된 승인자만 승인·반려할 수 있습니다.',company_member_required:'활성 상태의 Company 사용자만 이용할 수 있습니다.',
  review_not_available:'조회 권한이 없거나 존재하지 않는 점검 요청입니다.',invalid_review_input:'지난달 이전의 대상 월을 선택하고 점검 결과·특이사항·조치 내용을 입력해 주세요.',
  invalid_review_decision:'처리 의견을 1~2,000자로 입력해 주세요.'})[error.message];
}
