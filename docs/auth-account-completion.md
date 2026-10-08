# PartnerDesk 인증·계정관리 적용 안내 (2026-10-08)

후속 원격 적용 완료: `bqtlopwgjvvugalktldr`에 `20261008000002`를 적용하고 기존 데이터/권한/세션 보존을 검증했습니다. 이후 app-auth도 ACTIVE v4로 배포했습니다. 아래 최초 적용 절차를 다시 실행하지 마세요. 현재 상태는 [배포 준비 결과](auth-deployment-readiness.md), DB 적용 기록은 [원격 적용 결과](auth-registration-remote-application.md)를 확인하세요. Vercel 배포와 실제 이메일 종단 간 검증은 아직 수행하지 않았습니다.

## 구현 및 권한 경계

- `/login`, `/register`, `/forgot-password`, `/reset-password`, `/auth/confirm`은 공개 route입니다. 미등록 URL에는 복귀 링크가 있는 안내 화면을 제공합니다.
- Vercel SPA rewrite를 추가했습니다. 로그아웃의 `/login` 전체 페이지 이동과 직접 URL/새로고침이 index.html로 연결됩니다. assets 경로는 rewrite에서 제외합니다.
- 가입은 Supabase `signUp`을 사용하고 이름만 user metadata에 전달합니다. 역할/조직/상태를 프론트에서 설정하지 않습니다.
- migration의 Auth INSERT trigger가 전용 대기 조직의 `guest/pending_login` profile을 만듭니다. 기존 이메일로 profile을 자동 연결하지 않습니다. 기존 사용자/데이터를 갱신하거나 backfill하지 않습니다.
- 기존 app-auth 앱 세션 발급은 첫 로그인 시 pending_login을 active로 변경합니다. **승인 여부는 account_status가 아닌 guest 역할로 구분합니다.** active guest도 승인 전이며 업무 데이터 RLS 접근 권한이 없습니다.
- guest 대기 화면은 기존 `submit_role_request`를 사용합니다. 조직 선택에는 앱 세션이 필수인 신규 `list_role_request_organizations` RPC로 ID/이름/종류만 제공합니다. 일반 조직 SELECT RLS는 변경하지 않았습니다.
- 관리자 `/users`의 기존 `approve_role_request` 또는 `change_profile_role_organization`으로 역할/실제 조직을 설정합니다. 기존 RPC가 세션을 폐기하므로 승인 후 다시 로그인해야 합니다. partner_admin의 개인정보 서약 흐름도 유지됩니다.
- disabled/정지/이메일 미확인에 별도 안내를 제공합니다. disabled 계정 복구는 기존 정책에 따라 관리자 운영 절차가 필요하며 임의 재활성화 기능은 추가하지 않았습니다.
- 복구 이벤트는 React mount 전에도 감지하며, 해당 탭에서 재설정 화면 새로고침이 가능합니다. 복구 세션에는 앱 세션을 발급하지 않습니다. updateUser 성공 후 로그아웃하고 비밀번호 로그인을 다시 요구합니다.
- Auth 비밀번호 변경 trigger가 기존 앱 세션을 모두 폐기하고 password_changed_at을 기록합니다. MFA/IP/app-session 검사를 완화하지 않았습니다. MFA가 켜진 환경의 기존 mfa_required 차단도 유지됩니다.
- 로그아웃은 서버 앱 세션 폐기를 먼저 시도하고 실패하더라도 앱 토큰·캐시·복구 상태·Supabase 로컬 인증을 제거합니다. 서버 연결 장애 중 이미 복제된 서버 세션 토큰은 즉시 폐기 보장을 할 수 없으며 기존 만료 정책을 따릅니다.

## 수동 적용 순서

