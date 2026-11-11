const actions={audit_backup_exported:'접속기록 백업 파일 생성',audit_backup_storage_confirmed:'사내 백업 보관 확인',login_session:'로그인 및 업무 세션 발급',logout:'로그아웃',session_blocked:'접속 세션 차단',ticket_detail_read:'티켓 상세·개인정보 조회',
 tickets_delete:'티켓 삭제',ticket_attachments_insert:'첨부파일 정보 등록',ticket_attachments_update:'첨부파일 정보 수정',ticket_attachments_delete:'첨부파일 정보 삭제',
 ip_denied:'허용되지 않은 IP 접속 차단',ip_monitor:'접속 IP 점검',ip_monitor_only:'접속 IP 점검',admin_ip_exempt:'관리자 IP 예외 적용',
 ip_recovery_path_confirmed:'접속 복구 경로 확인',access_review_requested:'접속기록 점검 승인 요청',access_review_approved:'접속기록 점검 승인',
 access_review_rejected:'접속기록 점검 반려',access_review_withdrawn:'접속기록 점검 요청 회수',access_review_viewed:'접속기록 점검 내역 조회'};
const mfa={requested:'인증번호 요청',delivery_accepted:'인증번호 발송 접수',delivery_failed:'인증번호 발송 실패',attempt:'인증 시도',verified:'인증 성공',failed:'인증 실패',locked:'인증 잠금',rate_limited:'인증 요청 횟수 제한'};
const results={success:'성공',denied:'차단',failed:'실패',failure:'실패',blocked:'차단',admin_exempt:'관리자 IP 예외',monitor:'모니터링',pending:'처리 대기'};
const targets={AuditBackup:'접속기록 백업',Ticket:'티켓',Profile:'사용자 계정',User:'사용자 계정',Organization:'조직',Partner:'파트너',Business:'비즈니스',Authentication:'인증·세션',Gateway:'접속 경로',AccessReview:'접속기록 점검',RoleRequest:'권한 신청',TicketAttachment:'첨부파일',IPPolicy:'IP 접근 정책',PrivacyConsent:'개인정보 동의'};
export function accessMetadata(row) {
 if(row.metadata&&typeof row.metadata==='object'&&!Array.isArray(row.metadata))return row.metadata;
 try{const value=JSON.parse(row.metadata);return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}
}
const present=value=>typeof value==='string'&&value.trim()?value:null;
export function accessIdentity(row) {
 const metadata=accessMetadata(row),system=metadata.actor_kind==='system'||row.user_id==='system';
 const originalOrg=present(metadata.organization_name_snapshot),recordedOrgId=present(row.organization_id)||present(metadata.organization_id);
 return {name:system?'시스템':present(row.user_name)||present(row.current_name)||'이름 정보 없음',
  email:present(row.user_email)||present(row.current_email)||'이메일 정보 없음',
  nameSource:present(row.user_name)?'기록 당시':'현재 정보',emailSource:present(row.user_email)?'기록 당시':'현재 정보',
  organization:originalOrg||present(row.recorded_organization_name)||present(row.current_organization_name)||'소속 정보 없음',
  organizationSource:originalOrg?'기록 당시':recordedOrgId&&present(row.recorded_organization_name)?'기록된 소속의 현재 명칭':'현재 정보',
  accountId:present(row.actor_profile_id)||present(row.user_id)||present(metadata.auth_user_id)||'계정 식별자 기록 없음',system};
}
export function accessAction(value) {
 if(!value)return '업무 기록 없음';
 if(actions[value])return actions[value];
 if(value.startsWith('이메일 MFA ')){const suffix=value.slice('이메일 MFA '.length);return mfa[suffix]?'이메일 2차 인증 · '+mfa[suffix]:'이메일 2차 인증';}
 return /[가-힣]/.test(value)?value:'기타 업무';
}
export const accessResult=row=>{const value=row.result??accessMetadata(row).result;return results[value]||(value?'기타 결과':'결과 기록 없음');};
export const accessTarget=value=>targets[value]||(value?'기타 처리 대상':'처리 대상 없음');

// Read current labels through the existing authenticated/RLS-protected gateway.
// This also enriches responses from the older audit RPC before DB rollout.
export async function enrichAccessRows(client,rows,signal) {
 const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
 let failed=false;
 async function lookup(table,fields,ids){
  const unique=[...new Set(ids.filter(uuid))],chunks=[];
  for(let start=0;start<unique.length;start+=100)chunks.push(unique.slice(start,start+100));
  const results=await Promise.all(chunks.map(async chunk=>{
   try{const {data,error}=await client.from(table).select(fields).in('id',chunk).order('id').limit(100).abortSignal(signal);
    if(error||!Array.isArray(data))throw new Error('identity_lookup_failed');return data;
   }catch(error){if(signal.aborted)throw error;failed=true;return [];}
  }));return new Map(results.flat().map(value=>[value.id,value]));
 }
 const profiles=await lookup('profiles','id,display_name,full_name,email,organization_id',rows.map(row=>row.actor_profile_id));
 const organizations=await lookup('organizations','id,name',[
  ...rows.map(row=>row.organization_id||accessMetadata(row).organization_id),...Array.from(profiles.values(),p=>p.organization_id),...rows.map(row=>row.current_organization_id)]);
 return rows.map(row=>{const profile=profiles.get(row.actor_profile_id),recordedOrgId=row.organization_id||accessMetadata(row).organization_id;
  return {...row,current_name:row.current_name||profile?.display_name||profile?.full_name,current_email:row.current_email||profile?.email,
   current_organization_id:row.current_organization_id||profile?.organization_id,
   current_organization_name:row.current_organization_name||organizations.get(profile?.organization_id||row.current_organization_id)?.name,
   recorded_organization_name:row.recorded_organization_name||organizations.get(recordedOrgId)?.name,identity_lookup_failed:failed};
 });
}
