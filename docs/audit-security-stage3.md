# 감사 기록 강화 — 2026-10-13

기존 `audit.access_logs`의 SHA-256 체인, 직렬화 advisory lock 및 소유자 전용 append 함수를 재사용한다. Base44의 AccessLogs/백업 화면과 비교했으며 기존 서버 체인을 중복 도입하지 않았다. 과거 행·해시·개인정보 스냅샷은 재작성하지 않는다.

## 기록 범위

- 기존 Ticket 생성, 상태, 담당 Partner·Operator, 주소, 활동 추가 RPC와 조직·승인·권한 관리 RPC의 동일 트랜잭션 감사 기록을 유지한다. 원문 주소·연락처·활동 내용은 새 로그에 복사하지 않는다.
- Ticket 삭제와 첨부파일 메타데이터 INSERT/UPDATE/DELETE에는 DB 트리거를 추가했다. 파일 경로·파일명·본문을 기록하지 않는다. 현재 앱은 첨부 업로드·다운로드 및 Ticket 물리 삭제 UI를 제공하지 않으며, 권한을 새로 허용하지 않았다.
- Ticket 상세 화면은 `read_ticket_detail_audited` RPC로 실제 서버 조회를 수행한다. 기존 업무 세션·조직·동의 검사를 통과한 응답에 대해 개인정보 필드 포함 사실만 기록한다. 감사 append 실패 시 읽기 결과도 반환하지 않는다. 클라이언트 화면 이동을 감사 증적으로 사용하지 않는다.
- `app-auth`가 사용하는 기존 backend RPC에서 업무 세션 발급 성공/거절, 업무 세션 검증 거절, 로그아웃을 기록한다. 이메일 MFA의 기존 발송 요청·발송 접수/실패·시도·성공/실패·잠금·횟수 제한 기록을 유지하고 결과를 명시한다. MFA 성공의 업무 세션 발급은 동일 트랜잭션에서 기록한다.
- 각 신규 access 로그는 actor profile/auth ID, 조직 ID, 작업/대상, 결과, 서버 시각, DB에서 생성한 UUID 요청 식별자를 포함한다. 이 식별자는 감사 작업 단위이며 HTTP 전체 흐름 추적 ID와 동일하지 않다. MFA 흐름은 기존 challenge ID로 추가 연계한다. 새 actor 이름·이메일 중복 저장은 중단하며 과거 기록은 보존한다.
- Company Admin 검색 화면은 작업, 사용자/조직/대상 ID, 결과, 요청 ID를 서버에서 검색한다. 최대 검색어 100자, 페이지 100건을 적용한다. Partner Admin·일반 사용자는 다른 조직 또는 감사 저장소에 접근할 수 없다.

## 미적용 범위 / 증적 한계

브라우저가 Supabase Auth에 직접 제출하는 비밀번호 로그인 실패는 Supabase Auth 자체 로그 대상이며 앱 access 로그에 수집되지 않는다. Auth 관리 테이블 트리거나 로그인 gateway를 새로 도입하지 않았다. Edge에서 DB RPC 호출 전에 거절한 잘못된 JWT·이메일 상태 등도 앱 체인에 수집되지 않는다. RLS가 직접 차단한 REST 조회는 앱 감사 성공/거절 기록이 아니다.

Ticket 목록, Activity·관리 사용자/조직의 직접 SELECT, 다른 개인정보 조회는 접근 RLS가 유지되지만 개별 조회 감사가 없다. 권한 있는 사용자는 기존 직접 Ticket SELECT 경로도 사용할 수 있으므로 상세 읽기 증적은 새 RPC 호출 범위에서만 보장된다. 전체 직접 SELECT 차단은 목록·통계 등 업무 API 구조 변경이 필요하여 이번 범위에서 제외했다. Storage 파일 실제 접근과 다운로드 기록은 미구현이다. 첨부 메타데이터 변경 기록을 파일 접근 증적으로 해석하지 않는다.

