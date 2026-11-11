import {readFile,stat} from 'node:fs/promises';
import {validateBackupFile} from '../src/lib/auditBackup.js';

try {
 const path=process.argv[2];
 if(!path)throw new Error('사용법: node scripts/verify-audit-backup.mjs <백업 JSON 파일>');
 if((await stat(path)).size>8388608)throw new Error('지원하는 백업 파일 크기를 초과했습니다.');
 const envelope=JSON.parse(await readFile(path,'utf8')),payload=await validateBackupFile(envelope);
 console.log(JSON.stringify({status:'파일 내부 체크섬·건수 일치',export_id:envelope.export_id,period:payload.period,counts:payload.counts,
  note:'이 검사는 서버 발급 기록 대조, DRM 확인 또는 실제 복구 시험을 대신하지 않습니다.'},null,2));
}catch(error){console.error('백업 검증 실패: '+error.message);process.exitCode=1;}
