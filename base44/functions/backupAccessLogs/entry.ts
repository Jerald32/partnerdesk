import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { requireVerifiedEmail } from '../../shared/verifyUser.ts';
import { verifyAccessLogChain, buildAccessLogCsv, sha256Hex } from '../../shared/accessLog.ts';

// 접속기록 보관·백업 관리
// - 백업 실행: 전체 접속기록을 무결성 검증한 뒤 별도 보관용 파일(비공개 저장소)로 생성하고 이력을 남긴다
// - verify: 접속기록 위·변조 여부 검증
// - download: 보관된 백업 파일 일회성 다운로드 링크 발급
const PAGE_SIZE = 500;
const MAX_RECORDS = 20000;

async function loadAllLogs(svc: any) {
  const all: any[] = [];
  let cursor: any = null;
  do {
    const page: any = await svc.entities.AccessLog.filter({}, { sort: '-created_date', limit: PAGE_SIZE, cursor });
    const items = page?.items || [];
    if (!items.length) break;
    all.push(...items);
    cursor = page?.has_more ? page.next_cursor : null;
  } while (cursor && all.length < MAX_RECORDS);
  return all;
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);

    // 인증 가드: 사용자 토큰이 있으면 관리자만 허용, 스케줄 실행(토큰 없음)은 허용
    let user: any = null;
    if (await base44.auth.isAuthenticated()) user = await base44.auth.me();
    if (user && user.role !== 'admin') {
      return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });
    }
    const denied = requireVerifiedEmail(user);
    if (denied) return denied;

    const svc = base44.asServiceRole;
    const body = await req.json().catch(() => ({}));
    const action = body?.action || 'backup';

    // 무결성 검증
    if (action === 'verify') {
      const logs = await loadAllLogs(svc);
      const result = await verifyAccessLogChain(logs);
      return Response.json({ total: logs.length, ...result });
    }

    // 보관된 백업 파일 내려받기
    if (action === 'download') {
      const backupId = body?.backup_id;
      if (!backupId) return Response.json({ error: '백업 ID가 필요합니다.' }, { status: 400 });
      const found = await svc.entities.AccessLogBackup.filter({ id: backupId });
      const backup = found?.[0];
      if (!backup?.file_uri) return Response.json({ error: '백업 파일을 찾을 수 없습니다.' }, { status: 404 });
      const signed: any = await svc.integrations.Core.CreateFileSignedUrl({
        file_uri: backup.file_uri,
        expires_in: 300,
      });
      return Response.json({ signed_url: signed?.signed_url || '', file_name: backup.file_name || '' });
    }

    // 백업 실행
    const logs = await loadAllLogs(svc);
    const integrity = await verifyAccessLogChain(logs);
    const csv = buildAccessLogCsv(logs);
    const fileHash = await sha256Hex(csv);
    const runDate = new Date().toISOString();
    const stamp = runDate.slice(0, 19).replace(/[-:T]/g, '');
    const fileName = `access-log-backup-${stamp}.csv`;

    const uploaded: any = await svc.integrations.Core.UploadPrivateFile({
      file: new File([csv], fileName, { type: 'text/csv' }),
    });

    const seqs = logs.map((l) => l.seq).filter((s) => typeof s === 'number');
    const times = logs.map((l) => l.accessed_at).filter(Boolean).sort();

    await svc.entities.AccessLogBackup.create({
      run_date: runDate,
      period_start: times[0] || null,
      period_end: times[times.length - 1] || null,
      log_count: logs.length,
      first_seq: seqs.length ? seqs.reduce((a, b) => (a < b ? a : b)) : null,
      last_seq: seqs.length ? seqs.reduce((a, b) => (a > b ? a : b)) : null,
      file_name: fileName,
      file_uri: uploaded?.file_uri || '',
      file_hash: fileHash,
      integrity_ok: integrity.ok,
      integrity_detail: integrity.ok ? '무결성 이상 없음' : integrity.issues.slice(0, 5).join(' / '),
      triggered_by: user ? 'manual' : 'automation',
      actor_email: user?.email || '',
    });

    return Response.json({
      ok: true,
      run_date: runDate,
      log_count: logs.length,
      file_name: fileName,
      file_uri: uploaded?.file_uri || '',
      file_hash: fileHash,
      integrity,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}