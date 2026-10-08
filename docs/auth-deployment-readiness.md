# 인증·회원가입 배포 준비 결과 — 2026-10-08

## 원격 상태

- linked 프로젝트 `bqtlopwgjvvugalktldr` 확인.
- 앞서 적용한 migration `20261008000002` 포함 20개 이력 유지. 이번 단계 DB migration 실행 없음.
- `app-auth` 하나만 배포 완료: **ACTIVE v4**, 함수 ID 유지, 기존 `verify_jwt=false` gateway 설정 유지.
- 로컬 변경은 정지/비활성 계정 오류 이유를 각각 `account_suspended`, `account_disabled`로 구분하는 한 줄. JWT는 기존대로 `Auth.getUser`로 검증하며 세션 발급/검증/폐기 응답·헤더·해시·MFA/IP guard는 동일.
- 배포 후 원격 소스 5개(index/handler/http/email/crypto)가 로컬과 일치함을 다운로드 비교로 확인.
- 배포 전후 admin/profile/조직/Auth 사용자/업무 데이터/앱 세션 13개 해시, RLS/함수/trigger/migration 이력 동일. 실제 사용자 세션 폐기 없음.

## 검증 결과

- `npm.cmd run build` 성공. 기존 Browserslist 데이터 노후 경고만 있음.
- 인증 보안 18개 + 로그아웃 회귀 3개 = **21개 통과**.
- 변경 화면 ESLint 오류 없음. `git diff --check` 통과.
- 원격 endpoint 음성 테스트 5개 통과: GET은 405, JWT 없는 validate-session은 401/authentication_required, 잘못된 JWT의 activate/logout/validate는 모두 401/invalid_jwt. 앱 토큰 반환 없음.
- 실제 사용자 JWT/비밀번호를 사용하거나 정상 사용자로 로그인·activate·logout을 호출하지 않음. 기존 로그인 성공 계약은 소스 동일성 및 모의 서비스 회귀 테스트로 검증했으며, 실제 이메일/승인/복구 종단 간 검증은 후속 프론트 배포 후 필요.

## Redirect 및 SPA

| 흐름 | SDK redirect | 공개 React route | Vercel rewrite |
| --- | --- | --- | --- |
| 회원가입·확인 메일 재발송 | 현재 origin + `/auth/confirm` | `/auth/confirm` | `/index.html` |
| 비밀번호 복구 | 현재 origin + `/reset-password` | `/reset-password` | `/index.html` |
| 로그아웃 | `/login` | `/login` | `/index.html` |

사용자가 운영 Site URL 및 위 운영 Redirect URLs 2개를 등록 완료했다고 제공한 상태를 기준으로 검토함. 코드의 경로·origin 생성·route·rewrite 일치를 확인했으며 `/assets/`는 rewrite 제외. 로컬 built Vite preview에서 로그인/가입/찾기/재설정/확인/상세/없는 URL 총 7개 직접 요청 모두 SPA HTML(200)을 반환함. Vercel은 이번 단계에서 배포하지 않았으므로 운영 rewrite 적용 확인은 후속 작업.

## Git 및 민감정보

- tracked 및 신규 후보 파일 228개에 실제 secret 패턴, service_role JWT, 로컬 민감 env 값 일치가 발견되지 않음. commit 직전 staged blob 검사도 수행함.
- `.env`, Supabase 임시 linked 설정·원격 audit·배포 검증 파일은 gitignore 대상임을 확인. tracked 환경 파일은 값이 없는 `supabase/functions/.env.example` 템플릿뿐임.
- 기능/테스트/migration/Vercel rewrite/운영 문서를 하나의 commit으로 묶음.
- Commit message: `Complete self-registration and authentication recovery`.
- git push 및 Vercel 배포는 수행하지 않음.

## 후속 확인

이메일 가입·Confirm email·SMTP·서버 비밀번호 정책을 확인하고 프론트 배포 후 가입→메일 확인→승인 대기→관리자 승인→재로그인, 복구→비밀번호 변경→이전 앱 세션 폐기를 테스트 계정으로 검증할 것. 새로운 프론트 환경변수나 Edge secret은 필요하지 않음.
