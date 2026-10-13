# PartnerDesk 보안 전환 차이 조사

조사일: 2026-10-12 (Asia/Seoul). 대상: Git HEAD `7e82465`, Base44 export 기준
`edad184`, Supabase `bqtlopwgjvvugalktldr`, React/Vite 및 Vercel 저장소 설정.

## 결론과 집계

**33개 항목: A 유지·검증 완료 9, B 구현·검증 부족 8, C 부분 구현/약화 8,
D 기존 구현의 현재 누락 5, E 기존 구현 확인 불가 3.** 각 행은 하나의 상태로만 집계한다.
기존 구현이 모두 유지됐다고 판단할 수 없다. 특히 동의 전 업무 API 접근 제한,
MFA/IP의 실제 작동, 조회 감사/IP 기록, 보존 자동화, 가입 동의에 보완이 필요하다.

공식 사내 체크리스트·승인된 요구사항 명세·심사 기준은 확보하지 못했다.
아래는 **소스/설정에서 발굴한 기존 기능**과 현재의 비교이며, 회사의 공식 정책 목록이나
법적 적합성 판정이 아니다. 화면의 '90일', '3년', '1년', '1인1계정' 문구 역시
회사 승인 문서 없이 공식 의무로 확정하지 않는다. **실제 보안 심사 통과 여부는 미판정**이다.

## 조사 범위·방법·안전 조건

- Base44 functions/shared/entities/workflows, 보관된 `legacy/base44` 화면, export commit의
  원래 화면/AuthContext/유휴 훅을 읽었다. 전환 이력 `be9650d`, `efa8dea`, `542ff98`,
  `1d3b1f3`, `c60ab28`, `849bebc`, `7e82465` 및 관련 문서를 대조했다.
- 현재 React 실행 import/route, Auth SDK, PostgreSQL RLS/RPC·트리거·ACL,
  app-auth Edge, Vercel 설정을 조사했다. 화면/함수 존재와 운영 강제/실행을 구분했다.
- 원격 SQL은 `BEGIN READ ONLY`에서 catalog 및 비식별 집계만 조회했다.
  감사 체인은 SHA-256 재계산과 window 연번/연결 비교를 사용했으며,
  advisory lock을 잡는 verifier나 세션 touch 함수는 호출하지 않았다.
- 이번 조사에서 로그인, 계정/세션 변경, 업무 데이터 변경, migration, 배포는 수행하지 않았다.
  이전 대화의 실제 인증 검증은 별도 근거로만 재사용했다. 신규 fixture도 만들지 않았다.
- 운영 연결 없는 회귀 테스트: 앱/격리 PostgreSQL/UI 61개, app-auth 18개, 합계 **79개 통과**.
  app-auth 테스트는 모의 서비스 테스트이므로 실제 MFA 메일 발송 성공을 뜻하지 않는다.
- 이전 원격 기준 자료에 있는 함수 70개의 정의를 현재 원격과 메모리에서 비교해 모두 일치했다.
  이는 해당 70개 정의에 한정한 비교이며 운영 Auth 설정·Edge secret·Vercel artifact의 동일성 증명은 아니다.
- 원격: public RLS 비활성 테이블 0, SELECT 이외 policy 0, restrictive session gate 13,
  authenticated가 실행할 수 있는 private/audit 함수 0, backend_* 함수 0.
- 원격 설정: `mfa_enabled=false`, pledge version `v1.0`, 활성 IP 등록 0,
  `ip_restriction_enabled` 행 없음. Edge는 이 값이 정확히 `true`일 때만 제한 활성으로 취급한다.
  Storage bucket 0, pg_cron/pg_net 및 cron schema 없음.
- 감사 로그 11행: 해시/연번/연결 불일치 0, 접속 IP NULL 11, 조회 action 집계 0,
  파기 이력 0. 조회 집계만으로 누락을 판정하지 않고 현재 조회 경로의 기록 호출 부재도 확인했다.
- 추적 파일 236개에서 sb_secret/private-key/JWT 패턴 검출 0, 기존 로컬 build asset 2개에서
  secret/private-key 패턴 검출 0. 비밀 값은 출력하지 않았다. 전체 Git blob 이력,
  ignore된 모든 파일, 운영 bundle, Vercel 환경변수 전체의 포괄적 비밀 검사는 아니다.

### 판정 기준

