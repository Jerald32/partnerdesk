# 동의·서약 운영 활성화 검증

실행일: 2026-10-12. 대상 Supabase: `bqtlopwgjvvugalktldr`.
사용자는 가입 동의 3종 비활성 유지 조건을 철회하고 원본 복원·신규 migration 적용·main push·Production 확인을 승인했다.
이 기록은 [보안 차이 조사](security-migration-gap-analysis.md)의 조사 시점 이후 변경이며, 회사의 공식 보안 심사 통과를 의미하지 않는다.

## 원본 확인 및 활성화

근거: `legacy/base44/src/pages/Register.jsx`의 세 항목, `[필수]` label,
`allConsented = consents.privacy && consents.delegation && consents.oneAccount`와 가입 버튼 조건.

| 정책 | 확인된 Base44 원문 | 버전 / 현재 설정 |
|---|---|---|
| 개인정보 이용·제공 동의 | 서비스 제공을 위해 개인정보를 수집·이용·제공하는 것에 동의합니다. | base44-v1 / 활성·필수 |
| 개인정보 처리위탁 동의 | 서비스 운영을 위해 개인정보 처리를 위탁하는 것에 동의합니다. | base44-v1 / 활성·필수 |
| 1인 1계정 사용 및 계정공유 금지 확인 | 본 계정은 본인만 사용하며, 타인과 공유하지 않을 것을 확인합니다. | base44-v1 / 활성·필수 |

서약은 기존 v1.0의 6개 조항을 그대로 유지한다. 원문 SHA-256:
`ede2ccc4852891da8683dc544640f9ada6ec9f3ac91226b5d82b530b8a0171b1`.
필수·원문 일치 및 해시는 로컬 테스트와 서버 정책 조회에서 검증한다.
별도 법률 문서나 미확인 제공·위탁 대상의 내용을 임의로 추가하지 않았다.

## 서버 구현 및 기존 사용자 영향

- 신규 Auth 사용자 생성 trigger는 세 동의의 명시적 boolean true, 버전, 해시를 검사한다. 하나라도 누락되면 계정·프로필 생성 전체가 rollback된다. 관리자 provisioning도 예외가 아니다.
- 정책 원문·버전은 수정/삭제할 수 없고, 해시는 서버에서 계산한다. 증적에 profile/Auth 사용자, 정책 버전, 원문 snapshot/hash, 서버 시각과 출처를 저장한다.
- Partner Admin/Operator의 업무 자격은 현재 조직·v1.0·1년 유효기간·철회 여부와 가입 정책 적용 대상을 서버에서 검사한다. 역할에 따른 동의 범위 차이는 없다.
- Ticket/Business/Activity/첨부 메타데이터/관계/알림/Partner 업무 정보의 RLS와 기존 업무 변경 RPC에 동의 AND 조건을 적용한다. 동의 후에도 기존 Business/배정 범위만 유지된다.
- 로그인, 본인 계정, 동의 제출/철회/재동의, 비밀번호 복구는 업무 자격과 분리한다. Company의 기존 연간 서약 면제는 유지한다.
- 가입 정책 cutoff는 신규 migration의 transaction 시각이다. 기존 가입자에게 새 가입 증적을 소급 요구하지 않으며, 면제를 동의로 기록하지 않는다. 기존 유효 typed v1.0 서약은 인정하고 hash를 가짜로 채우지 않는다.
- 기존 미동의 Partner는 의도대로 업무 접근이 제한된다. 기존 사용자 권한·계정·업무 데이터·세션을 변경하지 않는다. 구형 탭의 동의 제출은 문서 증적이 없으므로 새 화면으로 새로고침해야 한다.

## 적용 및 검증 절차

`supabase db push --linked --dry-run`에 신규 `20261012000000_enforce_partner_consent.sql` 1개만 표시됐다.
동일 신규 migration만 적용했으며 DB reset·이전 migration 재실행은 하지 않았다.
적용 전후 기존 profiles/organizations/businesses/tickets/activities/privacy_consents 및 private.app_sessions의 정렬된 행 해시를 비교한다.
기존 관리자 권한·조직·계정 상태는 profiles 보존 비교에 포함된다.

실제 서버 검증은 `PD-CONSENT-20261012-*` 전용 계정만 사용하며 기존 PD-RLS 테스트 조직·Business·Ticket을 재사용한다.
관리 키는 식별 테스트 계정 생성과 준비에만 사용한다. 접근 성공/차단 판정은 실제 password login JWT와 app-auth 발급 세션으로 REST/RPC를 호출한 결과다.
테스트 비밀번호·JWT·앱 세션·관리 키는 파일/로그/commit에 저장하지 않는다.

