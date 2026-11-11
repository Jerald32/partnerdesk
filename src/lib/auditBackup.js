const sets=['access_logs','access_reviews','access_review_decisions','access_review_items'];
export async function backupDigest(value) {
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
 return Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export function backupDates(now=new Date()) {
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(p=>[p.type,p.value]));
 const today=new Date(Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day)));
 return {today:today.toISOString().slice(0,10),yesterday:new Date(today.getTime()-86400000).toISOString().slice(0,10)};
}
export async function validateBackupFile(envelope) {
 if(envelope?.format!=='partnerdesk-audit-backup-v1'||typeof envelope.payload_json!=='string'
  ||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(envelope.export_id)||!/^[a-f0-9]{64}$/.test(envelope.payload_sha256))throw new Error('invalid_backup');
 if(await backupDigest(envelope.payload_json)!==envelope.payload_sha256)throw new Error('backup_checksum_mismatch');
 const payload=JSON.parse(envelope.payload_json);
 if(payload?.format!=='partnerdesk-audit-data-v1'||payload.export_id!==envelope.export_id
  ||!/^\d{4}-\d{2}-\d{2}$/.test(payload.period?.from)||!/^\d{4}-\d{2}-\d{2}$/.test(payload.period?.to_inclusive)
  ||!sets.every(key=>Array.isArray(payload[key])&&Number.isSafeInteger(payload.counts?.[key])&&payload[key].length===payload.counts[key]))throw new Error('backup_count_mismatch');
 return payload;
}
export async function prepareBackup(response) {
 const envelope={format:'partnerdesk-audit-backup-v1',export_id:response?.export_id,payload_sha256:response?.sha256,payload_json:response?.payload_json};
 const payload=await validateBackupFile(envelope);
 if(!sets.every(key=>response.counts?.[key]===payload.counts[key]))throw new Error('backup_count_mismatch');
 return {envelope,payload,filename:`PartnerDesk-접속기록백업-${payload.period.from}_${payload.period.to_inclusive}-${envelope.export_id}.json`};
}
export function backupError(error) {
 return ({backup_too_large:'백업 크기가 제한을 초과했습니다. 더 짧은 기간으로 나누어 다운로드해 주세요. 계속 초과하면 분할 백업 지원이 필요합니다.',
  invalid_backup_range_or_reason:'백업 기간은 최대 31일이며 오늘 이후는 선택할 수 없습니다. 백업 사유도 입력해 주세요.',
  backup_not_available:'해당 백업을 생성한 관리자만 보관 확인을 남길 수 있습니다.',
  backup_checksum_mismatch:'백업의 체크섬이 일치하지 않습니다. 파일을 수정하지 말고 원본을 다시 확인해 주세요.',
  backup_count_mismatch:'백업 파일의 기록 건수가 일치하지 않습니다.',invalid_backup:'지원하는 접속기록 백업 파일이 아닙니다.'})[error.message]
  ||(error.code==='42501'?'전역 관리자 권한과 로그인 상태를 확인해 주세요.':'백업을 처리하지 못했습니다. 연결 상태와 백업 기능 반영 여부를 확인해 주세요.');
}
