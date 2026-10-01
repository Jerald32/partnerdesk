// 개인정보처리시스템 접속기록 공통 모듈
// 기록 항목: 접속자 식별자, 접속 일시, 접속지 정보(IP), 처리한 정보주체의 정보, 수행 업무
// 식별자·IP는 항상 서버에서 확인한 값만 사용한다 (클라이언트 전달값 신뢰 금지)
// 위·변조 방지: 모든 기록에 연번(seq)과 직전 기록 해시를 연결한 무결성 해시를 함께 남긴다.
import { secrets } from 'base44:runtime';
import { maskName, maskEmail, maskIp, maskText } from './mask.ts';

const GENESIS = 'GENESIS';
const FALLBACK_SALT = 'partnerdesk-access-log';

function salt() {
  try {
    return secrets.get('BASE44_APP_ID') || FALLBACK_SALT;
  } catch {
    return FALLBACK_SALT;
  }
}

// 해시 대상이 되는 기록 항목을 고정 순서로 직렬화 (순서가 바뀌면 기존 기록 검증이 깨지므로 변경 금지)
function canonical(record: any) {
  return [
    record.seq,
    record.user_id,
    record.user_name,
    record.user_email,
    record.user_role,
    record.user_ip,
    record.accessed_at,
    record.action,
    record.target_type,
    record.target_id,
    record.subject_info,
    record.detail,
    record.prev_hash,
  ]
    .map((v) => (v === undefined || v === null ? '' : String(v)))
    .join('|');
}

export async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function computeHash(record: any) {
  return sha256Hex(`${salt()}::${canonical(record)}`);
}

export async function recordAccessLog(base44: any, { user, ip, action, targetType, targetId, subjectInfo, detail }: any) {
  const svc = base44.asServiceRole;

  // 직전 기록의 무결성 해시를 이어받아 연결고리를 만든다
  const recent = await svc.entities.AccessLog.list('-created_date', 10);
  const prev = (recent || []).find((r: any) => r && r.record_hash) || null;

  const record: any = {
    seq: prev ? (prev.seq || 0) + 1 : 1,
    user_id: user?.id || '',
    user_name: user?.display_name || user?.full_name || user?.email || '',
    user_email: user?.email || '',
    user_role: user?.role || '',
    user_ip: ip || '',
    accessed_at: new Date().toISOString(),
    action: action || '조회',
    target_type: targetType || '',
    target_id: targetId || '',
    subject_info: subjectInfo || '',
    detail: detail || '',
    prev_hash: prev ? prev.record_hash : GENESIS,
  };
  record.record_hash = await computeHash(record);

  await svc.entities.AccessLog.create(record);
}

// 접속기록 무결성 검증: 각 기록의 해시 재계산 + 연결고리 연속성 확인
export async function verifyAccessLogChain(records: any[]) {
  const protectedRecords = (records || [])
    .filter((r) => r && r.record_hash)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));

  const issues: string[] = [];

  for (let i = 0; i < protectedRecords.length; i += 1) {
    const record = protectedRecords[i];
    const expected = await computeHash(record);
    if (expected !== record.record_hash) {
      issues.push(`연번 ${record.seq} 기록의 내용이 변경되었습니다 (해시 불일치)`);
    }
    const expectedPrev = i === 0 ? GENESIS : protectedRecords[i - 1].record_hash;
    if ((record.prev_hash || '') !== expectedPrev) {
      issues.push(`연번 ${record.seq} 기록의 연결고리가 끊어졌습니다 (누락 또는 삽입)`);
    }
  }

  return {
    checked: protectedRecords.length,
    protected_count: protectedRecords.length,
    legacy_count: (records || []).length - protectedRecords.length,
    ok: issues.length === 0,
    issues,
  };
}

const CSV_HEADERS = [
  '연번',
  '접속일시',
  '접속자ID',
  '접속자명(마스킹)',
  '접속자이메일(마스킹)',
  '등급',
  '접속지정보(IP·마스킹)',
  '수행업무',
  '업무대상',
  '대상ID',
  '처리한 정보주체의 정보(마스킹)',
  '상세(마스킹)',
  '무결성해시',
];

function csvCell(value: any) {
  const text = value === undefined || value === null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

// 엑셀에서 한글이 깨지지 않도록 UTF-8 BOM 을 붙인다
// 내려받는 파일이므로 접속자 식별정보·처리한 정보주체의 정보는 마스킹해서 내보낸다
export function buildAccessLogCsv(records: any[]) {
  const rows = (records || []).map((r) =>
    [
      r.seq,
      r.accessed_at,
      r.user_id,
      maskName(r.user_name),
      maskEmail(r.user_email),
      r.user_role,
      maskIp(r.user_ip),
      r.action,
      r.target_type,
      r.target_id,
      maskText(r.subject_info),
      maskText(r.detail),
      r.record_hash,
    ]
      .map(csvCell)
      .join(',')
  );
  return `\uFEFF${[CSV_HEADERS.map(csvCell).join(','), ...rows].join('\r\n')}`;
}