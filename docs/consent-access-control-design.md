# 동의·서약 접근 통제 분석 및 로컬 수정안

작성: 2026-10-12. 기준: [보안 전환 차이 보고서](security-migration-gap-analysis.md), Git `7e82465`.
**2026-10-12 활성화 지시 반영.** 이전 가입 동의 비활성 유지 조건은 철회됐다.
가입 동의 3종은 Base44 원문과 필수 조건을 확인하여 `base44-v1`으로 모두 활성화한다.
운영 적용·실제 인증 검증·배포의 최종 결과는 [운영 검증 기록](consent-production-verification-20261012.md)을 따른다.

## 1. 발굴한 기존 정책과 실제 구현

공식 사내 동의 문구/요건 문서는 제공되지 않았다. 아래는 Base44 export의 구현 사실이다.
이 자료만으로 법적 동의 유효성, 회사 정책의 현재 승인 상태를 확정하지 않는다.

| 구분 | 기존 화면·시점·필수 항목 | 저장·접근 강제의 실제 근거 | 독립앱 변경 전 |
|---|---|---|---|
| 회원가입 동의 | Register의 가입 전 checkbox 3개: 개인정보 이용·제공, 개인정보 처리위탁, 1인1계정·계정공유 금지. 3개 모두 체크해야 submit 버튼 활성화 | `legacy/base44/src/pages/Register.jsx`: allConsented UI gate. 실제 register payload는 email/password이고 동의 항목/version/time 저장이나 Auth endpoint 강제 근거 없음 | Registration에서 3개 checkbox도 사라짐 |
| 권한 요청 동의 | ConsentModal의 요청 제출 직전 2개: 보안 알림·권한 확대 책임 이해, 개인정보 처리 지침 | RoleRequest에 aggregate `consent_agreed`/`consent_agreed_at` 기록. 항목별 version/text hash 증거는 없음. 권한 요청 서버는 true 요구 | 현재 UI 2개와 submit_role_request의 true/서버 시각 유지. 이번 수정에서 새 필수 문구로 확대하지 않음 |
| Partner 연간 개인정보보호 서약 | 업무 화면 진입 전 6개 조항의 서약 전체에 동의. 업무 목적 외 이용·제3자 제공·계정 공유·외부 유출 금지, 종료 시 권한 반납 등. v1.0, 1년 | export `src/pages/PrivacyConsent.jsx`, PrivacyConsent entity에 user_id/name/email/company/date/valid_until/version. 당시 브라우저가 ID·시각·만료 계산. entity create=true, Admin 변경/삭제. AuthContext는 조회 실패 시 valid=true; 서버 업무 API의 일관된 gate 증거 없음 | record_privacy_consent가 사용자/조직/시각을 서버 결정, version/1년 검증은 강화됐으나 ProtectedRoute만 업무 접근 제한. 직접 API는 미동의 Partner도 조회 가능 |

현재까지 확인한 차이는 '서약'과 '가입 동의'와 '권한 요청 동의'를 한 boolean으로
대체할 수 없다는 것이다. Partner의 연간 서약은 원본 문구를 그대로 유지했다.
Git의 기존 PLEDGE_TEXT와 migration seed의 **원문 문자열 일치**를 확인했다.
1년 유효기간도 기존 독립앱의 UTC/inclusive date 기준을 유지한다.
가입 동의의 새로운 만료기간이나 Company의 연간 서약 의무는 만들지 않았다.

## 2. 수정 전·후 서버 경계

수정 전 app-auth는 검증된 Auth JWT로 앱 세션을 발급하고, RLS는 추가 세션과
조직/Business 관계를 검사했다. 동의 status RPC는 UI만 호출했기 때문에
유효한 JWT+앱 세션을 가진 미동의 Partner가 직접 Ticket API를 호출할 수 있었다.

수정안은 **인증 자격과 업무 이용 자격을 분리**한다. app-auth·Auth의 로그인/메일/MFA/
IP/세션 정책은 수정하지 않았다. 미동의 상태에서도 앱 세션을 발급받아 본인 문서를
확인하고 동의할 수 있어야 하므로, has_valid_app_session 자체에 서약 조건을 넣지 않았다.

