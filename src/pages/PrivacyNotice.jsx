import { ShieldCheck, FileText, Lock, UserCheck, ScrollText, AlertTriangle, ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

const SECTIONS = [
  {
    category: '법적·제도적',
    icon: FileText,
    color: 'text-primary',
    items: [
      { name: '개인정보처리 동의', detail: '가입 시 개인정보 처리·위탁·1인1계정 정책 동의 필수', component: '회원가입, PrivacyConsent' },
      { name: '서약서 관리', detail: '개인정보보호 서약서 제출(파트너사 의무), 1년 유효기간 관리', component: 'PrivacyConsent(valid_until)' },
      { name: '보관기한 준수', detail: '개인정보 보관기한(3년) 경과 시 자동 비식별화/삭제', component: 'processDataRetention, DataDeletionLog' },
    ],
  },
  {
    category: '접근 통제',
    icon: UserCheck,
    color: 'text-emerald-400',
    items: [
      { name: '다중인증(MFA)', detail: '이메일 6자리 인증코드 2단계 인증(5분 만료)', component: 'mfaSendCode, mfaVerifyCode, MfaToken' },
      { name: 'IP 접근 제한', detail: '사전 등록된 IP만 접근 허용, 미등록 IP 차단', component: 'checkIpAccess, IpWhitelist' },
      { name: '조직 및 역할 기반 권한', detail: '조직과 Business 관계로 Ticket 범위를 제한하고, 조직 내부 Admin / Operator와 승인 대기 Guest를 구분', component: 'Supabase RLS 및 RPC' },
      { name: '세션 만료', detail: '1시간 미조작 시 자동 로그아웃, 탭 간 동기화', component: 'useIdleTimeout' },
      { name: '계정 상태 관리', detail: '장기 미접속 경고·계정 차단(정지) 처리', component: 'account_status(suspended/inactive_warning)' },
    ],
  },
  {
    category: '데이터 보호',
    icon: Lock,
    color: 'text-blue-400',
    items: [
      { name: '파트너사 데이터 격리', detail: '소속사(org_type) 기반 티켓 조회 범위 제한', component: 'buildTicketVisibilityFilter' },
      { name: '개인정보 마스킹', detail: '목록·요약 화면에서 전화번호/이메일 부분 노출', component: 'mask.js' },
      { name: '전송·저장 암호화', detail: 'HTTPS 통신, 저장 데이터 자동 암호화(플랫폼 기본)', component: 'Base44 BaaS' },
    ],
  },
  {
    category: '감사·모니터링',
    icon: ScrollText,
    color: 'text-orange-400',
    items: [
      { name: '활동 기록', detail: '티켓 조회·상태변경·배정 등 민감 행위 감사로그', component: 'Activity(type=view 등)' },
      { name: '파기 이력 관리', detail: '비식별화/삭제 처리 건수·방법·실행주체 기록', component: 'DataDeletionLog' },
      { name: '알림', detail: 'SLA 경고·상태변경·배정 등 사용자 알림', component: 'Notification' },
    ],
  },
];

export default function PrivacyNotice() {
  return (
    <div className="space-y-5 max-w-5xl">
      {/* Back button */}
      <Link
        to="/my"
        className="flex items-center gap-1.5 h-8 px-3 text-xs font-medium border border-border rounded-md hover:bg-accent transition-colors text-muted-foreground hover:text-foreground w-fit"
      >
        <ArrowLeft className="w-3.5 h-3.5" /> 되돌아가기
      </Link>

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
          <ShieldCheck className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-foreground">개인정보보호 조치사항</h2>
          <p className="text-xs text-muted-foreground mt-0.5">PartnerDesk 개인정보 처리 방침 및 보호 조치 현황</p>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-accent/40">
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider w-28">구분</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">조치 항목</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">세부 내용</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider w-64 hidden md:table-cell">관련 구성요소</th>
            </tr>
          </thead>
          <tbody>
            {SECTIONS.map(section => {
              const Icon = section.icon;
              return section.items.map((item, idx) => (
                <tr key={`${section.category}-${item.name}`} className="border-b border-border last:border-0 hover:bg-accent/40 transition-colors">
                  {idx === 0 && (
                    <td className="px-4 py-3 align-top" rowSpan={section.items.length}>
                      <div className="flex items-center gap-1.5">
                        <Icon className={cn("w-3.5 h-3.5", section.color)} />
                        <span className="text-xs font-medium text-foreground">{section.category}</span>
                      </div>
                    </td>
                  )}
                  <td className="px-4 py-3 align-top">
                    <span className="text-xs font-medium text-foreground">{item.name}</span>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <span className="text-xs text-muted-foreground">{item.detail}</span>
                  </td>
                  <td className="px-4 py-3 align-top hidden md:table-cell">
                    <span className="text-[11px] text-muted-foreground font-mono">{item.component}</span>
                  </td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>

      {/* Notice */}
      <div className="rounded-lg border border-orange-500/20 bg-orange-500/5 p-4 flex items-start gap-2.5">
        <AlertTriangle className="w-4 h-4 text-orange-400 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="text-xs font-medium text-orange-400">보완 필요 사항</p>
          <p className="text-xs text-muted-foreground">
            모든 다운로드(티켓 엑셀 내보내기, 접속기록 백업 파일)에는 개인정보 마스킹이 적용됩니다. 이름·연락처·이메일·접속 IP는
            부분 마스킹되며, 원본 값은 시스템 내부에만 보관됩니다.
          </p>
        </div>
      </div>
    </div>
  );
}
