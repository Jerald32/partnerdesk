import { base44 } from '@/api/base44Client';

// 접속기록 기록 (실패해도 사용자 화면 동작을 막지 않음)
export function logAccess(payload) {
  return base44.functions.invoke('recordAccess', payload).catch(() => {});
}