| 역할 | 미서약 | 서약 후 | 철회 후 같은 세션 | 재동의 |
|---|---|---|---|---|
| Company Operator | 기존 면제로 전체 Ticket | 기존 범위 유지 | Partner 서약 적용 대상 아님 | 적용 대상 아님 |
| BP Admin / Operator | 업무 7개 테이블·상세 차단, 변경 RPC 거절 | 연결 Business Ticket만 | 업무 즉시 차단 | 동일 범위 복원 |
| SP Admin / Operator | 업무 7개 테이블·상세 차단, 변경 RPC 거절 | 자기 조직 배정 Ticket만 | 업무 즉시 차단 | 동일 범위 복원 |

검사 항목: 공개 Auth signup에서 가입 동의 각각 누락 시 생성 실패/계정 없음,
정확한 세 동의를 전달한 테스트 계정 생성, 본인 계정 조회/변경, 현재 원문 동의,
외부 Ticket 상세·Activity·첨부 메타데이터 차단, 문서 hash 불일치 거절,
서약 철회 후 같은 JWT/앱 세션의 조회·변경 차단, 재동의 복구,
가입 동의 철회·재동의, 증적 필드/해시/사용자 일치, JWT만으로 우회 불가,
recovery 링크 발급·OTP 인증·비밀번호 변경·새 비밀번호 로그인.

변경 RPC의 기존 존재 숨김 오류 `P0002`와 권한 오류 `42501`은 모두 거절이며 접근 성공으로 계산하지 않는다.
비밀번호 재설정 후 이전 JWT 거절은 예상 동작이다. 로그아웃을 재설정 이전에 검사하도록 테스트 순서를 교정했다.
실제 메일 전달/메일함 열람, 브라우저 전체 E2E, 파일 바이너리 다운로드는 검증하지 않았다.
현재 Storage bucket이 없어 첨부파일 검증은 업무 첨부 메타데이터 접근에 한정한다.

로컬: 전체 101개 + app-auth 18개 테스트 통과, lint/build 통과.
격리 PostgreSQL에서 기존 유효 서약, 만료/미래 시각/조직 불일치, 정책 변경,
원문 수정 금지, 타인 철회/직접 증적 DML 및 permissive policy 우회도 검증했다.
build의 기존 bundle 크기·caniuse-lite 노후 경고는 남아 있다.

중단 전 실제 서버 검증의 최종 집계·보존 비교 결과는 기록되지 않았다. 재개 작업은 필수 자동 테스트와 읽기 전용 원격 상태 확인 후 commit/push하며, 종합 검증은 후속으로 수행한다.
Vercel 최종 상태는 해당 main commit의 GitHub Production deployment success와 실제 배포 URL 응답으로 확인한다.

## 실행 결과

2026-10-13 재개 확인: 로컬 HEAD와 GitHub main은 7e82465였고, 동의 구현은 미커밋 상태였다. Supabase 원격 migration history에는 20261012000000이 이미 적용되어 있어 dry-run/apply를 반복하지 않았다. 기존 Vercel Production은 7e82465의 success 상태였다.

원격 읽기 전용 확인: 가입 3종(base44-v1)과 서약(v1.0) 모두 enabled=true/required=true, 업무 SELECT restrictive gate 7개. 활성 Company 관리자 1명이며 동의 요건에 의해 차단되는 관리자는 0명이다. 실제 관리자 로그인은 이번에 수행하지 않았다.

이번 필수 검증: 앱/DB/UI 101개 및 app-auth 18개, 합계 119개 통과. lint/build/diff check 통과. 기존 caniuse-lite 및 500KB 초과 번들 경고는 남아 있다. 신규 사용자·동의 증적 생성이나 기존 업무 데이터 변경을 수행하지 않았다. 중단 전 운영 데이터 보존 해시 비교와 실제 인증 시나리오 최종 결과는 확인할 수 없으며, 브라우저·이메일·종합 보안 검증과 함께 후속 확인 대상으로 남긴다.

기존 로컬 구현을 그대로 재사용하여 main에 commit/push한다. 해당 commit의 Vercel Production 완료 결과는 최종 응답에 기록한다.

## 변경 파일 및 후속 운영 사항

신규 migration, AuthContext, ProtectedRoute, Registration, PrivacyConsent, Account,
ConsentManagement, consent helper 및 동의 DB/제출/UI 테스트를 변경했다.
Edge Function·기존 migration·관리자 권한 코드는 변경하지 않았다.
신규 정책 변경 시 새 version/원문 및 재동의 시행 범위를 결정해야 한다.
기존 가입자도 가입 3종의 재동의 대상에 포함할지는 별도 회사 정책과 공지를 정한다.
증적 보존기간·법적 문구 적정성·사람 단위 중복계정 금지의 별도 강제는 이번 복원으로 확정하지 않는다.
