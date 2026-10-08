# 조직 및 내부 역할 전환 검토 (2026-10-08)

신규 migration `20261008000003`은 프로젝트 `bqtlopwgjvvugalktldr`에 적용 완료했으며 로컬·원격 이력 21개가 일치한다. 사용자 지시에 따라 별도 백업은 생략했다. 적용 전후 전체 행 지문 비교로 기존 관리자, 사용자·조직·Business·Ticket·Activity와 앱 세션의 보존을 확인했다. 원격 함수 33개 및 RLS/실행 권한을 검증했고, 추출한 원격 정의의 격리 DB 테스트 41개가 통과했다. 원격 읽기 전용 검사에서도 앱 세션 없는 요청의 데이터 조회가 차단됐다. Edge/Vercel 배포는 하지 않았다. 개인정보가 포함된 조사 원본은 Git에서 제외된 `supabase/.temp`에 있다.

## 근본 원인

기존 `validate_profile_role_organization`은 admin/operator를 operator 조직에만, partner_admin을 partner 조직에만 허용했다. UI도 역할을 먼저 선택하고 조직 목록을 제한했다. `can_access_ticket/business`, RLS, 관리 RPC, 내부 메모 및 감사 조회가 admin/operator라는 역할만으로 전역 접근을 허용했다. 이 상태에서 UI 제한만 제거하거나 partner_admin을 admin으로 바꾸면 조직 격리가 깨진다.

## 최종 모델과 접근 규칙

`profiles.organization_id`의 필수 단일 FK를 유지한다. `organizations.type='operator'`는 Company, `'partner'`는 Partner이다. 가입 대기 고정 조직 `10a8e084-c396-4a97-b301-c4ef4aa59d71`은 type이 operator여도 Company 권한을 갖지 않는다.

`partner_details.partner_type`은 제조/유지보수/설치 등 업무 분류이므로 Business/Service 분류로 바꾸지 않는다. `service_partners(business_id,partner_organization_id)`의 유일 관계마다 `access_level`을 사용한다. 같은 조직은 여러 Business에 서로 다른 수준으로 연결될 수 있다. 조직 테이블/type 추가 없이 이 구조를 재사용한다.

| 소속/관계 | Admin과 Operator의 Ticket 범위 | 사용자·권한 관리 |
|---|---|---|
| Company | 전체 Ticket | Admin만 전역 관리 |
| Partner, business 관계 | 해당 Business의 전체 Ticket | Admin만 자기 조직 관리 |
| Partner, service 관계 | 해당 Business에서 자기 조직에 배정된 Ticket | Admin만 자기 조직 관리 |
| 연결 없는 Partner | 없음 | Admin의 자기 조직 사용자 관리만 가능 |
| Guest/승인 대기/비활성·정지 | 없음 | 없음 |

일반 내부 역할은 `admin/operator`, 미승인은 `guest`이다. Partner Admin도 `role='admin'`이며 전역 관리자 여부는 활성 Company 소속과 role을 함께 검사한다. Ticket 접근 범위는 내부 역할에 따라 넓어지지 않는다.

목록/상세/Activity/첨부/Business 상세의 Ticket/집계는 공통 `can_access_ticket` RLS를 통과한다. Dashboard는 이 RLS를 통과한 Ticket만 집계하며 별도 전역 집계 API는 없다. 상태/댓글/주소/담당자 RPC도 같은 범위로 검사하고 잠금 후 재검사한다. 내부 메모와 열람 이력은 Company만 볼 수 있다. 파트너 Admin의 담당자 인계도 자기 조직 담당자에 한하며 Company Admin은 전역 인계가 가능하다.

파트너 배정 변경은 Company 업무 역할에 한정한다. 신규 Ticket은 Company 또는 해당 Business의 business 관계 Partner만 생성한다. service 관계 사용자가 직접 Ticket을 생성하고 자기 조직에 배정하여 권한을 만드는 경로는 차단한다. Business 생성/수정은 Company Operator도 가능하다. Business 연결/해제/접근 수준/SLA 변경은 조회 권한에 영향을 주므로 Company Admin만 가능하다. Partner Admin은 자기 조직의 파트너 상세 정보와 사용자만 관리할 수 있다. 알림은 자신의 알림 중 현재 Ticket 범위에 들어오는 것만 조회/읽음 처리한다.

