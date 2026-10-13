# 이메일 MFA 운영 전환 (2026-10-13)

비밀번호 로그인 후 Supabase Auth 이메일 OTP를 서버에서 검증하고 기존 X-PartnerDesk-Session을 발급한다.
Auth가 PIN을 생성·해시 저장·SMTP 발송한다. 앱 DB에는 PIN을 저장하지 않는다.
verifyOtp의 Auth 세션은 매 요청 생성하는 비영속 서버 클라이언트에만 존재하며 브라우저 비밀번호 세션과 교체하지 않는다.
Auth.getUser로 검증한 JWT의 password AMR 및 session_id를 요구한다. OTP·복구 토큰만으로 업무 세션을 발급할 수 없다.
인증 전 Auth JWT만으로 기존 RLS/RPC를 통과하지 못하며, Guest 인증은 조직 승인이나 업무 권한을 부여하지 않는다.
이메일 도메인 제한은 추가하지 않는다. 가입 이메일 확인 및 관리자 수동 승인을 유지한다.

## 적용 정책

- 앱 challenge 만료 5분, 최대 5회 시도, 계정 누적 5회 시 5분 잠금. 시도 예약은 Auth 검증 전에 커밋한다.
- 재발송도 최소 60초, 사용자별 15분에 5회, 전체 10분에 60회. force가 제한을 우회하지 못한다.
- 신뢰 가능한 요청 IP가 확립되지 않아 클라이언트 IP 헤더로 제한 키를 만들지 않는다.
  대신 계정 제한과 보수적인 전체 공유 한도, Supabase Auth 자체 IP/발송 제한을 적용한다.
  Auth는 Edge 발송 요청에서 Edge 출발 IP를 보므로 사용자 IP별 정밀 제어라고 주장하지 않는다.
- 요청·발송 접수/실패·시도·실패·잠금·성공을 기존 감사 체인에 기록한다. PIN·토큰·비밀번호·메일 본문은 기록하지 않는다.
- 기존 업무 세션은 원래의 최대 8시간 / 유휴 15분 유효기간을 유지한다. MFA 변경은 다음 로그인부터 적용한다.
- 기존 사용자·조직·Ticket·동의 데이터는 변경하지 않는다. 신규 migration만 적용한다.

## 활성화 전 필요한 설정과 검증

1. Supabase Auth의 Custom SMTP를 확인한다. 기본 SMTP는 일반 Gmail/Naver/회사 주소 전체에 대한 운영 발송 경로가 아니다.
2. Auth Email OTP length를 6, OTP expiry를 300초로 설정한다.
3. Magic Link 이메일 템플릿에 `{{ .Token }}` 6자리 PIN과 5분 안내를 표시한다.
   앱 로그인용 OTP의 링크 리다이렉트는 `/login`이다. 기존 가입/복구 템플릿은 유지한다.
4. Auth single-session-per-user 옵션은 비활성 상태여야 한다. OTP 검증의 별도 Auth 세션이 기존 비밀번호 세션을 종료하면 안 된다.
5. 전용 검증 계정에서 SMTP 실제 수신·PIN 검증·기존 비밀번호 JWT 유지·인증 전 API 차단을 확인한다.
6. 성공 후 Edge Secret `PARTNERDESK_EMAIL_OTP_READY=true`를 설정한다.
7. 유일한 Company 관리자의 새 MFA 로그인과 복구 절차를 확인한 후 DB `mfa_enabled`를 true로 전환한다.
   정책 변경은 기존 감사 관리 경로 또는 제한된 운영 DB transaction에서 변경 사유와 함께 기록한다.
   발송 준비가 미완료이면 false를 유지한다. 이메일 주소·비밀 설정은 로그나 커밋에 남기지 않는다.

## 이번 배포 결과

- 신규 `20261013000000_email_mfa_flow.sql` 하나만 dry-run 후 적용했다. app-auth는 ACTIVE v5로 배포했다.
- 원격 MFA는 false, 준비 Secret은 없음. Auth 가입 이메일 확인은 활성이다.
- 6자리·300초·PIN 템플릿을 `supabase/config.toml`과 템플릿 파일로 준비했다.
  적용 요청은 HTTP 400으로 거절됐다: 기본 이메일 제공자를 쓰는 무료 프로젝트에서는
  템플릿 변경을 위해 Custom SMTP 또는 플랜 변경이 필요하다는 Supabase 응답이다.
  재조회에서 OTP 길이 8·만료 3600초와 기존 제목이 유지됨을 확인했다.
  Custom SMTP 연결 후 `supabase config push --project-ref bqtlopwgjvvugalktldr --yes`로 선언한 Auth 항목만 적용한다.
- 실제 일반 주소 발송·수신함·PIN 입력을 운영에서 검증하지 못했다. 발송 성공으로 보고하지 않는다.
- 앱/DB/UI 110개 및 Edge 21개, 총 131개 자동 테스트 통과. lint/build/diff check 통과.
- 적용 전후 기존 profiles/organizations/businesses/tickets/privacy_consents/private.app_sessions 행 해시가 동일했다.
  활성 Company 관리자 1명, 감사 체인 정상, browser role의 MFA 세션 발급 RPC EXECUTE 권한 없음도 확인했다.
- 기존 관리자 잠금을 방지하기 위해 이번 배포에서 MFA 강제 활성화는 보류한다.

참고: https://supabase.com/docs/guides/auth/auth-email-passwordless
https://supabase.com/docs/guides/auth/auth-smtp