1. 원격 schema와 migration 이력을 확인합니다. 저장소에는 Auth 사용자 생성/password 변경 trigger가 없지만 원격에 수동 생성된 것이 있는지는 확인하지 못했습니다. 기존 provision trigger가 있다면 새 trigger와 중복 설치하지 말고 기존 구현에 동일한 guest 제한을 통합해야 합니다. 기존 조직 UUID `10a8e084-c396-4a97-b301-c4ef4aa59d71`가 존재하면 migration은 실패하도록 작성했습니다.
2. 검토 후 `supabase/migrations/20261008000002_add_safe_self_registration.sql`을 관리자가 적용합니다. 앞선 migration들이 적용되어 있어야 합니다. 자동 원격 적용은 하지 않았습니다.
3. 변경한 `supabase/functions/app-auth/handler.ts`를 포함해 app-auth를 재배포합니다. account_disabled/account_suspended 구분을 위해 필요합니다. Origin allowlist에는 정확한 운영 origin을 유지합니다.
4. Supabase Auth에서 이메일 가입을 활성화하고 **Confirm email을 활성화**합니다. 비밀번호는 최소 8자, 대문자/소문자/숫자/특수문자 정책을 서버에도 설정합니다. SMTP 발신자/메일 전송 제한을 확인합니다.
5. Auth → URL Configuration: Site URL을 실제 운영 HTTPS origin으로 지정하고 아래 정확한 URL을 Redirect URLs에 등록합니다. 필요한 로컬/스테이징 origin은 각각 별도로 등록합니다. 불필요한 전체 wildcard는 사용하지 않습니다.
   - `https://<운영도메인>/auth/confirm`
   - `https://<운영도메인>/reset-password`
6. 확인/복구 이메일 템플릿은 기본 `{{ .ConfirmationURL }}` 링크를 유지합니다. SiteURL만으로 앱에 바로 연결하거나 token_hash 템플릿으로 바꾸면 현재 SDK 자동 복구 흐름과 맞지 않습니다.
7. Vercel에 변경 소스와 vercel.json을 배포합니다. Vite framework, build `npm run build`, output `dist`를 확인합니다. 기존 `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` 외 신규 환경변수는 없습니다. service_role/secret key를 프론트에 넣지 않습니다.

원격 trigger 확인 예시(읽기 전용):

```sql
SELECT t.tgname, pg_catalog.pg_get_triggerdef(t.oid)
FROM pg_catalog.pg_trigger AS t
WHERE t.tgrelid = 'auth.users'::regclass AND NOT t.tgisinternal;
```

## 운영 검증 항목

로컬 검증 결과: `npm.cmd run build` 성공, Edge 보안 18개와 로그아웃 회귀 3개 총 21개 테스트 통과, 변경 화면 ESLint 오류 없음, `git diff --check` 통과. Vite preview에서 로그인/가입/비밀번호 요청·재설정/확인/상세/없는 URL 7개 직접 요청 모두 SPA HTML(200)을 반환했습니다. 실제 Vercel rewrite 동작, SQL migration 실행, 브라우저 UI 조작 및 메일 기반 종단 간 검증은 수행하지 않았습니다. build에는 기존 Browserslist 데이터 노후 경고가 있습니다.

실제 원격 적용/배포/이메일 발송은 수행하지 않았습니다. 테스트 전용 계정과 조직으로 아래를 확인해야 합니다.

- 기존 승인 계정 로그인 → dashboard → 로그아웃 → `/login`; 로그인/상세 URL 직접 열기와 새로고침.
- 신규 가입 → guest profile 생성(권한/조직 metadata 조작에도 guest 고정) → 미확인 로그인 차단 → 확인 메일 → 다시 로그인.
- guest 승인 대기 → 업무 화면/직접 Data API/RPC 차단 → 조직 선택/권한 요청 → 관리자 `/users` 승인 → 기존 세션 폐기 → 재로그인 → 승인된 역할만 접근.
- 정지/비활성 계정 로그인 차단과 구분 안내. 파트너 승인 계정의 개인정보 서약.
- 복구 요청에서 존재/비존재 이메일에 동일 안내 → 메일 링크 → 복구 화면/새로고침 → 비밀번호 확인 검증 → 변경 → 앱 세션 모두 폐기 → 새 비밀번호 로그인, 이전 비밀번호 실패.
- 만료/소비된 복구 링크는 변경 불가, 새 복구 요청 가능. 복구 상태로 업무 데이터 접근 불가.
- 네트워크 장애 중 로그아웃 후 캐시/앱 토큰/로컬 인증 제거, 새로고침 시 업무 접근 불가.

공식 API/설정 참고: https://supabase.com/docs/guides/auth/passwords 및 https://supabase.com/docs/guides/auth/redirect-urls