`has_required_privacy_consent()`는 현재 사용자·활성 조직·기존 유효 앱 세션과
서버 정책/동의 이력을 확인한다. SQL의 owner-only pure reader를 사용하며 상태 RPC,
RLS table read를 재귀 호출하거나 polling으로 idle 시간을 연장하지 않는다.

- 승인된 Partner Admin/Operator: 현재 정책 version + 현재 조직의 유효한 연간 서약 필요.
- Company Admin/Operator: 기존 연간 서약 적용 대상 아님. 업무 gate에서 계속 면제해
  기존 관리자 복구 경로와 일반 Company 업무를 보존한다.
- Guest: 연간 서약은 새로 요구하지 않는다. 기존 조직/역할 권한상 업무 데이터는 여전히 0행.
- 별도로 활성화한 required signup 정책이 있으면 Guest/Partner의 해당 정책 이력도 검사한다.
  migration에서는 가입 동의 3종이 모두 enabled/required다. 적용 시각 이후 가입자에게
  요구하며 기존 계정에는 새 가입 증적을 소급 요구하지 않는다. 면제는 동의 기록이 아니다.

can_access_business/can_access_ticket의 AND 조건으로 동의를 추가하여 기존 write RPC의
Security Definer 경계에도 적용했다. can_manage_organization도 Partner Admin의 동의가
없으면 false이므로 타 사용자 관리·Partner 정보 수정이 차단된다. 본인 프로필은 예외다.
알림 읽음 RPC에는 별도 guard를 추가했다.

업무 테이블 7종에는 **RESTRICTIVE SELECT AND gate**를 추가했다. 기존 permissive policy가
늘어나도 이 gate를 OR로 우회하지 못한다. 기존 RLS/조직 범위/직접 DML 금지는 유지한다.
RLS SELECT 차단은 빈 배열/집계 0으로 나타나며, 변경 RPC는 기존 forbidden 또는
privacy_consent_required 오류로 거절한다. 동의했다고 외부 조직 Ticket이 열리는 것은 아니다.

## 3. 업무 API 차단과 복구 API 허용 목록

인증/메일 확인/계정 상태/앱 세션 검증은 기존과 동일하게 별도로 필요하다.
'허용'은 anon에게 계정 데이터를 허용한다는 의미가 아니다.

| 영역 | 미동의·철회·만료 Partner 처리 | 구현 경계 |
|---|---|---|
| Ticket 목록·ID 상세·집계/Dashboard | 차단, 0행 | tickets RLS + can_access_ticket |
| Business·서비스 관계·Partner 업무 상세 | 차단 | businesses/service_partners/partner_details RLS + can_access_business |
| Activity·내부 메모·첨부 메타데이터 | 차단 | activities/ticket_attachments RLS, 기존 Ticket·Company 내부메모 조건 유지 |
| 사용자 알림 목록·읽음 처리 | 차단 | notifications RLS + mark_notifications_read guard |
| Ticket 생성/상태/댓글/주소/담당자/Partner 배정 | 차단 | 기존 RPC의 scope 검사에 동의 AND; Company 전용 역할 조건도 유지 |
| Partner Admin의 타 사용자 관리/Partner 정보 수정 | 차단 | can_manage_organization; Company 관리 경로 유지 |
| 본인 profile·본인 조직 identity | 허용 | 기존 own policy 및 추가 세션 gate 유지. 타 사용자 profile은 차단 |
| 본인 동의 이력·상태·문서 | 허용 | own privacy_consents policy + get_my_consent_requirements; 사용자 인자 받지 않음 |
| 동의 제출·철회 | 허용 | record_policy_consent / withdraw_policy_consent가 본인만 처리 |
| 본인 이름/표시명/직책 수정 | 허용 | 기존 update_my_profile, role/org/account_status 변경 불가 |
| 본인 권한 요청·상태/조직 선택 옵션 | 허용 | 기존 submit_role_request/list_role_request_organizations 및 기존 옵션 범위 유지; 요청 자체는 권한 부여 아님 |
| Auth 로그인/메일 확인/복구·app-auth activate/validate/logout·touch | 기존 조건으로 허용 | 인증 강제·계정 상태·MFA/IP/idle/absolute expiry 완화 없음 |
| 가입 정책 문서 조회 | 활성 signup 문서만 anon 허용 | list_signup_consent_policies; 사용자 데이터·비활성 draft 없음 |
| 직접 INSERT/UPDATE/DELETE 동의/정책 | 허용하지 않음 | 직접 DML policy 추가 없음. broad grant에서도 RLS로 거절 |
| 실제 Storage 파일 다운로드 | 이번 구현 범위 아님 | 기존 bucket/다운로드 기능이 없음. 향후 signed URL/객체 접근에 동일 gate 필요 |

