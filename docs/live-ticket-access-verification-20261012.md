# 조직별 Ticket 실제 Supabase 검증 — 2026-10-12

프로젝트 `bqtlopwgjvvugalktldr`, 실행 식별자 `PD-RLS-20261012-661e5f`.
Git HEAD `7e82465`; 실행 전 작업 트리 깨끗함. 연결된 원격 migration 이력 21개,
마지막 `20261008000003` 확인. reset, migration 실행, 구조 변경, commit, push,
Vercel 배포 없음. 원격 인증/API 검사 126개 통과, 실패 0개.

## 1. 기존 관계와 테스트 데이터 구성

기존 Company `PartnerDesk Test Operator`에는 활성 Admin `jerald.cha716` 1명,
기존 `테스트파트너`에는 활성 Operator 1명. 가입 승인 대기 조직 포함 기존 조직
3개, Business `테스트비즈니스` 1개, Ticket 2개. 두 Ticket은 같은 Business에
있고 Partner 배정 없음. 기존 service_partners 관계 0개.
기존 Partner는 연결이 없으므로 Ticket 접근 범위가 없는 구성이 정상이다.

추가한 데이터는 모두 실행 식별자로 구분한다. 기존 조직/Business/사용자를
파트너 시나리오에 맞추어 변경하지 않았다.

| 추가 항목 | 구성 |
|---|---|
| 계정 5개 | 기존 Company의 테스트 Operator 1명; 새 BP/SP의 Admin·Operator 각 1명 |
| Partner 조직 2개 | BP `9e2378f3-5126-4de7-aa00-00d9c9bcef5f`; SP `bbb57f2e-51e0-4812-bf52-ffce2e95cf13` |
| Business 2개 | A `1d14107e-106c-4197-beb1-e1d1233ba40d`; B `13c641a4-b572-44df-8cfe-e4720724f175` |
| 관계 3개 | A–BP: business; A–SP: service; B–SP: service |
| Ticket 4개 | 아래 T1–T4 |
| Activity 8개 | 각 Ticket에 public comment 1개, internal note 1개 |
| 첨부 메타데이터 4개 | 각 Ticket에 pending 행 1개; 실제 파일/Storage 객체 없음 |

| Ticket | ID | Business | 배정 |
|---|---|---|---|
| T1 | `8b5e8503-fa48-4259-a7b1-6ae6106ffc5b` | A | SP |
| T2 | `d22e1157-a567-4cd4-bc09-77f06117f72b` | A | BP |
| T3 | `338a6585-21d2-4b88-a6dd-86b52fdd3756` | A | 없음 |
| T4 | `fd8a3537-dd5a-4467-a880-30fe4554489d` | B | SP |

계정 이메일은 `pd-rls-20261012-661e5f-<역할>@example.invalid`.
역할 식별자는 `company_operator`, `bp_admin`, `bp_operator`, `sp_admin`,
`sp_operator`. 실제 DB role은 Admin=`admin`, Operator=`operator`.
테스트 데이터/계정은 원격에 보존했다. 실행에서 생성한 비밀번호는 무작위이며
파일에 저장하지 않았다. 각 테스트의 앱 세션만 정상 logout 경로로 폐기했다.

서버 키와 관리 SQL은 테스트 계정/fixture 준비 및 읽기 전용 조사에만 사용했다.
접근 성공 판정은 공개 publishable key, 테스트 계정의 실제 Auth 비밀번호 로그인,
배포된 app-auth `activate-without-mfa`가 발급한 앱 세션으로 수행했다.
실제 HTTP Data API/RPC에 사용자 JWT와 `X-PartnerDesk-Session`을 전달했다.
JWT subject 조작, SQL SET ROLE, 수동 앱 세션 INSERT, RLS 우회 판정 없음.
서버 키/JWT/앱 토큰/비밀번호는 결과 파일에 저장하지 않았다.
브라우저 UI 조작 및 이메일 가입/승인 흐름은 이 검증 범위에 포함되지 않는다.

## 2. 역할별 접근 검증 결과표

목록 전체 ID 집합과 예상 집합의 정확한 일치를 확인했다.
각 T1–T4 및 기존 Ticket 1개의 직접 ID 상세 조회도 검증했다.

| 역할 | 예상/실제 조회 | 결과 |
|---|---|---|
| Company Operator | T1–T4 + 기존 Ticket 2개 = 전체 6개 | 통과 |
| Business Partner Admin | A의 T1·T2·T3, 총 3개 | 통과 |
| Business Partner Operator | A의 T1·T2·T3, 총 3개 | 통과 |
| Service Partner Admin | 자기 조직 배정 T1·T4, 총 2개 | 통과 |
| Service Partner Operator | 자기 조직 배정 T1·T4, 총 2개 | 통과 |

