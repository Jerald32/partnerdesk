export function messageText(kind) {
  if (kind === 'warning') return { subject: '[PartnerDesk] 계정 미접속 안내',
    text: '최근 23일 이상 PartnerDesk 접속 이력이 없습니다. 마지막 로그인으로부터 30일이 지나면 계정이 자동 차단됩니다. 계속 사용하려면 로그인해 주세요.' };
  if (kind === 'suspended') return { subject: '[PartnerDesk] 계정 차단 안내',
    text: '최근 30일 이상 PartnerDesk 접속 이력이 없어 계정이 차단되었습니다. 재사용을 원하시면 관리자에게 활성화를 요청해 주세요.' };
  throw new Error('invalid_mail_kind');
}

export function createWorker({ authorize, rpc, send, ready }) {
  return async request => {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    if (!await authorize(request.headers.get('authorization'))) return new Response(null, { status: 401 });
    const readiness = await ready();
    if (readiness !== true) return Response.json({ error: typeof readiness === 'string' ? readiness : 'smtp_not_configured' }, { status: 503 });
    try {
      const { messages } = await rpc('backend_claim_inactivity_mail', {});
      let sent = 0, failed = 0;
      // At most ten concurrent deliveries; each SMTP operation has a timeout.
      await Promise.all(messages.map(async item => {
        let accepted = false;
        try { await send({ ...item, ...messageText(item.kind) }); accepted = true; } catch { /* Retry using the durable queue. */ }
        const result = await rpc('backend_finish_inactivity_mail', { p_id: item.id, p_lease_id: item.lease_id, p_sent: accepted });
        if (!result.ok) return;
        if (accepted) sent++; else failed++;
      }));
      return Response.json({ sent, failed }, { status: failed ? 503 : 200 });
    } catch { return Response.json({ error: 'mail_worker_failed' }, { status: 503 }); }
  };
}