| 상태 | 의미 |
|---|---|
| A | 발굴된 기능이 현재 유지/강화되었고 해당 범위의 검증 근거 있음. 모든 환경·예외의 완전 검증을 뜻하지 않음 |
| B | 구현이 있으나 운영 설정 또는 실제 경계/종단 간 검증 부족 |
| C | 일부 계층만 구현, 실행 경로 미완성 또는 기능 약화/효력 공백 |
| D | 기존 구체적 구현 근거가 있으나 현재 실행 경로에서 누락. 보관 파일/테이블만 남은 경우 포함 |
| E | 문구·화면 흔적만 있거나 플랫폼 구현 근거가 없어 기존 구현 사실 확정 불가 |

P1은 심사 제출 전 해결 또는 승인된 적용 제외 근거가 필요한 항목,
P2는 심사 전 운영 검증/운영 절차 정비, P3는 기능 채택 여부 확인 항목이다.
우선순위는 이 조사자의 제안이며 회사 등급 체계가 아니다.

## 근거 인덱스

원본 중 현재 경로가 대체된 파일은 `git show edad184:<경로>`로 확인했다.
아래 S번호는 비교표의 파일 근거이며 현재 상태 주장만으로 과거 사실을 추정하지 않았다.

| 근거 | 자료 |
|---|---|
| S1 | Base44 [세션 guard](../base44/shared/sessionGuard.ts), [이메일 guard](../base44/shared/verifyUser.ts), [세션 활성화](../base44/functions/activateSession/entry.ts), [로그아웃](../base44/functions/revokeSession/entry.ts) |
| S2 | Base44 [MFA 발송](../base44/functions/mfaSendCode/entry.ts), [MFA 검증](../base44/functions/mfaVerifyCode/entry.ts), [IP 판정](../base44/shared/ipUtils.ts) |
| S3 | Base44 [사용자 관리](../base44/functions/manageUsers/entry.ts), [권한 요청](../base44/functions/submitRoleRequest/entry.ts), [Ticket entity RLS](../base44/entities/Ticket.jsonc), export 원본 AuthContext/Ticket 화면 |
| S4 | Base44 [가입](../legacy/base44/src/pages/Register.jsx), [비밀번호 검증](../base44/functions/validatePassword/entry.ts), [변경 주기](../base44/functions/passwordCycle/entry.ts), [변경 안내](../legacy/base44/src/components/PasswordCycleNotice.jsx) |
| S5 | Base44 [장기 미접속 처리](../base44/functions/checkInactiveAccounts/entry.ts), [workflow](../base44/workflows/Inactive%20Account%20Check.jsonc) |
| S6 | Base44 [감사 해시·CSV](../base44/shared/accessLog.ts), [조회 기록](../base44/functions/recordAccess/entry.ts), [백업](../base44/functions/backupAccessLogs/entry.ts), workflows의 접속기록 자동 백업 파일 |
| S7 | Base44 [파기](../base44/functions/processDataRetention/entry.ts), [동의 entity](../base44/entities/PrivacyConsent.jsonc), workflows의 보존기한 자동 파기 파일 |
| S8 | Base44 [설정](../legacy/base44/src/pages/Settings.jsx), [IP 관리](../legacy/base44/src/components/settings/IpWhitelistManager.jsx), [MFA 관리](../legacy/base44/src/components/settings/MfaSettingManager.jsx), [OAuth 동의](../legacy/base44/src/pages/OAuthConsent.jsx) |
| S9 | 현재 [AuthContext](../src/lib/AuthContext.jsx), [appAuth](../src/lib/appAuth.js), [Supabase client](../src/lib/supabaseClient.js), [앱 세션 저장](../src/lib/appSession.js), [로그아웃](../src/lib/logout.js), [유휴 훅](../src/hooks/useIdleTimeout.jsx) |
| S10 | 현재 [Edge entry](../supabase/functions/app-auth/index.ts), [handler](../supabase/functions/app-auth/handler.ts), [email adapter](../supabase/functions/app-auth/email.ts), [HTTP/CORS](../supabase/functions/app-auth/http.ts), [JWT gateway 설정](../supabase/config.toml) |
| S11 | [앱 인증 SQL](../supabase/migrations/20261006000013_add_app_auth_functions.sql), [Data API 세션 경계](../supabase/migrations/20261006000016_enforce_app_session_boundary.sql), [조직별 권한 SQL](../supabase/migrations/20261008000003_separate_organization_roles.sql) |
| S12 | [감사 체인 SQL](../supabase/migrations/20261006000010_add_audit_append_function.sql), [동의·보존 SQL](../supabase/migrations/20261006000014_add_privacy_retention_functions.sql), [안전 가입 SQL](../supabase/migrations/20261008000002_add_safe_self_registration.sql) |
| S13 | 현재 [ProtectedRoute](../src/components/ProtectedRoute.jsx), [Registration](../src/pages/Registration.jsx), [PasswordRecovery](../src/pages/PasswordRecovery.jsx), [PrivacyConsent](../src/pages/PrivacyConsent.jsx), [password](../src/lib/password.js), [passwordPolicy](../src/lib/passwordPolicy.js) |
| S14 | 현재 [설정](../src/pages/SystemSettings.jsx), [감사 화면](../src/pages/AdminAudit.jsx), [개인정보 안내](../src/pages/PrivacyNotice.jsx), [Ticket 목록](../src/pages/TicketList.jsx), [상세](../src/pages/TicketDetail.jsx), [앱 route](../src/App.jsx), [Vercel 설정](../vercel.json) |
| S15 | [실제 Ticket 접근 검증](live-ticket-access-verification-20261012.md), [조직 권한 전환](organization-role-model.md), [Auth 원격 적용](auth-registration-remote-application.md), [Auth 배포 준비](auth-deployment-readiness.md), [전환 상태](supabase-transition-status.md) |
| S16 | [조직 DB 회귀 테스트](../tests/organization-authorization.test.mjs), [Edge 회귀 테스트](../supabase/functions/app-auth/app-auth.test.mjs), [로그아웃 테스트](../tests/logout.test.mjs) |

