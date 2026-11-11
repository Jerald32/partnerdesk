export function accountStatusLabel(status) {
  return ({ pending_login: '로그인 대기', active: '활성', inactive_warning: '미접속 경고',
    suspended: '차단', disabled: '비활성화' })[status] || status;
}