신규 가입은 기존 trigger 그대로 guest/대기 조직으로 생성한다. 요청은 조직 → 내부 역할 → 동의 순이며 자동 승인하지 않는다. 최초 대기 조직에서 실제 조직으로 이동하는 승인은 Company Admin이 수행한다. Partner Admin은 이미 자기 조직에 속한 사용자의 같은 조직 요청만 승인/거절한다. 요청 당시 소속뿐 아니라 현재 소속도 검사한다. 파트너의 개인정보 동의 화면은 Admin/Operator 모두에 적용한다. Supabase Auth, app-auth 요청/응답, 세션 헤더/유효기간/MFA/IP 검증은 유지한다. Edge 코드 변경/배포는 필요하지 않다.

## 파일과 데이터 전환

- `supabase/migrations/20261008000003_separate_organization_roles.sql`: 조직 범위 함수, RLS, 관리 및 Ticket RPC, 전역 관리자 보호, EXECUTE 권한.
- `src/lib/roles.js`, `userAccessForm.js`, `ticketVisibility.js`, `AuthContext.jsx`: 조직과 역할 분리, 확인되지 않은 소속의 표시 필터 실패 폐쇄, 실제 조직 조회.
- `src/components/users/UserAccessRow.jsx`, `RoleRequestForm.jsx`, `src/pages/UserManagement.jsx`: 조직 우선 선택, 실제 Business별 접근 범위 표시, 양쪽 내부 역할, 저장 오류/중복 요청 처리.
- ProtectedRoute, Sidebar, Business/Partner/Ticket/감사/설정 화면: Company 기능과 조직 내부 관리 기능 분리. Ticket 생성 옵션도 관계에 맞게 제한한다.
- `tests/organization-authorization.test.mjs`: PGlite PostgreSQL로 실제 migration/RLS/RPC 실행. `organization-presentation.test.mjs`, `user-access-row.test.mjs`: 메뉴/표시 필터/실제 저장 핸들러 회귀 테스트. PGlite는 개발 의존성에만 추가했다.
- TopBar의 기존 미사용 import는 lint 통과를 위해 제거했다. 기존 미커밋 Vite 실행 설정 변경도 유지했다.

migration은 하나의 트랜잭션에서 **기존 partner_admin 프로필의 role만 admin으로 매핑**한다. 조직 ID, Auth ID, 상태, 이름, updated_at, Business 관계와 Ticket은 수정하지 않는다. 기존 admin/operator/guest 프로필은 수정하지 않는다. 세션을 일괄 폐기하지 않는다. 과거 요청/감사 snapshot도 바꾸지 않는다. legacy partner_admin 대기 요청은 승인 RPC에서만 admin으로 해석한다. 유효하지 않은 legacy 파트너 소속, 예상 외 permissive 정책, 앱 세션 정책 기준 불일치 또는 활성 Company Admin 부재 시 migration 전체가 실패한다.

명시적인 권한/조직 변경과 승인 때에는 기존 동작대로 **대상 사용자**의 세션을 폐기한다. 마지막 활성 Company Admin은 강등/비활성화뿐 아니라 Partner 조직으로 이동할 때도 보호한다. Partner Admin은 마지막 전역 관리자를 대체하는 인원으로 계산하지 않는다.

## PartnerDesk Test Operator 조사

| 항목 | 읽기 전용 확인 결과 |
|---|---|
| ID | `7683b116-4b6e-4e0b-b343-dd06b6aa40e1` |
| type / 상태 | operator / 활성: 현재 Company로 해석되는 운영사 조직 |
| 생성 | 2026-10-06 07:52:09 UTC, created_by_profile_id 없음, legacy_base44_id 없음 |
| 연결 사용자 | 1명, 기존 전역 admin `jerald.cha716`, 활성 |
| 직접 Business 파트너 관계 | 0개. Company 소속 FK는 Business에 없으며 service_partners는 Partner 조직을 참조함 |
| 관련 Business | 소속 admin이 생성한 Business 1개 |
| 관련 Ticket | 소속 admin이 생성한 Ticket 2개, 모두 파트너 미배정, 담당자 미배정 |

조직명, admin의 테스트 이름, 조직 생성 약 37초 뒤 최초 admin 생성, legacy ID/생성자 부재는 초기 수동 테스트/부트스트랩 조직이라는 추정을 뒷받침한다. 생성 경로를 확정할 기록은 없다. 현재 유일한 전역 admin과 업무 데이터가 연결되어 있으므로 폐기 가능한 테스트 찌꺼기로 판단해서는 안 된다. 운영사 실명과 초기 테스트 데이터 정리 여부는 별도 결정할 사항이다. 이번에는 삭제/이름 변경/소속 변경을 하지 않았다. 원격 전체 조사 시점은 프로필 2개, 조직 3개, Business 1개, Ticket 2개, service_partners 0개였다. 따라서 현재 파트너는 승인해도 Business 연결이 생기기 전까지 Ticket이 보이지 않는 것이 정상이다.