## 기존 기능 대비 현재 비교표

각 행에 과거·현재 근거, 영향, 보완 필요/우선순위, 검증 방법을 포함한다.
서버 강제의 범위가 좁은 기능은 그 범위를 명시한다.

| # / 항목 / 상태 | 기존 Base44 구현·근거 | 현재 구현·근거 및 강제 계층 | 차이·영향 | 보완 / 우선순위 / 검증 방법 |
|---|---|---|---|---|
| 01 사용자 인증 — A | SDK auth + me, 업무 함수 사용자 확인 S1/S3 | Auth JWT를 Edge의 getUser로 검증, 고정 backend RPC, Data API는 JWT+앱 토큰 S9–S11; 실제 로그인 S15 | 서버 검증 유지, 프런트 플래그만으로 성공 처리하지 않음 | 현재 결함 없음 / P2 / 기존 실제 인증 근거 및 18개 Edge 회귀; 인증 경로 변경 시 재검증 |
| 02 신규 계정 승인 대기 — A | guest 권한 요청/관리자 승인 S3 | Auth INSERT trigger가 metadata 역할 무시, guest/대기 조직 생성; RLS/RPC에서 업무 범위 없음 S11/S12 | 자기 metadata로 권한 획득 차단 강화 | 추가 수정 근거 없음 / P2 / 격리 DB guest·승인·임의 role 요청 테스트 통과; 실제 가입→승인은 별도 B09 |
| 03 조직/Business/Ticket 권한 — A | role 중심 entity RLS와 화면 filter S3; Partner별 엄밀한 서버 범위 증거는 약함 | 조직+관계별 can_access_ticket, RPC 동일 경계 S11, 실제 Company/BP/SP 126개 검사 S15 | 역할만 허용한 과거보다 서버 조직 격리 강화 | 유지 / P2 / 실제 ID 직접 조회·변경 거절 근거; mixed 관계는 격리 DB 테스트 |
| 04 내부 Activity 격리 — A | internal note/view 표시와 역할 조건, export 원본 상세 S3 | Company 전용 note 권한·Activity RLS, Partner public만 S11/S15 | 목록과 상세/변경 경계 일치 | 유지 / P2 / 실제 public/internal 조회 검사, 격리 DB note 거절 테스트 |
| 05 관리자 권한·정지/해제 — A | manageUsers Admin, 계정 상태 guard S1/S3 | Company/Partner Admin 범위, Company Operator 관리 금지, last Company Admin 보호, 대상 세션 폐기 S11 | Partner 관리 전역 확장 차단·관리자 보호 강화 | 유지 / P2 / 61개 회귀의 승인/정지 identity·대상 외 세션 보존; 원격 변경 검증은 이번에 수행 안 함 |
| 06 직접 DML/민감 관리 접근 — A | role 기반 create/update/delete entity policy S3 | 업무 writes는 RPC, direct write policy 없음; backend/private/audit EXECUTE와 감사 조회 Company Admin 한정 S11 | 임의 profile/DML 변경 표면 축소 | 유지 / P2 / 원격 ACL 집계, 격리 direct DML·비Admin audit 거절 |
| 07 개인정보 목록 마스킹 — A | export 목록 및 공통 mask 함수 | TicketList/MobileCard에서 이름·연락처 mask; 상세는 허용 사용자에게 원문 S14 | UI 마스킹 유지. API 원문 조회를 차단하는 필드 보안으로 해석하지 않음 | 추가 필드 최소화는 공식 정책 확인 후 / P2 / 목록/mobile 표시·응답의 차이 확인; 다운로드 마스킹은 E32 |
| 08 감사 체인 무결성 — A | seq/prev_hash/SHA-256, verifier S6; 최신 행 읽기 후 쓰기 | 서버 append 트랜잭션·advisory lock·전행 hash, 직접 권한 없음 S12 | 동시 append 정합성 강화. DB 소유자까지 막는 WORM은 아님 | 유지 / P2 / 원격 11개 hash·seq·link 불일치 0; 독립 보관은 D28 |
| 09 비밀번호 변경 후 세션 처리 — B | reset 요청 후 첫 MFA 로그인에 변경일 반영 S4/S2; 실제 password change trigger 증거 없음 | encrypted_password 실제 변경 trigger가 변경일 기록+대상 앱 세션 폐기 S12/S15 | 요청만으로 변경 완료 취급하던 추정 대신 실제 변경 기반 강화; 실제 변경에 의한 세션 폐기 동작은 미검증 | 필요 / P2 / 원격 적용 문서와 일치하는 함수 정의·trigger 설치 근거; 별도 테스트 계정의 실제 password 변경/이전 앱 토큰 거절 검증 |
| 10 알림의 데이터 격리 — A | Notification entity/알림 화면, 수신자 기반 | 본인 알림+현재 Ticket 범위, mark_notifications_read RPC S11 | 권한 회수 후 이전 Ticket 알림 누출 차단 | 유지 / P2 / 격리 DB notification 조회/변경 경계 테스트 |
| 11 이메일 확인·가입/복구 — B | OTP verify/resend, verified guard S1/S4 | Auth signup/resend/recovery route, Edge 확인메일·profile email 일치 검사 S9/S10/S13 | 구현 유지. Auth SMTP/Confirm email/redirect·메일 수신 운영 설정 미검증 | 필요 / P1 / Auth 설정 증거 확보 후 별도 테스트 계정으로 가입→확인→승인 및 복구 링크 만료/재사용 검사 |
| 12 비밀번호 복잡도 — B | 8자+대소문자/숫자/특수문자, 별도 validatePassword 호출 S4; Auth endpoint 강제 여부 불명 | 가입/복구 JS 동일 규칙 S13; Supabase Auth 서버 password 설정 확보 못함 | UI만 우회 시 동일 규칙 강제된다는 증거 없음. Base44 별도 validator도 register와 원자적 결합 증거 없음 | 필요 / P1 / Auth 설정을 비밀 없이 확인하고 허가된 테스트에서 직접 Auth API 약한 비밀번호 거절 확인 |
| 13 8시간 절대 만료 — B | sessionGuard 8h 서버 검사; session 없으면 통과 가능 S1 | DB 세션 8h, expires_at·revoked·JWT uid 매칭, RLS gate S11 | 무세션 fail-open 제거·서버 경계 강화 | 운영 경계 검증 필요 / P2 / 만료 직전/직후 및 refresh JWT 요청을 격리 시간 fixture와 실제 인증 경로로 확인; 기존 세션 조작 금지 |
| 14 15분 유휴·탭 정책 — B | export `useIdleTimeout` 실제 15분, localStorage 활동 공유. 안내 문구 1시간과 상충 | 15분 UI+DB idle, trusted UI event touch, poll no-touch S9/S11 | 서버 유휴 강제 강화. Auth localStorage 공유와 앱 token sessionStorage의 탭별 차이는 추가 확인 필요 | 필요 / P2 / 다중 탭, background/restore, 실제 입력 없는 poll, touch 실패 경계; 서버는 인간 조작을 증명하지 않음 |
| 15 중복 로그인 제한 — B | 단일 session ID 교체로 이전 기기 종료 S1 | 새 앱 세션 발급 전 동일 profile 기존 세션 revoke S11 | DB 기능 유지; 앱 세션의 탭별 저장 때문에 새 탭 로그인 UX 차이 가능 | 필요 / P2 / 두 기기/두 탭의 실제 인증 테스트, 이전 JWT+앱 토큰 거절; 이번 운영 세션 변경 없음 |
| 16 로그아웃·재사용 차단 — B | 서버 revoke로 해당 계정의 세션 무효화 S1 | 현재 앱 토큰 revoke 후 local Auth signOut·캐시 정리 S9; 실패해도 로컬 정리 S16 | 정상 성공 유지. 서버 revoke 장애 시 탈취된 토큰까지 즉시 폐기되는 것은 보장 안 됨; scope도 계정 전체→본인 session | 필요 / P2 / 정상·네트워크 장애·복사 토큰 재사용 검증. 실제 성공 logout S15, 장애 경로는 로컬 모의 검사 |
| 17 전송/저장 암호화 — B | Base44 플랫폼 기본이라는 화면 주장, 저장 인프라 증거 없음 | Supabase HTTPS URL; DB/backup/Vercel 저장 암호화·키 관리 증빙 미확보 | 외부 사업자 분리로 플랫폼 증빙 새로 필요 | 필요 / P1 / 운영 TLS/HTTP redirect, 공급자 저장·백업 암호화 증빙 및 회사 요구 비교; 소스만으로 인증 불가 |
| 18 이메일 추가인증(MFA) — C | 6자리 5분 코드 이메일 발송, 5회/5분 잠금 S2 | SQL nonce/HMAC/challenge/lock 구현, Edge email adapter 미설정, 현재 frontend activate-without-mfa만; mfa_enabled=false S9–S11 | 현재 추가인증 사용 불가. true이면 bypass 성공 대신 로그인 차단; 계정 잠금/코드 발송은 end-to-end 미작동 | 필요 / P1 / 메일 adapter·MFA UI·운영 설정 준비 후 발송/오입력/재발송/만료/이전 challenge 재사용 검사 |
| 19 IP 화이트리스트 — C | exact IP 목록, 인증 시 제한; x-forwarded-for/x-real-ip 신뢰 S2. 프록시 신뢰 보장 증거 없음 | 목록 테이블/읽기 화면만. true+활성 목록이면 Edge 503 ip_enforcement_not_configured, 업무 DB 요청 자체 IP guard 없음 S10/S14 | 신뢰할 IP 판정 경로가 없어 기능 유지 안 됨. 무조건 허용보다 fail-closed이나 실제 allow/deny 서비스 아님 | 필요 / P1 / 신뢰 proxy/IP 경로와 Data API 우회 차단 설계 후 등록/미등록/위조 header/기존 세션 검사; 현재 설정 즉시 활성화 금지 |
| 20 Partner 개인정보 서약 — C | 1년 동의 기록·프런트 gate, 원본 AuthContext 조회 오류 시 valid=true S7/export | 본인/조직/version/1년 RPC 강제, UI 실패 시 차단 S12/S13. Ticket/session RLS에는 동의 조건 없음 | 기록·UI는 강화됐으나 직접 업무 API는 동의 없이 허용. 이전 API 검사 Partner 4명 동의 0개임을 원격 재확인 | 필요 / P1 / 업무 SELECT/RPC 공통 서버 gate 설계; 미동의/만료/version·소속 변경 시 직접 API 거절, 동의 기록 RPC만 허용 |
| 21 3년 보존·파기 — C | 입력일+3*365일 Ticket 일부 PII 제거·Activity/Notification 삭제, 일일 workflow S7 | calendar 3 years batch RPC, 더 많은 PII 제거·Activity anonymize·Notification delete·read-only guard S12; cron 없음, 파기 로그 0 | 파기 함수는 강화됐지만 자동 실행 미확인; Activity 삭제→비식별 보존의 정책 차이, 첨부 metadata/object 처리 제외 | 필요 / P1 / 외부 scheduler 증거 확인, 없으면 안전한 job/관찰·retry 설계. 격리 DB 3년 경계·첨부·감사/backup PII 범위 검증; 운영 함수 실행 금지 |
| 22 접속·조회·변경 감사 범위 — C | 목록/상세 logAccess, view Activity, 로그인 및 서버 업무 기록 S6/export; 프런트 log 실패는 무시 | writes는 같은 transaction audit append, role/deletion 이력 읽기 가능. 조회 경로/세션 발급의 동일 access audit 연결 없음, trusted IP/UA NULL S11/S12/S14 | 쓰기 감사 실패 rollback 강화, 조회/인증 기록과 접속지 식별은 누락. 실제 11행 모두 IP NULL | 필요 / P1 / 업무 조회/로그인/거절/변경 사건 목록 합의, trusted 요청 컨텍스트 기록·우회 불가 조회 audit 경로, 민감값 최소화 확인 |
| 23 관리자 보안 설정 변경 — C | IP 등록/삭제·중단, MFA 토글 S8 | Company Admin 조회 전용 S14, 관련 write RPC 없음 | 위험한 미완성 설정 활성화를 막았으나 운영자가 기존 기능을 관리할 수 없음 | 필요 / P2 / 인증 기능 구현 후 감사·변경 권한·복구 절차 포함 관리 RPC 검증; 현재 비활성 설계를 결함 우회로 해결하지 않음 |
| 24 첨부·파일 보호/이관 — C | 원본 상세의 attachment 링크 표시, 백업은 private upload/signed URL S6/export; 일반 Ticket 파일의 private 정책 증거 없음 | ticket_attachments RLS는 검증됐지만 Storage bucket 0, upload/download·기존 file 이관 없음 S15 | 메타데이터 보안만 유지; 실제 객체 권한/파기/역사적 링크 접근은 확인 불가 | 필요 / P2 / 회사 사용 범위 확인 후 private 객체 매핑·signed URL·권한회수·파기 검증. 새 bucket을 이번에 생성하지 않음 |
| 25 보안 설명 화면의 정합성 — C | 개인정보 조치 화면의 MFA/IP/파기/플랫폼 암호화 등 주장 | PrivacyNotice 소스에 Base44 BaaS·옛 함수명·1시간 idle·전체 다운로드 마스킹·자동 파기 등이 남음. 현재 App route에는 이 화면도 없음 S14 | 오래된 설명을 현황 증거로 사용할 수 없음; 실제 배포 화면이 그대로 노출된다고 단정하지 않음 | 필요 / P1 / 문서/화면을 구현·미구현·미검증으로 수정, route와 production screenshot 비교 |
| 26 가입 동의 3종 — D | privacy/delegation/oneAccount 체크박스 및 allConsented submit gate S4; 장기 증적 저장/서버 강제 근거는 부족 | Registration에 동의 수집/저장 필드 없음 S13. role request consent·Partner pledge는 다른 목적 | 기존 가입 동의 UI가 누락. 회사 문구·개인정보 수집 범위의 합의부터 필요 | 필요 / P1 / 승인된 동의 문구/version/time/subject 증적과 가입 전 API 강제 방식을 검증; 기존 계정 소급 동의는 별도 승인 |
| 27 90일 비밀번호 변경 안내 — D | PasswordCycleNotice + passwordCycle request_reset, '나중에' 가능 S4 | passwordPolicy helper만 남고 현재 import/route 없음 S9/S13/S14 | 권고 알림이 실행되지 않음. 과거에도 강제 90일 차단은 아님 | 필요 / P2 / 회사가 여전히 요구하는지 확인 후 reminder와 실제 변경일 기반 표시 검사; 새 강제 정책으로 확대하지 않음 |
| 28 장기 미접속 관리 — D | Partner 23일 경고/30일 정지·메일, workflow S5 | account_status/last_login_at/exempt 필드 및 수동 정지 기능만. checker/job/메일 없음 S11/S14 | 자동 휴면 처리 누락; 필드 존재를 작동으로 판단하지 않음 | 필요 / P1 / 조직별 적용 범위와 예외 확인, 격리 시간 경계·실패 알림·대상 세션 revoke·재활성 검증 |
| 29 접속기록 독립 백업·다운로드 — D | 전체 로그 체인 검증→마스킹 CSV→private upload·hash·5분 signed URL, 일일 workflow S6 | backup 이력 table만, 실행/외부 저장/CSV·검증 UI/다운로드 경로 없음 S12/S14 | 독립 보관/복구 기능 누락. DB 공급자 전체 백업과 이 기능은 목적이 다름 | 필요 / P1 / 승인 보존기간·격리 저장·immutable 요구 확인, 접근/CSV 마스킹·hash·restore·failure retry 검사 |
| 30 MCP/OAuth 권한 동의 — D | OAuthConsent가 opaque handle 정보 조회·approve/deny, 서버 auth 결과 기반 login redirect S8 | 페이지 legacy 보관, 현재 route/서버/MCP 없음 S14/S15 | 기존 동의 UI/플랫폼 연동 경로 미이관. 현재 외부 OAuth 권한이 무동의 발급된다는 증거는 없음 | 채택 결정 필요 / P3 / 사용 연동 목록 확인; 유지 요구 시 scope/handle 재사용·취소·승인·redirect 검증, 미사용이면 제외 근거 |
| 31 1인1계정의 실제 강제 — E | 가입 checkbox 문구 있음 S4; 사람 식별·복수 이메일 탐지 근거 없음 | Auth email 계정과 조직 단일 FK, 사람 단위 중복 탐지 없음 | 이메일 unique는 1인1계정 보장 아님; 이전부터 실제 강제 구현 여부 불명 | 정책/근거 확인 / P2 / 사내 ID·퇴사자/공용계정 정책 확보, 구현 요구 여부 결정 |
| 32 Ticket 내보내기와 전항목 다운로드 마스킹 — E | 안내 화면 주장 있으나 export 원본 TicketList에서 실행 export/download 경로 확인 안 됨; 로그 CSV만 S6 확인 | 현재 Ticket export 없음, 안내 문구만 S14; CSV backup은 D29 | '기존 Ticket export 기능이 제거됐다'고 단정할 근거 없음 | 필요 여부 확인 / P3 / 실제 Base44 버전/운영 화면·산출물 확보; 도입 시 원문 유출/CSV formula/마스킹 검증 |
| 33 플랫폼 인프라 보안 운영 — E | Base44 관리형 플랫폼 추정 외 데이터 위치·RPO/RTO·운영 접근 통제·보안 헤더 승인 자료 없음 | Supabase/Vercel 공급자/플랜/설정·권한·복구 정책 증빙 미확보 | 원래 보장 범위와 새 사업자의 동등성 비교 불가 | 근거 확보 필요 / P1 / 공급자 설정·계약·관리자 접근/MFA·복구 훈련·리전/보관 정책 자료 비교 |

