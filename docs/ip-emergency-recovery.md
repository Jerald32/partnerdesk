# IP 화이트리스트 비상 복구

운영 기준: `acd7dc7`, Supabase 프로젝트 `bqtlopwgjvvugalktldr`, 운영 주소 https://partnerdesk-phi.vercel.app.
이 절차는 IP 차단만 모니터링으로 전환한다. 현재 운영은 이미 모니터링 상태이며 이 SQL을 운영에 실행하지 않았다.

## 설정과 신뢰 경계

- `private.gateway_config`의 `id=true` 단일 행: `mode='enforced'`는 IP 차단, `mode='monitor'`는 판정·감사만 수행한다.
- `pending`은 10분 정책 전환과 이전 목록 복귀 정보다. 비상 복구에서는 반드시 NULL로 취소한다. 남겨두면 다음 정책 조회가 이전 enforced 상태를 복원할 수 있다.
- `version`을 증가시켜 기존 관리 화면의 정책 변경 요청을 stale 상태로 만든다.
- `enabled=true`는 직접 Supabase 업무 접근 차단 설정이다. **그대로 유지한다.** signing_key, nonce, RLS, 업무 세션, MFA, 사용자 권한도 변경하지 않는다.
- 허용 목록은 `public.ip_whitelist(ip_address,is_active)`다. 사무실 `211.234.206.63/32`가 활성 항목으로 존재함을 읽기 전용으로 확인했다. 복구 SQL은 목록을 수정하지 않는다.

`api/gateway.js`는 매 요청마다 `public.backend_gateway_policy()`를 호출한다. 정책의 메모리/Redis 캐시나 환경변수 캐시는 없고 응답은 no-store다. DB 증명 검증도 현재 mode를 읽는다. COMMIT 이후 정책을 읽는 다음 요청부터 모니터링으로 처리되며, 이미 이전 정책을 읽은 요청은 한 번 거부될 수 있다. 고정된 전체 로그인 완료 시간은 보장하지 않는다. 정책 조회 자체의 타임아웃은 15초이고 장애 시 503으로 실패한다.

app-auth의 `PARTNERDESK_GATEWAY_REQUIRED=true`는 증명 필수 설정이다. 유지해야 한다. 이 상태에서 기존 `system_settings.ip_restriction_enabled`는 별도 로그인 IP 차단을 수행하지 않는다. Vercel 환경변수나 Edge Secret을 바꾸거나 재배포할 필요가 없다.

## SQL Editor 실행

Supabase Dashboard에서 해당 프로젝트 → SQL Editor → 새 쿼리, 실행 역할 **postgres**를 선택한다. 공개 anon/authenticated/service_role 요청으로 실행하는 절차가 아니다. 프로젝트 DB 운영 권한을 가진 대시보드 계정이 필요하다. 사전에 그 계정의 로그인·MFA·프로젝트 접근과 SQL Editor 이용 권한을 PartnerDesk 외부에서 확인한다.

아래 `REPLACE_WITH_INCIDENT_REFERENCE`를 운영 장애 기록 번호로 바꾼다. 계정 비밀번호, PIN, 토큰, Secret, 사용자 개인정보를 입력하지 않는다. 전체 블록을 한 번에 실행한다.

<!-- recovery-sql-start -->
```sql
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $recovery$
DECLARE
  before_state private.gateway_config%ROWTYPE;
BEGIN
  SELECT * INTO STRICT before_state
  FROM private.gateway_config WHERE id = true FOR UPDATE;
  IF before_state.enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'gateway_boundary_not_enabled';
  END IF;
  UPDATE private.gateway_config
  SET mode = 'monitor', pending = NULL, version = version + 1
  WHERE id = true;
  PERFORM audit.append_access_log(
    p_action => 'ip_policy_emergency_recovered',
    p_target_type => 'IPPolicy',
    p_target_id => 'global',
    p_metadata => jsonb_build_object(
      'incident_reference', 'REPLACE_WITH_INCIDENT_REFERENCE',
      'source', 'supabase_sql_editor',
      'db_session_user', session_user,
      'previous_mode', before_state.mode,
      'previous_version', before_state.version,
      'new_mode', 'monitor',
      'new_version', before_state.version + 1,
      'pending_cancelled', before_state.pending IS NOT NULL,
      'ip_unavailable_reason', 'sql_editor_has_no_verified_gateway_client_ip'
    ),
    p_trusted_ip => NULL
  );
END $recovery$;
COMMIT;
```
<!-- recovery-sql-end -->

감사 append와 정책 변경은 동일 트랜잭션이다. 감사 기록 실패·잠금 타임아웃·기타 오류 시 COMMIT하지 말고 `ROLLBACK;`을 실행한다. 정책 변경도 반영되지 않는다. 감사 무결성 오류가 있다면 이 SQL로의 복구는 실패한 것으로 판정하고 DB 운영자에게 에스컬레이션한다. 감사 기록을 삭제하거나 검증을 해제하지 않는다.

결과 확인:

```sql
SELECT enabled, mode, version, pending IS NULL AS no_pending_transition
FROM private.gateway_config WHERE id = true;
```

기대값: enabled=true, mode=monitor, no_pending_transition=true. 서명 키나 전체 설정 행을 출력하지 않는다.

## 접속 재개 및 운영 기록

