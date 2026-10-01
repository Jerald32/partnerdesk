import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import { requireVerifiedEmail } from '../../shared/verifyUser.ts';

// 개인정보 보호: 입력 후 3년 경과 이력 비식별화/삭제 및 파기 이력 기록
// - Ticket(입력일 + 3년, 상태 무관): PII 비식별화 (레코드는 통계 목적 보존)
// - 연관 Activity / Notification: 삭제
// - DataDeletionLog: 항목별 파기 이력(건수 포함) 기록
Deno.serve(async (req) => {
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
    const RETENTION_MS = 3 * 365 * 24 * 60 * 60 * 1000; // 3년
    const threshold = new Date(Date.now() - RETENTION_MS);
    const thresholdStr = threshold.toISOString();
    const runDate = new Date().toISOString();
    const triggeredBy = user ? 'manual' : 'automation';

    // 1. 입력일(created_date) 기준 보관기한(3년) 경과 & 미처리 티켓 조회 (오래된 순, 상태 무관)
    const expired = await svc.entities.Ticket.filter(
      {
        created_date: { $lt: thresholdStr },
        $or: [{ retention_processed_at: { $exists: false } }, { retention_processed_at: null }],
      },
      'created_date',
      500 // bulkUpdate 한도 500건/회
    );

    if (expired.length === 0) {
      await svc.entities.DataDeletionLog.create({
        run_date: runDate,
        retention_threshold: thresholdStr.split('T')[0],
        entity_type: 'ticket',
        method: 'anonymized',
        count: 0,
        details: '처리 대상 없음',
        triggered_by: triggeredBy,
      });
      return Response.json({ processed_at: runDate, threshold: thresholdStr, tickets_anonymized: 0, message: '처리 대상 없음' });
    }

    const ticketIds = expired.map(t => t.id);

    // 2. 관련 활동/알림 건수 집계 (파기 이력용)
    const relatedActivities = await svc.entities.Activity.filter({ ticket_id: { $in: ticketIds } }, '-created_date', 1000);
    const relatedNotifications = await svc.entities.Notification.filter({ ticket_id: { $in: ticketIds } }, '-created_date', 1000);

    // 3. 티켓 비식별화 (PII 제거, 레코드는 통계 목적 보존)
    await svc.entities.Ticket.bulkUpdate(
      expired.map(t => ({
        id: t.id,
        customer_name: '비식별화',
        customer_contact: '비식별화',
        description: '',
        request_detail: '',
        attachments: [],
        retention_processed_at: runDate,
      }))
    );

    // 4. 관련 활동/알림 삭제
    await svc.entities.Activity.deleteMany({ ticket_id: { $in: ticketIds } });
    await svc.entities.Notification.deleteMany({ ticket_id: { $in: ticketIds } });

    // 5. 파기 이력 기록 (항목별)
    await svc.entities.DataDeletionLog.bulkCreate([
      {
        run_date: runDate,
        retention_threshold: thresholdStr.split('T')[0],
        entity_type: 'ticket',
        method: 'anonymized',
        count: expired.length,
        details: `비식별화: ${ticketIds.join(', ')}`,
        triggered_by: triggeredBy,
      },
      {
        run_date: runDate,
        retention_threshold: thresholdStr.split('T')[0],
        entity_type: 'activity',
        method: 'deleted',
        count: relatedActivities.length,
        details: `연관 활동 ${relatedActivities.length}건 삭제`,
        triggered_by: triggeredBy,
      },
      {
        run_date: runDate,
        retention_threshold: thresholdStr.split('T')[0],
        entity_type: 'notification',
        method: 'deleted',
        count: relatedNotifications.length,
        details: `연관 알림 ${relatedNotifications.length}건 삭제`,
        triggered_by: triggeredBy,
      },
    ]);

    return Response.json({
      processed_at: runDate,
      threshold: thresholdStr,
      tickets_anonymized: expired.length,
      activities_deleted: relatedActivities.length,
      notifications_deleted: relatedNotifications.length,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});