## 전환 때문에 추가된 위험 — 기존 기능 차이와 별도

아래 9개는 33개 집계에 더하지 않는다. '미검증'은 취약점 확정이 아니다.

| 위험 | 확인된 사실 / 미검증 구분 | 영향·검증 및 우선순위 |
|---|---|---|
| N1 Vite 클라이언트 secret 혼입 | 확인: 클라이언트는 publishable key만 요구, 추적/로컬 build 패턴 0. 운영 Vercel 변수/bundle·전체 Git blob은 미검증 | VITE_*에 server key가 들어가면 노출. 운영 artifact/환경 이름·분류·Git 이력 scanner 확인 P1; 키 값 출력 금지 |
| N2 공개 Data API를 통한 UI gate 우회 | 확인된 공백: Partner pledge 없는 실제 사용자 API 접근 성공 S15 및 원격 동의 0행. 모든 public 업무 테이블에는 RLS와 session gate 있음 | UI 동의 조건만 우회 가능; 서버 동의 gate 보완 P1. 조직 RLS 전체 우회 취약점으로 과장하지 않음 |
| N3 SECURITY DEFINER/service_role 경계 | 확인: 원격 public backend/private/audit에 authenticated EXECUTE 없음, 70 함수 정의 기준 일치. service_role은 원래 RLS 우회 자격 | 관리자 키 유출·새 함수의 잘못된 grant 위험은 미래/미검증. Edge만 키 보관, ACL drift 검사·직접 DML 거절 P1 |
| N4 Edge gateway JWT check 비활성 | 확인: verify_jwt=false이지만 매 POST getUser 검증·고정 RPC·body allowlist, CORS exact origins; 18개 로컬 테스트 | 설정만으로 무인증 취약점이라고 판정하지 않음. 운영 Edge artifact/Origin allowlist 최신성은 미검증; 없는/위조 JWT·Origin 음성 검사 P1 |
| N5 브라우저 token 보관/XSS | 확인: Auth localStorage, 추가 credential sessionStorage. 입증된 XSS exploit 없음 | 동일 origin 스크립트 실행 시 두 credential 위험. 코드/외부 스크립트·CSP·unsafe HTML 경로·session 복제 위협 검토 P1; 저장소 선택만 취약점으로 확정하지 않음 |
| N6 Vercel 보안 헤더/캐시 | 확인: vercel.json은 SPA rewrite만, CSP/frame/HSTS/referrer 헤더의 소스 설정 없음. production URL/응답 접근 증거 없음 | 실제 응답에서 CSP·frame-ancestors/X-Frame-Options·nosniff·HSTS·Referrer-Policy·민감 캐시 검증 P1. Vercel 기본 헤더/대시보드 설정 부재를 추정하지 않음 |
| N7 Auth와 앱 세션의 분리 | 확인: 두 credential, refresh와 앱 idle 별개, local logout/서버 revoke 실패 구분 | 장애·복구·다중 탭·동시 login에서 잔여 token/UX 불일치 가능. 경계 재사용·새 tab·로그아웃 장애 검사 P2; 운영 세션 임의 종료 금지 |
| N8 운영 관제/의존성·플랫폼 설정 drift | 확인: 코드/DB/Edge/Vercel 각각 배포·환경 상태가 별도. npm audit/CVE·운영 관리계정 MFA·WAF/rate limit·로그 알림·실제 build SHA 비교 미검증 | 플랫폼 관리 경계 확장. production commit/Edge hash/config, dependency audit, 비밀 회전·접근 기록·경보 증거 확보 P1. 현재 CVE/무제한 brute force를 확인된 취약점으로 주장하지 않음 |
| N9 파기 범위 확장과 사본 | 확인: 새 DB attachment metadata/감사 snapshots/backup schema, 현재 retention은 첨부 미처리; bucket 0 | 미래 객체·감사/외부 backup의 PII 잔존 위험, 별도 lifecycle 필요 P1. 현재 존재하지 않는 Storage 객체 누출을 주장하지 않음 |

