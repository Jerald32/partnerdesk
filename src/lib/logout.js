import { base44 } from '@/api/base44Client';
import { clearSessionId } from '@/lib/session';

// 보안 로그아웃: 서버에 세션 무효화(전체 기기·토큰 재사용 차단)를 기록한 뒤 플랫폼 로그아웃을 수행한다.
// 무효화 요청이 실패해도 로그아웃 자체는 진행한다.
export async function secureLogout(redirectUrl) {
  try {
    await base44.functions.invoke('revokeSession', {});
  } catch (e) {
    // 세션 무효화 실패 시에도 로컬 로그아웃은 진행 (서버 측 토큰 만료 시점까지 잔여 위험)
  }
  clearSessionId();
  base44.auth.logout(redirectUrl);
}