1. 운영 주소에서 새 요청/새로고침을 수행한다. 이전 요청이 403이었다면 다시 시도한다. 계속 503 또는 인증 오류가 나면 IP 설정 문제가 아닌 게이트웨이/인증 장애로 분리한다.
2. 기존 Company Admin 이메일·비밀번호와 현재 MFA/동의 절차로 정상 로그인한다. Ticket 목록·기존 상세·사용자 관리 접근을 확인한다.
3. 시스템 설정의 IP 관리 화면을 새로 열어 최신 version을 읽고 현재 IP를 확인한다. 허용 IP/CIDR을 수정한다. 모니터링을 유지하고 재활성화하지 않는다.
4. 외부 운영 장애 기록에 실행자(대시보드 계정 식별), UTC 실행 시각, 프로젝트, 장애 사유, SQL 실행 결과, 복구 후 화면 확인 결과를 남긴다. DB 감사는 운영자 시스템 이벤트이며 session_user=postgres만으로 실제 대시보드 사람을 식별할 수 없으므로 외부 기록이 필수다. SQL Editor 저장 쿼리만을 불변 감사 증적으로 간주하지 않는다.
5. 별도 승인 후에만 재활성화를 검토한다. 활성화는 현재 접속 IP가 허용 목록에 포함되고, 아래 독립 운영자 검증·관리자 승인 또는 서로 다른 최근 확인된 허용 복구 IP가 있어야 한다. 영구 관리자 예외 IP는 없다.

## 단일 사무실 활성화 준비용 권한 검증

SQL Editor 화면 접근만으로 권한 검증을 완료하지 않는다. migration `20261018000000` 적용 후 SQL Editor에서 postgres 역할로 다음을 실행한다. 운영 정책은 monitor이고 pending이 없어야 하며, 활성 Company Admin이 정확히 한 명이어야 한다.

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT private.verify_ip_operator_recovery('REPLACE_WITH_OPERATIONS_REFERENCE');
COMMIT;
```

함수는 SECURITY INVOKER이며 postgres에게만 실행 권한이 있다. 실제 gateway_config UPDATE 권한을 같은 값 쓰기로 확인하고 기존 감사 append 경로로 검증 기록을 남긴다. 정책값·버전·pending·서명 키는 변경하지 않는다. 감사 실패 시 확인 기록도 롤백된다. 일반 사용자 JWT나 게이트웨이 서비스 키로 이 확인 기록을 생성할 수 없다. 자동 배포가 사용자를 대신해 확인 기록을 생성하지 않는다.

운영자는 앞의 비상 복구 SQL과 운영 계정 MFA 복구 수단을 확보하고 외부 운영 기록에 실행자·실행 시각·참조 번호를 남긴다. 반환 verified=true와 COMMIT 성공을 확인한다. 기록은 Company Admin에 연결되며 7일 유효하다. 그 관리자가 PartnerDesk IP 관리 화면을 새로 열고 복구 절차 확인 체크박스 및 **복구 절차 명시적 승인**을 실행해야 한다. 승인은 24시간 유효하며 별도 감사 이벤트로 기록된다. 이 확인·승인은 IP 차단을 켜지 않는다.

실제 활성화에는 다시 명시적인 활성화 확인, 허용 목록과 서버 판별 현재 IP 일치, 최신 정책 version 검사가 필요하다. 활성화 이후 새 로그인으로 10분 이내 정책 확정하지 않으면 다음 정책 조회에서 이전 정책으로 복귀한다. 독립 복구 확인은 검증 시점의 권한을 증명하며 미래의 계정 접근 가능성을 보장하지 않는다. 운영자 권한이나 복구 수단 변경 시 새 검증이 필요하다.

## 복구 수단의 범위

IP 설정 오류에 한해서는 Supabase 대시보드의 postgres SQL 실행 권한으로 복구 가능하다. PartnerDesk 로그인, Vercel 로그인, 서버 키 열람은 필요 없다. Supabase 계정의 MFA 복구 수단과 프로젝트 권한을 사전 확보한다. DB가 중지됐거나 감사 체인이 손상됐거나 Vercel/서명 키/인증 서비스가 고장난 경우는 이 SQL의 범위를 벗어나며 해당 서비스 운영 권한이 별도로 필요하다. Vercel만 이전 버전으로 롤백하지 않는다.

## 안전 검증 결과

운영 스키마·상태·운영 역할 UPDATE 권한은 읽기 전용 조회로 확인했다. 동일 SQL을 현재 migration 전체로 만든 격리 PGlite PostgreSQL에서 실행하여 pending 취소, 버전 증가, 서명 키 보존, 감사 체인 유지, 비허용 IP 게이트웨이 업무 조회 복구와 직접 접근 차단 유지를 검증했다. 단일 IP 활성화 준비, 미확인/미승인/만료된 복구 기록 거부, 현재 IP 불일치 거부, Company Admin 외 거부, 새 로그인 요구 및 자동 복귀도 격리 검증했다. gateway 테스트는 9개 통과, 전체 앱 테스트 143개 및 Edge 테스트 22개 통과다. 운영 enforced 전환이나 관리자 차단 테스트는 수행하지 않았다. migration은 복구 기능만 추가하며 mode/enabled/MFA를 변경하지 않는다. 종합 보안 검증과 실제 IP enforcement 실증은 별도 승인 범위다.
