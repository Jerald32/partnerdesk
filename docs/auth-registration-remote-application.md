# 회원가입 migration 원격 적용 결과 — 2026-10-08

이 문서는 DB migration 적용 당시의 기록입니다. 이후 app-auth를 ACTIVE v4로 배포했으며 현재 상태는 [배포 준비 결과](auth-deployment-readiness.md)를 확인하세요. 아래 Edge 미배포 상태는 DB 적용 시점 기준입니다.

## 적용 결과

- 대상 linked 프로젝트: `bqtlopwgjvvugalktldr`.
- 적용 전 로컬/원격 이력: `20261006000000`~`20261006000016`, `20261008000000`, `20261008000001` 총 19개 일치.
- `supabase db push --linked --dry-run`: `20261008000002_add_safe_self_registration.sql` 하나만 대상. seeds/roles 없음.
- `supabase db push --linked --yes`: 위 migration 하나 적용 성공. 이후 이력은 총 20개 일치.
- 치명적인 SQL 문제는 발견되지 않았으며 migration SQL 수정은 없음. 이미 적용했으므로 재실행/이력 repair는 필요하지 않음.

## 사전 검토

- 원격 `auth.users`, `public.profiles`, `public.organizations`에 기존 사용자 정의 trigger가 없었고 신규 함수 및 대기 조직 UUID 충돌도 없었음.
- 가입 trigger는 AFTER INSERT에만 실행. 신규 Auth ID로만 profile INSERT하며 기존 이메일로 연결/덮어쓰거나 기존 사용자 backfill을 하지 않음. 사용자 metadata의 role/organization/status는 무시하고 guest/pending_login을 고정함.
- 대기 조직은 신규 고정 UUID의 operator 유형 조직. guest에는 업무 권한이 없으며 승인 이후 실제 조직/역할 변경은 기존 관리자 RPC로 수행함.
- 기존 RLS/관리자 권한 검사/승인/세션 guard 및 함수 정의는 변경하지 않음. 기본 테이블 쓰기 grant가 있더라도 RLS에 쓰기 정책을 추가하지 않으므로 직접 profile 권한 변경을 허용하지 않음.
- 조직 선택 RPC는 앱 세션 검사 후 ID/이름/종류만 반환함. 대기 조직·비활성 조직은 제외. 조직 정보 노출 범위를 명시적으로 제한한 승인 요청용 디렉터리이며 업무 데이터 반환 없음.
- 비밀번호 trigger는 encrypted_password가 실제 변경될 때 해당 profile의 기존 앱 세션을 폐기하고 password_changed_at/updated_at만 갱신함. 단순 이메일 확인/metadata 업데이트/비밀번호 값이 같은 UPDATE에는 세션 폐기 없음. Auth/profile의 role·organization 변경 없음. migration 설치 시 기존 세션을 폐기하지 않음.
- 두 trigger 함수는 postgres 소유 SECURITY DEFINER, 빈 search_path, fully qualified 테이블/함수, 소유자 외 EXECUTE 없음. 조직 RPC도 동일 소유자/SECURITY DEFINER/search_path이며 authenticated만 EXECUTE 허용, 내부 앱 세션 guard 필수. anon/service_role/PUBLIC에는 EXECUTE 없음.

## 적용 후 검증

| 항목 | 적용 전 | 적용 후 | 보존 검증 |
| --- | ---: | ---: | --- |
| Auth 사용자 | 1 | 1 | 전체 행 집합 해시 동일 |
| profile / 활성 admin | 1 / 1 | 1 / 1 | 전체 행 해시 동일; Auth 연결·role·status 포함 |
| 조직 | 2 | 3 | 기존 2개 전체 행 해시 동일; 대기 조직만 추가 |
| 비즈니스 | 1 | 1 | 전체 행 집합 해시 동일 |
| 티켓 | 2 | 2 | 전체 행 집합 해시 동일 |
| 권한 요청 | 0 | 0 | 전체 행 집합 해시 동일 |
| 앱 세션 | 13 | 13 | 모든 기존 행 해시 동일; 신규 폐기 없음 |

partner_details/service_partners/activities/notifications/privacy_consents/system_settings/ip_whitelist/ticket_attachments의 전체 행 집합 해시도 동일. 기존 함수 정의/ACL, public RLS 활성화 상태/정책/테이블 쓰기 grant도 동일.

`auth.users` trigger는 `partnerdesk_signup_profile`, `partnerdesk_password_change` 각각 1개, enabled 상태. 신규 함수 3개의 소유자/search_path/EXECUTE를 실제 원격 catalog에서 검증함. 읽기 전용 음성 테스트에서 anon EXECUTE 거절과 authenticated 역할의 Auth/app-session 없는 호출 거절을 확인함.

기존 사용자에 대한 비밀번호 변경이나 신규 실사용 가입을 실행하지 않았으므로 실제 Auth 이메일·가입·복구 종단 간 검증은 후속 단계임. 비교용 원격 catalog/해시/검증 스크립트는 gitignore 대상 `supabase/.temp/auth-registration-*`, `supabase/.temp/verify-auth-registration.mjs`에 있음. 인증 토큰/비밀번호 원문은 수집하지 않음.

## Edge Function

원격 app-auth는 ACTIVE v3. 다운로드한 원격 handler와 로컬 handler의 차이는 정지/비활성 오류 이유 구분:

- 원격: `account_unavailable`.
- 로컬: `account_suspended` / `account_disabled`.

계정 상태별 안내를 완성하려면 후속 배포가 필요함. 이번 단계에서는 배포하지 않았음. 기존 JWT 검증 위치를 유지하며 배포하는 명령:

```powershell
node_modules/.bin/supabase.cmd functions deploy app-auth --project-ref bqtlopwgjvvugalktldr --use-api --no-verify-jwt
```

`--no-verify-jwt`는 기존 gateway 설정을 유지하는 옵션이며 handler/index의 Supabase getUser JWT 검증은 유지함. 신규 secrets는 필요하지 않으며 기존 Origin/MFA/메일 설정을 보존할 것.

## 후속 Supabase 설정 및 검증

- 이메일 가입과 Confirm email 활성화 확인, SMTP/발신자/전송 제한 확인.
- 실제 운영 Site URL과 정확한 `/auth/confirm`, `/reset-password` Redirect URLs 등록. 확인/복구 템플릿은 `{{ .ConfirmationURL }}` 흐름 유지.
- 서버 비밀번호 정책을 기존 프론트 규칙(8자 이상, 대문자/소문자/숫자/특수문자 포함)과 맞춤.
- app-auth allowed origins에 정확한 운영 origin 유지. MFA/IP 검사를 우회하는 설정 변경 금지.
- 테스트 계정으로 가입→이메일 확인→guest 대기→관리자 승인→재로그인 및 복구→비밀번호 변경→기존 앱 세션 폐기를 검증할 것. 원격 RLS 차단도 함께 확인.
- 이번 작업에는 DB reset, 기존 migration 재실행, 기존 데이터 일괄 수정, 관리자 권한 변경, commit/push, Edge/Vercel 배포 없음.

설정 참고: [Supabase Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls), [SECURITY DEFINER 지침](https://supabase.com/docs/guides/database/functions).
