# IP 게이트웨이 전환 및 405 진단 — 2026-10-13

## 확인된 오류와 최소 수정

`POST https://partnerdesk-phi.vercel.app/api/gateway/rest/v1/rpc/list_signup_consent_policies`, 본문 `{}`가 405를 반환했다. 본문은 빈 문자열, Content-Type/Allow 없음, Cache-Control은 `public, max-age=0, must-revalidate`, X-Vercel-Cache는 BYPASS였다. 같은 운영 별칭의 GET `/`는 정상 기준 8edcbb8의 `/assets/index-Bo1oNfMC.js`를 제공했다. 그 배포에는 게이트웨이 Function이 없고 기존 SPA fallback이 API 경로도 index.html로 전달한다. 정적 경로에 POST한 응답을 새 Function 오류로 잘못 판단했던 것이다.

별도로 실패 배포 `partnerdesk-crxumysm2-716-7c9a.vercel.app`를 Vercel CLI로 직접 확인했다. native Function 경로 `/api/gateway?gateway_path=rest/v1/rpc/list_signup_consent_policies`는 JSON 동의 문서 3건과 200을 반환했다. Function은 배포되어 있었고 환경변수·Supabase RPC도 작동했다. 중첩 rewrite 경로는 Function에서 `400 invalid_gateway_request`를 반환했다. 이를 기존 운영 별칭의 405와 혼동하지 않는다.

최소 수정은 SDK 요청을 검증된 native `/api/gateway?gateway_path=...` URL로 정규화하고 wildcard rewrite를 제거하는 것이다. 원본 select/filter/order/range query는 보존한다. SPA fallback은 api 경로를 제외한다. 405 수정으로 인증·권한·RLS·감사 함수를 변경하지 않았다. API에는 임의 upstream URL 전달 기능이 없으며 기존 명시적 table/RPC/method allowlist를 유지한다.

## 검증된 Preview

배포: `https://partnerdesk-g8xjpj46i-716-7c9a.vercel.app`.

- 실제 가입 동의 RPC: 200, 문서 3건.
- 인증 없는 Ticket 요청: 401 `authentication_required`.
- Ticket DELETE 메서드: 400 `invalid_gateway_request`.
- frontend의 Supabase host와 publishable 설정 존재; service/signing key는 번들에 없음.
- Company Admin이 실제 로그인 후 Ticket 목록·기존 Ticket 상세·사용자 관리 화면 정상 접근을 확인했다. 비밀번호·PIN·JWT를 수집하거나 보고하지 않았다.
- 앱 테스트 141개, Edge 테스트 22개(163개), lint 및 build 통과.

## 접근 경계와 단계 적용

브라우저의 Auth 공개 엔드포인트는 직접 사용한다. 업무 Data API/RPC/app-auth는 Vercel native Function을 통과한다. 사용자 JWT와 기존 X-PartnerDesk-Session을 보존하며 일반 데이터 요청을 service_role로 실행하지 않는다. service_role은 고정된 정책 조회·감사·Edge 인증 backend 작업에만 사용한다.

증명은 HMAC-SHA256, 유효기간 20초이며 IP, 사용자, 업무 세션 hash, 경로/메서드, 요청 본문 hash, 요청 UUID에 연결된다. PIN 원문은 Edge nonce 검증 RPC에 전달하지 않고 hash만 전달한다. private DB에 서명 키와 nonce가 저장되고 공개 역할의 직접 접근은 회수한다. DB에서 성공/실패 업무 처리 모두 nonce를 소비하여 재사용을 거절한다. PostgreSQL GET read-only 제약 때문에 업무 조회도 POST read wrapper에서 수행하되 기존 사용자 RLS를 적용한다.

1단계 `20261016000000`은 이미 적용했다. 기존 운영 코드와 호환되도록 직접 접근 차단 flag는 false다. 재실행하지 않는다. Preview와 Production 관리자 접근을 검증한 후에만 2단계 `20261017000000`을 적용한다. 이 단계는 REST 진입점 제한, restrictive RLS, 공통 업무 세션/동의 guard의 증명 검사를 활성화한다. app-auth의 `PARTNERDESK_GATEWAY_REQUIRED=true`도 함께 적용한다. IP 정책 `mode=monitor`와 `mfa_enabled=false`는 유지한다.

## IP 관리 및 안전 전환

전체 조직 공통 정책이며 Company Admin만 IP/CIDR 추가·수정·비활성화·전환을 관리한다. 활성화는 별도 승인 작업이며 본 배포에서 실행하지 않는다. 활성화에는 현재 접속 IP와 별도의 실제 복구 IP 접속 확인, 비어 있지 않은 허용 목록이 필요하다. 활성 정책 변경은 현 관리자·복구 경로를 잃지 못하게 검사한다. 변경 뒤 재로그인 후 10분 내 확정하지 않으면 다음 gateway 요청에서 이전 정책/허용 목록으로 복귀한다. 무제한 관리자 예외는 없다.

IP는 Vercel runtime의 플랫폼 IP 슬롯만 사용하고 임의 X-Forwarded-For나 body 입력으로 대체하지 않는다. enforced 모드에서 IP 누락·잘못된 형식·목록 불일치는 거절한다. monitor 모드는 실제 차단 없이 판단을 감사 기록으로 남긴다. IP 관리 변경·복구 확인·정책 전환도 서버 감사 트랜잭션을 사용한다.

## 운영 복구와 보존

Vercel rollback은 DB migration이나 Edge Secret을 되돌리지 않는다. 2단계 적용 후 예전 8edcbb8 프런트엔드만 rollback하면 직접 업무 호출이 차단되어 업무 장애가 발생할 수 있다. 이 경우 보호된 운영자 절차에서 gateway_config.enabled를 false로 전환하고 Edge PARTNERDESK_GATEWAY_REQUIRED를 false로 복구해야 기존 코드와 호환된다. 이는 직접 접근 경계를 일시 해제하므로 보안 통제 중단으로 감사·보고하며 공개 RPC나 화면으로 제공하지 않는다.

IP 목록 설정 실수 복구는 다른 문제다. gateway boundary는 그대로 유지하고 운영자가 private.gateway_config의 mode를 monitor, pending을 null로 전환해 관리자 재진입 후 목록을 고친다. 복구 실행과 근거는 기존 audit.append_access_log로 기록한다. Supabase 운영자 계정은 앱 Company Admin 계정과 별도로 보호한다.

기존 사용자·조직·Ticket·동의·감사 이력을 재작성/삭제하지 않는다. 실제 사용자가 로그인하면 기존 앱의 정상 세션 교체 동작은 유지된다. 파일 업로드/다운로드와 bucket은 현재 미구현이며 새로 만들지 않는다. 향후 파일은 private bucket과 gateway 전용 전송을 사용하고 public/signed download URL을 클라이언트에 제공하지 않는다. Realtime은 현재 미사용이다.

## 검증 한계

기존 사업 기능 전체와 모든 조회 조합의 종합 검증은 별도다. Supabase 공개 Auth 네트워크 차단은 범위 밖이다. direct GraphQL 차단은 동일 restrictive RLS로 구성하며 별도 실제 GraphQL endpoint의 전체 회귀 확인과 감사 로그 보존기간 결정은 후속 과제다. 실제 IP enforcement 검증은 허용 IP와 복구 경로 준비 후 별도 승인 단계에서 수행한다.