## 심사 전 우선 보완 과제 5개

1. **동의 강제를 서버까지 연결하고 가입 동의 누락을 복원한다** — C20/D26/N2.
   공식 문구·목적·대상·증적 요건을 먼저 확정하고, 미동의/만료 Partner의 직접 SELECT/RPC를
   차단하는 설계를 검토한다. 가입 동의·권한요청 동의·Partner 서약을 하나의 동의로 대체하지 않는다.
2. **MFA·IP 접근 통제를 작동 가능한 경로로 완성하고 운영 Auth 설정을 검증한다** —
   C18/C19/B11/B12. 메일/UI·신뢰 IP 및 직접 Data API 우회 방지·회복 절차 준비 후 활성화한다.
   현재 MFA/IP를 설정만 켜면 로그인 장애가 날 수 있다. SMTP, Confirm email, password 규칙,
   Redirect URL 허용목록을 확보해 시험한다.
3. **감사 범위와 독립 백업을 복구한다** — C22/D29.
   조회/인증/거절 사건과 trusted IP/UA 수집 경계를 정하고, 기록 누락 감지·별도 저장/마스킹
   export·복구 검증을 추가한다. hash chain을 WORM 또는 독립 backup으로 설명하지 않는다.
4. **보존·휴면 자동화를 운영 가능한 절차로 복구한다** — C21/D28.
   외부 scheduler가 있는지 확인하고, 없으면 service 경계가 있는 scheduler·배치 retry·감시를
   설계한다. Activity 삭제 대 비식별화, 첨부/감사/backup 잔존 범위를 공식 보존 정책과 맞춘다.