## 4. 증빙·버전·철회 설계

### 정책 문서

새 `consent_policy_versions`는 kind/version/title/문서 원문/SHA-256을 보관한다.
본문·version·title·hash·created_at은 trigger가 수정/삭제를 거절한다. 다른 문구는 새 version을
만들어야 한다. 서버가 hash를 계산한다. version별 enabled/required 및 signup 전환 대상 cutoff는
관리자 클라이언트가 변경할 수 없으며 운영 승인 후 서버 관리 작업으로만 변경할 수 있다.
기존 system_settings의 privacy_pledge_version이 현재 서약 version의 기준이다.

v1.0은 기존 문구 그대로 활성화한다. 기존 설정 version이 v1.0이 아니면 migration이
`pledge_document_requires_review`로 전체 transaction을 중단한다. 알 수 없는 정책 본문을
자동으로 추정하거나 다른 version에 기존 텍스트를 붙이지 않는다.

가입 동의 3종은 Base44 Register의 정확한 원문과 `[필수]` 표시 및 allConsented 조건을
확인해 `base44-v1`, enabled=true, required=true로 복원한다. 신규 가입자는 3종 모두의
version/hash와 명시적 boolean true를 전달해야 한다. 누락되면 Auth INSERT 전체가 rollback된다.
기존 계정은 migration 시각 cutoff 이전의 가입자로서 면제되며 동의 기록을 만들지 않는다.

### 동의 증적

기존 privacy_consents에 아래 nullable 증거 필드를 추가한다. 기존 행을 backfill/수정하지 않는다.

- policy_text_snapshot, policy_text_hash: 그 시점 서버의 실제 문서와 hash.
- auth_user_id_snapshot: 서버가 확인한 Auth identity. 기존 profile FK/organization_id도 유지.
- source: authenticated_rpc 또는 auth_signup.
- withdrawn_at: 원문·원 동의 시각을 덮어쓰거나 삭제하지 않고 철회 시각만 서버 기록.

`record_policy_consent(kind,version,text_hash,agreed)`는 사용자 ID·동의 시각·만료일을
클라이언트에서 받지 않는다. 표시한 문서의 version/hash와 서버 current policy가 다르거나
agreed가 true가 아니면 거절한다. 원문은 클라이언트 전달값이 아닌 서버 catalog에서 복사한다.
제출/철회는 동일 transaction의 감사 사건도 남긴다. 과거 hash chain의 독립 보관/WORM 문제는
별도 보완 과제로 남는다. 이는 법적 전자서명/불가부인성 보장이나 클릭 자체의 물리적 증명은 아니다.

새 Signup flow는 공개된 정책 문서를 읽고 체크한 kind/version/hash/boolean만 signUp metadata에
전달한다. Auth INSERT trigger가 현재 서버 정책과 비교해 receipt를 저장한다. 활성 required
정책의 미체크/문서 불일치이면 Auth/profile INSERT까지 rollback되어 직접 Auth API 우회가 막힌다.
role/org/status metadata는 기존대로 무시하고 guest/대기 profile만 생성한다. 중복 kind와
문자열 'true'도 거절한다. source=auth_signup은 이메일 확인 전의 가입 신청 선언이며,
이메일 소유 확인을 이미 마친 authenticated_rpc과 같은 증거로 과장하지 않는다.
업무 진입은 여전히 이메일 확인·정상 app-auth·관리자 승인이 필요하다.