## 검증과 원격 적용 전 확인

검증 명령은 `npm.cmd run build`, `npm.cmd test`, `node --test supabase/functions/app-auth/app-auth.test.mjs`, `npm.cmd run lint`, `git diff --check`이다. DB 테스트는 실제 PostgreSQL 엔진과 인증 역할, JWT subject/session header, 전체 기존 migration을 사용하며 원격 연결을 사용하지 않는다. Company/BP/SP 각각 Admin/Operator, mixed 관계, guest/대기/정지·비활성/비활성 조직, 타 조직 조회·변경 차단, 직접 DML 차단, 조직 이동, 마지막 관리자, 승인 및 세션 보존을 검증한다.

실행 결과: 앱/DB/UI 테스트 61개와 app-auth 테스트 18개(합계 79개) 통과, production build 및 lint 통과. build의 기존 caniuse-lite 데이터 경고와 500KB 초과 번들 경고는 남아 있으며 이번 권한 수정과 무관한 패키지 업그레이드는 하지 않았다. 기존 이름의 SELECT 정책 및 세션 gate 표현식이 넓어진 상황도 fixture에서 재현하여 canonical 정책으로 복원됨을 검증한다. 예상 외 permissive 정책이나 비활성 RLS가 있으면 데이터 변환 전에 migration이 실패하는 것도 검증한다.

운영에서 실제 계정으로 브라우저 승인/로그인/조직 변경을 수행하는 검증은 이번 단계에서 하지 않았다. 적용 전에 staging 또는 검증 환경에서 6개 역할 조합의 실계정으로 목록과 직접 상세 URL, Dashboard, 댓글/상태 저장 및 사용자 관리 화면을 확인해야 한다. PGlite는 PostgREST·브라우저 통합이나 동시 트랜잭션 부하를 검증하지 않는다.

적용 전 위험/준비 사항:

1. 원격 정책/함수 drift를 다시 읽기 전용으로 확인하고 backup 및 현재 admin의 ID/조직/역할과 데이터 수를 기록한다. legacy partner_admin에 불일치 소속이 있으면 자동 교정하지 않고 원인을 해결한다.
2. **기존 `20261006000015` 파일의 승인 함수 CASE 비교 구문은 원격에서 괄호로 보완되어 있다.** 이 차이는 이번 조사로 확인했다. 이미 적용된 migration을 다시 실행하지 않는다. 격리 테스트는 이 확인된 원격 기준 구문을 메모리에서만 재현한다. 완전히 새로운 DB를 처음 설치하는 절차의 historical SQL 정합성은 별도로 정리해야 한다.
3. 역할 문자열을 사용하는 외부 소비자나 repo 밖 서비스가 있으면 partner_admin → admin과 Company 소속 검사 도입을 함께 반영한다. 원격에 추가 permissive 정책이 생겼다면 우회 가능성이 있어 신규 migration은 중단한다.
4. DB 변경과 프론트 변경을 함께 배포 계획에 포함한다. DB migration을 먼저 적용한 뒤 프론트를 배포하고 기존 브라우저를 새로고침한다. 구형 화면에서는 Partner Admin을 전역 Admin 메뉴로 표시할 수 있지만 새 DB가 전역 조회/변경을 차단한다. 새 화면만 먼저 배포하면 기존 DB가 Partner Operator/Admin 저장을 거부한다.
5. Company Operator의 Business 관계/권한 변경 버튼은 제거되는 의도적인 권한 축소다. service 관계의 Ticket 생성도 차단된다. 기존 자동화/업무가 이 동작에 의존하는지 확인한다.
6. 새 환경변수나 Supabase Auth Site URL/Redirect URL 변경은 없다. 실제 파트너 접근은 Company Admin이 기존 Business 연결/접근 수준을 검토하여 설정해야 한다. 이 작업에서는 어떤 관계도 자동 생성하지 않았다.
7. 원격 적용 후 profile 소속/상태와 Company Admin 보존, Business/Partner/Ticket 연결, 정책 13개 세션 gate, 함수 소유자/search_path/EXECUTE를 다시 비교하고 6개 역할의 접근 검증을 수행한다. 세션은 정책을 실시간 재평가하므로 일괄 폐기할 필요가 없다.
