# Partner 미접속 계정 자동 관리

2026-11-09 승인: Partner 조직의 승인된 계정에 23일 경고 / 30일 정지를 적용한다.
Company 계정, Guest, inactive_check_exempt 계정 및 로그인 이력이 없는 계정은 제외한다.
기준은 마지막 성공 로그인과 관리자 재활성화 시각 중 더 최근 시각이다.

매일 02:00 Asia/Seoul (UTC 17:00)에 DB 작업을 실행한다.
상태 변경, 업무 세션 철회, 감사 기록, 메일 대기열 등록은 하나의 트랜잭션이다.
메일 작업은 별도로 재시도하며 SMTP 수락과 실제 수신은 구분한다.

## 구현

- `20261109000000_partner_inactivity_automation.sql`: 상태 변경·세션 철회·감사·메일 대기열.
- `inactivity-mail`: 전용 스케줄 인증키 검사, TLS SMTP 인증, 메일 발송·결과 기록.
- `operations/enable-inactivity-schedule.sql`: UTC 17시 일일 점검과 1분 간격 메일 대기열 처리.
- 성공 로그인은 기존 `last_login_at`을 갱신하고 경고를 해제한다. 과거 Base44의 `last_login_date`에 대응한다.
- 관리자 활성화는 기존 조직·권한을 유지하고 재활성화 시각부터 새 23/30일 기간을 시작한다.

메일 대기열은 잠금과 5분 lease로 중복 작업을 막고 실패 후 최대 60분 간격으로 재시도한다.
로그인·재활성화·대상 제외·정지 전환 시 오래된 미발송 경고는 취소한다.
SMTP가 수락한 직후 프로세스가 중단되면 재시도에서 중복 수신할 가능성은 남는다.
SMTP 수락은 최종 수신 보장과 다르다. 이미 SMTP 전송 중인 메일은 로그인과 동시에 회수할 수 없다.

## 운영 점검

비밀값은 채팅·저장소에 기록하지 않는다. Gmail SMTP 인증에는 실제 앱 비밀번호가 필요하다.
`scripts/inactivity-credentials.ps1 -Mode Verify`는 연결 인증과 작업 결과만 출력한다.
상태·권한은 `profiles`, 메일 처리는 `private.inactivity_mail_queue`, 예약 실행은
`cron.job`/`cron.job_run_details`, 변경 증거는 기존 감사 로그에서 확인한다.
장애 시 일일 작업 `partner-inactivity-daily`를 중지하고 원인을 확인한다.
중지만으로 기존 차단 계정이 자동 복원되지는 않는다. 관리자가 개별 활성화한다.

## 운영 적용 결과 — 2026-11-09

- 마이그레이션 `20261109000000` 적용 및 이력 등록 완료. 다른 미적용 마이그레이션은 실행하지 않았다.
- 사용자가 `INACTIVITY_SMTP_PASSWORD`를 직접 등록한 뒤 Gmail TLS SMTP 인증 성공.
  Auth 설정 조회의 비밀번호 반환값은 재사용 인증에 실패했으므로 재사용하지 않는다.
- `partner-inactivity-daily`: `0 17 * * *`, 활성. 다음 정기 점검은 2026-11-10 02:00 KST.
- `partner-inactivity-mail`: 매분 실행, 활성. 2026-11-09 12:06 KST 자동 실행 성공.
- 12:05 KST 첫 점검: Partner 경고 5개, 차단 0개. Company 5개는 활성 상태 유지.
- 경고 메일 5개 모두 첫 시도에 SMTP 수락 및 sent 기록 확인. 미처리/실패 메일 0개.
  사용자 메일함 도착·열람까지 확인한 것은 아니다.
- 운영 화면: `https://partnerdesk-phi.vercel.app`, 배포 `dpl_9LPFyjAUuKN9jVBnB4zW6qcv4XFK`.
  이전 운영 배포 `dpl_ztrQBUwx8RhKvtoLjHQvVb8siud3`의 소스를 확인해 이번 화면 변경만 반영했다.
- 전체 테스트 182개 통과, lint/build 및 Deno 타입 검사 통과.
- 운영 로그인 화면 HTTP 200, 비로그인 업무 API HTTP 401 및 서울(icn1) 실행 확인.
- 감사 체인 640개 검증 정상. 30일 실제 운영 계정 차단 실험은 하지 않았으며
  경계·세션 철회·MFA 거부·재활성화 유예·감사 실패 롤백은 격리 DB에서 검증했다.