확인되지 않은 가입 동의 만료기간을 만들지 않기 위해 valid_until은 signup kind에서 NULL을
허용하고 annual privacy_pledge에서만 1년/필수 만료일을 강제한다. Signup 동의는 활성 정책의
version·철회 상태로 판정한다. 별도의 갱신 주기가 필요하면 회사가 결정해야 한다.

### 유효성·철회

서약은 profile + 조직 + kind + version에 해당하는 **최신 이력**을 판정한다.
최신 이력을 철회하면 이전 미철회 receipt로 되돌아가 통과하지 않는다. 다시 동의하면 새 receipt가
생겨 원래 조직 권한 범위만 복원된다. 만료/미래 시각/다른 조직/무기록 version은 접근 권한이 아니다.
정책 version이 바뀌면 기존 세션을 폐기하지 않고 다음 업무 요청부터 재동의를 요구한다.
다른 사용자의 receipt ID로 철회할 수 없다.

기존 독립앱의 유효한 typed `privacy_pledge/v1.0` receipt는 hash가 없더라도 계속 인정한다.
원문을 동일하게 유지했고, 이미 서버가 기록한 일자/조직/만료 조건을 다시 검사한다.
기존 receipt에 현재 본문·hash를 덧씌워 당시 증빙이 있었던 것처럼 만들지 않는다.
consent_type/organization_id가 없는 Base44 원시 legacy 기록은 임의로 인정하지 않는다.
실제 존재 여부·이관 근거를 적용 전 읽기 전용 inventory로 확인해야 한다.

## 5. 프런트 동작 및 변경 파일

- AuthContext는 get_my_consent_requirements 결과를 유일한 UI 동의 상태로 사용한다.
  정책 조회 오류는 업무 진입 성공으로 취급하지 않는다.
- PrivacyConsent는 서버에서 제공한 문구/version을 표시하고 그 hash로 제출한다.
  문서가 없거나 변경됐으면 체크만으로 제출하지 못한다.
- ProtectedRoute는 미완료면 업무 화면 대신 동의 화면을 표시하되, `/my`는 인증된 사용자의
  복구 경로로 허용한다. Guest의 승인 대기 및 업무 데이터 금지는 유지한다.
- Account는 최근 50개 본인 이력/version/time/legacy 증거 공백을 표시하고 명시적 철회 확인을
  제공한다. 철회·재동의 이후 server status를 다시 읽는다. 계정 관리 자체는 유지한다.
- Registration은 활성화된 signup 정책만 수집한다. 정책 조회 실패·필수 미체크 시 제출하지
  않고, 서버가 승인하지 않은 정책을 코드에서 required=true로 만들지 않는다.

| 파일 | 변경 |
|---|---|
| [migration](../supabase/migrations/20261012000000_enforce_partner_consent.sql) | catalog·증거 필드·가입 trigger·동의/철회 RPC·업무 RLS/RPC guard·ACL; 로컬 신규 migration만 작성 |
| [AuthContext](../src/lib/AuthContext.jsx), [ProtectedRoute](../src/components/ProtectedRoute.jsx) | server requirements 반영, 본인 계정 예외 |
| [PrivacyConsent](../src/pages/PrivacyConsent.jsx), [consent helper](../src/lib/consent.js) | 서버 문서 표시·version/hash 제출 |
| [Account](../src/pages/Account.jsx), [ConsentManagement](../src/components/users/ConsentManagement.jsx) | 증적 확인·철회·재동의 경로 |
| [Registration](../src/pages/Registration.jsx) | 정책 기반 체크와 signup metadata |
| [DB 회귀](../tests/consent-authorization.test.mjs), [제출 계약](../tests/consent-submission.test.mjs), [UI 회귀](../tests/consent-ui.test.mjs) | 직접 RLS/RPC·Auth INSERT 및 실제 route/가입 handler 검사 |

app-auth/기존 migration/역할·조직 membership/기존 관리자 코드는 수정하지 않았다.

## 6. 테스트 계정별 시나리오와 결과

**실제 원격 계정이 아닌 격리 PGlite PostgreSQL fixture**다. authenticated role,
JWT subject 및 앱 session header로 실제 SQL/RLS/RPC를 실행한다. owner/service_role로 읽은
성공을 사용자 접근 성공으로 판정하지 않는다. Auth trigger는 격리 auth.users INSERT로
검증하며 실제 Supabase Auth HTTP/메일/브라우저 종단 간 성공을 주장하지 않는다.