BP는 연결된 Business에서 타 Partner 배정 및 미배정 Ticket도 조회한다.
SP는 service 관계가 있더라도 타 조직 배정 T2와 미배정 T3는 조회하지 못한다.
BP의 관계 없는 Business B와 기존 Business도 목록/상세에서 제외된다.
Partner Admin/Operator는 정확히 같은 Ticket 집합을 조회했다.
Company는 fixture public/internal Activity 모두 조회했으며 Partner는 허용된
Ticket에서도 public Activity만 조회했다. 첨부 메타데이터는 허용된 Ticket만 조회했다.

## 3. 차단되어야 하는 접근 검증

| 경로 | 검증 결과 |
|---|---|
| 권한 밖 Ticket ID 직접 조회 | HTTP 200, 빈 배열 — RLS에서 행 숨김 |
| 권한 밖 Activity 조회 | HTTP 200, 빈 배열 |
| 권한 밖 ticket_attachments 메타데이터 조회 | HTTP 200, 빈 배열 |
| 상태 변경 `change_ticket_status` | 거절 |
| 댓글 추가 `add_ticket_activity` | 거절 |
| 주소 변경 `update_ticket_address` | 거절 |
| 담당자 변경 `change_ticket_operator` | 거절 |
| Partner 배정 변경 `change_ticket_assignment` | 거절 |
| 유효한 Auth JWT에서 앱 세션 헤더 제거 | 5개 계정 모두 Ticket 0행 |

각 Partner 계정에서 권한 밖 fixture Ticket마다 RPC 5종을 호출했다.
HTTP 오류와 SQLSTATE `42501`, 메시지 `ticket_not_found_or_forbidden` 또는
`role_not_allowed`를 확인했다. 배정 RPC는 Partner 역할 자체가 금지되므로
이 오류만으로 Ticket 범위 검사까지 실행됐다고 판단하지 않는다.
최종 fixture Ticket은 모두 version=1, status=new, address=NULL이며
차단 테스트의 댓글은 저장되지 않았다.

**실제 첨부파일 다운로드는 미검증.** 원격 `storage.buckets`는 0개다.
기존 첨부 업로드/다운로드 경로도 비활성이다. 메타데이터 RLS 통과를
Storage 객체나 signed URL 접근 차단 성공으로 확대 해석하지 않는다.
새 bucket이나 Storage policy는 만들지 않았다.

## 4. 발견된 오류

이번 실제 인증/API 시나리오에서 Ticket 권한 오류는 발견되지 않았다.
첨부파일 다운로드는 구성 부재에 따른 검증 공백이며 권한 오류로 확정하지 않는다.
기본 샌드박스 터미널 시작 오류가 있어 승인된 외부 실행 경로로 검증했다.

기존 프로필(관리자 포함), 조직, Business, Ticket, 기존 앱 세션 전체 행 JSON을
실행 전후 비교해 동일함을 확인했다. 기존 사용자로 로그인하거나 비밀번호/
소속/역할을 변경하지 않았고 기존 사용자 세션을 폐기하지 않았다.
테스트 fixture 추가와 테스트 계정 인증 과정의 정상 세션/로그 기록만 발생했다.

## 5. 수정 필요 여부 및 다음 단계

검증한 범위의 RLS/RPC 수정은 필요하지 않다. 코드·DB 구조 수정 없이 결과를 기록했다.
첨부 기능 도입 시 private bucket, Ticket과 객체 경로 연결, Storage RLS 및 signed
URL 발급 인증 경로를 사전 설계/보고하고 실제 파일로 권한 밖 접근을 검증해야 한다.
이후 브라우저 UI와 mixed business/service 관계의 실제 인증 회귀 시나리오를
추가할 수 있다. 테스트 데이터 정리는 별도 작업으로 처리한다.

상세 HTTP/SQLSTATE 검사 결과와 fixture UUID는 Git 제외 파일
`supabase/.temp/live-ticket-access-results.json`, 실행 스크립트는
`supabase/.temp/live-ticket-access.mjs`에 있다. 결과 JSON은 126개 검사 증거를
포함하고 인증 비밀을 포함하지 않는다. 재실행 시 새 식별자로 fixture를 추가하므로
중복 실행 전 남아 있는 테스트 데이터를 확인해야 한다.