기존 RPC를 거치지 않는 postgres/service 유지보수 Ticket INSERT/UPDATE는 새 트리거 대상이 아니다. Ticket retention 익명화는 기존 `audit.data_deletion_logs`와 원자적으로 처리된다. 공개 사용자 직접 쓰기 권한은 추가하지 않는다.

## IP 신뢰 경계

Supabase Edge/REST의 사용자 원본 IP를 서버에서 위조 불가능하게 입증하는 경로는 확정되지 않았다. 따라서 현재 모든 신규 이벤트 IP는 null, `ip_unavailable_reason=trusted_request_ip_not_available`이다. X-Forwarded-For, X-Real-IP 및 클라이언트 본문을 IP 증적으로 사용하지 않는다. 향후 신뢰 경계 확인 후 내부 append의 trusted-context 슬롯을 사용한다.

## 무결성 / 실패 처리

Access/role/deletion 저장소는 일반 사용자와 service_role 직접 권한을 회수한다. 기존 SECURITY DEFINER RPC가 소유자 권한으로 기록/조회한다. 세 테이블의 UPDATE/DELETE/TRUNCATE를 트리거로 거절한다. 중요한 변경·세션 발급과 감사 INSERT는 같은 트랜잭션이며 감사 실패 시 함께 롤백한다. 기존 전체 체인 검증 실패도 조용히 무시하지 않는다.

DB 소유자가 트리거를 비활성화하거나 함수를 교체할 수 있어 외부 불변 저장소 수준의 증적은 아니다. 외부 서명 checkpoint/불변 백업, 권한 분리, 체인 검증의 데이터 증가 시 성능 개선, 거절 이벤트 대량 발생에 대한 방어는 후속 과제다. 현재 전체 체인 재검증은 이벤트 수에 비례하는 비용이 든다.

## 보존 정책

Ticket은 생성일 + 달력 3년 기준으로 기존 서버 retention 함수에서 Ticket/Activity 개인정보를 익명화하고 관련 Notification을 삭제한다. 첨부 Storage 처리는 기존에도 제외되어 있다. 실제 예약 실행 상태와 Storage 보존은 별도 확인 대상이다.

감사 로그는 Ticket 3년 정책을 적용하지 않는다. 현재 자동 만료/삭제 작업이 없고 이번 변경은 삭제를 차단한다. 감사 로그의 법적 최소/최대 보존기간, actor 개인정보 처리, 외부 백업 기간, 승인된 만료/아카이브 절차는 미확정이며 정책 결정 후 별도 migration과 승인된 운영 절차가 필요하다. 임의로 3년 삭제를 활성화하지 않는다.

전체 MFA 강제 설정은 `mfa_enabled=false`를 유지한다. 신규 migration은 기존 사용자·조직·Ticket·동의·세션을 변경하지 않는다.

## 적용 확인

`20261014000000_strengthen_server_audit.sql`만 dry-run 후 운영에 적용했다. 적용 전후 profiles/organizations/tickets/privacy_consents 및 기존 access 로그 23건의 집계 해시가 일치했고 감사 체인 검증이 정상이다. Company Admin 1명과 MFA 비활성 정책을 유지했다. `app-auth` ACTIVE v6의 기존 RPC 호출이 개선된 DB 함수를 사용하므로 Edge 코드는 변경·재배포하지 않았다.

운영 `auth.audit_log_entries`는 현재 비어 있고 pg_cron도 활성화되어 있지 않다. 이를 비밀번호 실패 수집이 확인된 것으로 해석하지 않는다.

로컬 PostgreSQL/RLS 포함 앱 테스트 119개와 Edge 인증 테스트 21개(총 140개), lint, Vite build가 통과했다. 감사 기록 실패를 강제로 발생시킨 로컬 테스트에서 첨부 변경·Ticket 삭제·세션 발급의 롤백과 상세 조회 결과 차단을 확인했다. 운영 관리자 로그인·업무 작업의 실증과 종합 검증은 별도 수행 대상이다.