| fixture | 정상 상태 | 미동의/철회/정책변경 상태의 예상·검증 |
|---|---|---|
| 101 Company Admin | receipt 없어도 전체 3개 Ticket·관리자 범위 유지 | Partner 정책 version 변경 중에도 전체 3개 조회 |
| 102 Company Operator | receipt 없어도 전체 3개 Ticket | 새 서약 의무 없음, 기존 조직 권한 유지 |
| 103/104 BP Admin/Operator | 동의 후 연결 Business의 배정/미배정 Ticket 2개 | 업무 7개 table 0행, 변경 RPC 7종 거절. Admin의 Partner 정보·다른 사용자 role/정지 변경도 거절 |
| 105/106 SP Admin/Operator | 동의 후 자기 조직 배정 Ticket 1개 | 미동의 업무 read/write 거절; 동의 후 외부 Business Ticket은 여전히 0행 |
| 107 Guest | 연간 서약 요구 없음·업무 접근 없음 | 본인 계정/요청 경로 유지. signup 정책 활성 시 별도 signup 동의 gate |
| 108 다른 Partner Admin | 기존 typed v1.0 receipt로 원래 범위 1개 유지 | 신규 version/문서 누락이면 차단. 새 signup required 정책의 미동의·철회 시에도 차단 |
| 신규 signup fixture | 정확한 활성 정책 hash/boolean이면 guest+server receipt 생성 | 누락/옛 hash/문자열 true/중복 kind는 Auth 생성 rollback, metadata role=admin도 무시 |

추가 검사: 유효 세션을 그대로 둔 채 철회 후 다음 read/write 차단, 이전 valid receipt로
fallback 금지, 재동의 복원, 기간 만료/미래 날짜/조직 불일치/typed 정보 없는 legacy 거절,
타인 철회 및 직접 receipt DML 거절, permissive read policy를 추가해도 restrictive gate 유지,
signup 신규 사용자 cutoff가 과거 정상 사용자에게 가짜 receipt를 만들지 않음,
정책 문서 수정 거절, 상태 polling이 idle 시간을 늘리지 않음, private helper ACL.

UI 회귀는 실제 컴포넌트를 transpile해 handler/route를 실행한다. 정책 로딩 실패·미체크·
직접 URL·Guest·본인 계정 경로와 정확한 signup payload를 검사했다. 브라우저 screenshot
검증이나 이메일 UI E2E를 대신하지는 않는다.

검증 결과:

- 신규 동의 관련 **40개 통과** (DB/RLS/Auth trigger suite 포함).
- 전체 `npm.cmd test` **101개 통과**, Edge 인증 회귀 **18개 통과**, 총 **119개 통과**.
- `npm.cmd run lint`, `npm.cmd run build`, `git diff --check` 통과.
- build의 기존 caniuse-lite 노후/큰 bundle 경고는 남아 있다. 무관한 dependency 변경 없음.
- migration 전후 fixture의 profile/조직/Business/Ticket/session 및 기존 receipt 필드 동일.

## 7. 기존 사용자 영향과 전환 방안

활성화 지시를 반영한 전환 영향:

1. 기존 Company 관리자·Operator는 Partner 연간 서약 면제 유지. 역할·조직·세션을 변경하거나
   consent receipt를 인위적으로 추가하지 않는다.
2. 현재 조직의 정상 typed v1.0 서약자는 추가 서약 없이 기존 업무 범위를 유지한다.
3. 미동의/만료/조직 불일치 Partner는 직접 업무 API가 차단된다. 이는 버그 제거에 따른
   의도된 변화다. 로그인·본인 계정·동의 제출은 유지한다. 일괄 grace나 가짜 동의는 만들지 않는다.
4. `required_for_profiles_created_at_or_after`는 신규 migration의 transaction 시각이다.
   이후 계정 생성은 동의 3종이 모두 있어야 Auth trigger를 통과한다. 기존 가입자는
   새 가입 동의의 적용 대상이 아니며, 과거 동의 증적을 만들어 넣지 않는다.