5. **독립앱 운영 보안 증빙과 설명을 정합하게 만든다** — C25/B17/E33/N1/N4/N6/N8.
   운영 URL/헤더·Vercel 환경변수/실제 artifact·Auth/Edge 설정·플랫폼 계약/backup 증거와
   사내 공식 체크리스트를 확보한다. 화면의 미작동 MFA/IP/자동파기·Base44 설명을 현황으로
   사용하지 않는다. 미검증 항목을 통과로 표시하지 않는다.

이는 구현 제안이며 이번에 적용한 변경은 아니다. DB 구조·인증 경계·배포 변경은
각각 구체적 설계/검증 계획을 작성한 뒤 별도 작업으로 수행해야 한다.

## 아직 필요한 자료와 검증 한계

- 사내 공식 보안/개인정보 체크리스트, 원래 승인 요구사항·예외·보존/파기 정책·심사 등급.
- Base44 운영 버전·배포 설정·entity policy 적용 증거·스케줄 실행 이력·백업 파일/복구 증거.
  소스의 workflow 정의는 실제 서비스 실행 증거가 아니며, 무토큰 스케줄 요청을 허용하는
  원본 functions의 플랫폼 호출 보호는 소스만으로 확정하지 못했다.
- 현재 Vercel production URL/프로젝트 접근·환경변수 분류·응답 헤더·배포 commit 및 실제 bundle.
  로컬 `.vercel/project.json` 없음. 이 조사에서 URL이 제공되지 않아 runtime HTTP 검사를 하지 못했다.
- Supabase Auth SMTP/Confirm email/password/redirect/rate limit, Edge deployed artifact와
  secrets 존재/회전·Origin allowlist의 운영 증빙. 키/비밀번호 자체는 보고서에 필요하지 않다.
- 외부 scheduler/관제·관리자 MFA/플랫폼 접근 권한·암호화/리전·backup RPO/RTO·복구 훈련 자료.
- 서약 없는 API 접근은 이전 실제 인증 검사와 이번 동의 집계로 확인했다.
  이번에는 계정 생성·로그인·MFA 잠금 유발·운영 retention/revoke를 수행하지 않았다.
  운영 SMTP/파일 다운로드/시간 경계·네트워크 장애·브라우저 UI의 완전 E2E도 수행하지 않았다.

기존 `docs/live-ticket-access-verification-20261012.md`는 이전 작업의 미추적 보고서로 보존했다.
이번 작업의 변경은 본 보고서 추가뿐이며 code/migration/운영 DB/계정/세션을 변경하지 않았다.
