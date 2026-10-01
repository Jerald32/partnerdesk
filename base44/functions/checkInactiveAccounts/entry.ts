import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { requireVerifiedEmail } from '../../shared/verifyUser.ts';

const PARTNER_ROLES = ['partner', 'partner_admin'];
const WARNING_DAYS = 23;
const SUSPEND_DAYS = 30;

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);

    // 인증 가드: 사용자 토큰이 있으면 관리자만 허용, 스케줄 실행(토큰 없음)은 허용
    let user = null;
    const isAuth = await base44.auth.isAuthenticated();
    if (isAuth) {
      user = await base44.auth.me();
    }
    if (user !== null && user.role !== 'admin') {
      return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });
    }

    // 이메일 인증 미완료 사용자 차단
    const denied = requireVerifiedEmail(user);
    if (denied) return denied;

    const svc = base44.asServiceRole;
    const now = new Date();
    const warningThreshold = new Date(now.getTime() - WARNING_DAYS * 24 * 60 * 60 * 1000);
    const suspendThreshold = new Date(now.getTime() - SUSPEND_DAYS * 24 * 60 * 60 * 1000);

    // 파트너 역할 사용자 조회
    const allUsers = await svc.entities.User.list('-created_date', 500);
    const partnerUsers = allUsers.filter(u => PARTNER_ROLES.includes(u.role));

    const warned = [];
    const suspended = [];

    for (const u of partnerUsers) {
      // 이미 차단된 사용자는 스킵
      if (u.account_status === 'suspended') continue;

      // last_login_date가 없으면 스킵 (최초 배포 안전장치 — 로그인 시점부터 추적 시작)
      if (!u.last_login_date) continue;

      const lastActive = new Date(u.last_login_date);

      if (lastActive < suspendThreshold) {
        // 30일 이상 미접속 → 차단
        await svc.entities.User.update(u.id, { account_status: 'suspended' });
        suspended.push(u);
      } else if (lastActive < warningThreshold && u.account_status !== 'inactive_warning') {
        // 23일 이상 미접속 → 경고
        await svc.entities.User.update(u.id, { account_status: 'inactive_warning' });
        warned.push(u);
      }
    }

    // 경고 이메일 발송
    for (const u of warned) {
      try {
        await svc.integrations.Core.SendEmail({
          to: u.email,
          subject: '[PartnerDesk] 계정 미접속 안내',
          body: [
            '안녕하세요,',
            '',
            '최근 23일 이상 PartnerDesk 시스템 접속 이력이 없습니다.',
            '7일 이내에 로그인하지 않을 경우 계정이 자동 차단됩니다.',
            '',
            'PartnerDesk 시스템에 로그인하여 계정 사용 여부를 확인해 주세요.',
          ].join('\n'),
        });
      } catch (e) { /* 이메일 발송 실패는 무시 */ }
    }

    // 차단 이메일 발송
    for (const u of suspended) {
      try {
        await svc.integrations.Core.SendEmail({
          to: u.email,
          subject: '[PartnerDesk] 계정 차단 안내',
          body: [
            '안녕하세요,',
            '',
            '최근 30일 이상 시스템 접속 이력이 없어 계정이 차단되었습니다.',
            '계정 재사용을 원하시는 경우 관리자에게 문의해 주세요.',
          ].join('\n'),
        });
      } catch (e) { /* 이메일 발송 실패는 무시 */ }
    }

    return Response.json({
      processed_at: now.toISOString(),
      warned_count: warned.length,
      suspended_count: suspended.length,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}