5. 구형 `record_privacy_consent(true)`는 표시 문서/version이 바인딩되지 않아 명시적으로
   `consent_document_required`로 거절한다. 구형 프런트의 미동의 사용자 화면은 새로고침이
   필요하다. 기존 유효 서약자는 계속 조회 가능하지만 새 동의는 새 프런트가 필요하다.
6. DB 구조 변경은 새 table/index/columns, valid_until의 signup NULL 허용, 정책/RPC 및
   signup trigger 교체를 포함한다. 전체 transaction이며 기존 migration 재실행은 금지한다.

운영 실행 절차:

- 먼저 읽기 전용 preflight: migration 이력, version=v1.0/기존 원문 일치,
  활성 Company Admin 보존, Partner의 정상/미완료/legacy/null 조직·type 분포를 집계한다.
- 로컬 활성 정책 회귀 후 신규 migration만 dry-run/apply하고 실제 Auth/app-auth JWT 경로를 검증한다.
- 승인된 점검 시간에 DB 신규 migration을 먼저 적용하고 프런트를 연이어 배포한다.
  새 프런트는 신규 RPC에 의존하므로 DB보다 먼저 배포하면 로그인이 실패할 수 있다.
  구형 탭의 서약 제출 차단·새로고침 안내 및 운영 담당자 복구 계획을 준비한다.
- 적용 후 Company 복구 경로·정상 Partner·미동의/철회/재동의의 실제 API smoke를 수행한다.
  임의 운영 계정/세션 대신 전용 테스트 계정을 사용한다. 기존 세션은 일괄 폐기하지 않는다.
- 장애 복구 시 앱만 구버전으로 되돌리면 서약 제출 호환성이 복구되지 않음을 유의한다.
  서버 gate를 무조건 비활성화하는 rollback은 원래 API 우회 문제를 재개방하므로,
  승인된 forward-fix/동의 UI 복구 절차를 별도 준비한다.

## 8. 운영 적용 전 반드시 결정할 사항

1. 가입 동의 3종의 승인 문구·수집/제공/위탁 대상·필수 여부·정책 version과 적용 대상.
   1인1계정 checkbox를 사람 단위 중복계정 강제 구현으로 오해하지 않는다.
2. 신규만 적용할지 기존 Partner도 재동의할지, signup cutoff/공지/기한.
   현재 Company business gate의 면제 유지 범위도 공식적으로 확인한다.
3. v1.0 문구와 1년 기준의 계속 사용 승인, 다음 version의 시행 시점과 재동의 공지.
4. legacy receipt 인정 범위: typed v1.0은 유지하되 원문 증빙 부재를 명시할 것인지,
   type/org/version 불명 기록에 재서약을 요구할 것인지. 현재안은 불명 기록에 권한을 주지 않는다.
5. 철회 효과/동의 기록 보존기간·열람/증빙 제출 절차. 이번안은 업무 차단과 receipt 보존이며,
   계정 삭제·기존 업무 데이터 삭제·동의 철회 법적 효과의 전부를 자동 처리하지 않는다.
6. Signup required 정책 활성화는 Auth INSERT 전체(관리자 provisioning/OAuth 등 포함)에
   영향을 줄 수 있다. 현재 self-registration 외 생성 경로의 metadata·회복/오류 처리도 확인해야 한다.
7. 정책 catalog 운영 변경 권한·감사 절차, 서비스 제공자와 동의 증적의 보관/복구 요구.
   server key/DB 소유자는 RLS 밖의 관리 자격이므로 WORM·독립 보관 요구는 별도 검토한다.
8. Storage/미래 신규 업무 RPC에 동의 gate를 반드시 연결하는 개발 규칙과 실제 원격 회귀 일정.

가입 3종 원문·필수 조건의 복원과 운영 반영은 이번 사용자 지시로 승인됐다.
공식 정책의 법적 적정성·향후 정책 변경·증적 보존기간은 별도 회사 결정 사항이다.
원문이나 필수 조건이 확인되지 않거나 인증 장애·예상 밖 접근 허용이 발견되면 배포를 중단한다.
