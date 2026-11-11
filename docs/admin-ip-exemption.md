# 관리자 IP 허용 목록 예외 — 2026-11-09

사용자 승인에 따라 Company Admin과 Partner Admin은 IP 허용 목록에서 기본 제외한다.
일반 Operator·Guest에는 예외를 적용하지 않는다. IP 차단 모드와 허용 IP 목록은 변경하지 않는다.

## 서버 판정

게이트웨이는 Auth 서버가 확인한 사용자 ID만 service-role 전용 RPC에 전달한다.
DB의 현재 Profile 역할이 `admin`이고, 계정과 조직이 사용 가능하며, 이메일 인증과
Profile/Auth 이메일이 일치해야 예외다. 클라이언트 헤더·폼·user_metadata의 역할은 사용하지 않는다.
승인 대기 조직은 제외한다. DB proof 검증에서도 같은 기준을 다시 확인하므로 역할 변경이 즉시 반영된다.

IP 예외는 로그인/MFA·차단 계정·30분 유휴 만료·기존 8시간 절대 만료·조직/업무 권한·동시접속 제한을 해제하지 않는다.
기존 정책 활성화·변경의 확인 및 복구 절차는 유지한다.
미등록 IP에서 관리자 예외가 사용되면 `admin_ip_exempt` 감사 기록을 남긴다.
예외 조회나 감사 기록에 실패하면 요청을 허용하지 않는다.

## 검증 및 배포

격리 DB에서 Company/Partner Admin 허용, Operator/Guest 거부, 강등·정지·비활성 조직·미인증 제외,
감사 기록과 RPC 접근 권한을 검증한다.

2026-11-09 운영 반영 완료:

- migration `20261109000002` 적용 및 이력 등록.
- 현재 Company Admin 1개·Partner Admin 3개 모두 예외 판정, 일반 계정 6개는 예외 없음.
- 운영 IP 모드는 기존 `monitor`, gateway enabled=true, 정책 version=9 유지.
- 게이트웨이/화면 배포 `dpl_HgmwUarcXWMHZx6NmP8hxfrJv6Wz` 완료.
- 전체 테스트 187개, lint 및 프로덕션 빌드 통과.
- 미리보기 비로그인 업무 API 401·공개 정책 조회 200 확인. 감사 체인 661개 정상.
- 운영에서 전체 IP 차단을 켜거나 실제 사용자 세션을 변경하지 않았다.
  enforced 모드의 관리자 허용·일반 계정 차단은 격리 DB에서 검증했다.
