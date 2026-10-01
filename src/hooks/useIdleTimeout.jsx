import { useEffect, useRef } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { useToast } from '@/components/ui/use-toast';

const IDLE_LIMIT_MS = 15 * 60 * 1000; // 15분
const WARNING_MS = 5 * 60 * 1000; // 5분 전 경고
const STORAGE_KEY = 'idle_last_activity';
const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];

/**
 * 인증된 앱 화면에서 15분 동안 활동이 없으면 자동 로그아웃.
 * - 멀티 탭 동기화: localStorage 타임스탬프 공유로 한 탭의 활동이 다른 탭 타이머도 리셋
 * - 5분 전 안내 토스트 표시
 */
export function useIdleTimeout() {
  const { logout } = useAuth();
  const { toast } = useToast();
  const lastActivityRef = useRef(Date.now());
  const warningShownRef = useRef(false);

  const updateActivity = () => {
    const now = Date.now();
    lastActivityRef.current = now;
    warningShownRef.current = false;
    localStorage.setItem(STORAGE_KEY, String(now));
  };

  useEffect(() => {
    // 초기 활동 시간 동기화 (다른 탭의 활동 반영)
    const stored = localStorage.getItem(STORAGE_KEY);
    lastActivityRef.current = stored ? Number(stored) : Date.now();
    updateActivity();

    // 사용자 활동 이벤트로 타이머 리셋
    ACTIVITY_EVENTS.forEach(evt => {
      window.addEventListener(evt, updateActivity, { passive: true });
    });

    // 다른 탭의 활동 반영
    const onStorage = (e) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        lastActivityRef.current = Number(e.newValue);
        warningShownRef.current = false;
      }
    };
    window.addEventListener('storage', onStorage);

    // 10초 간격으로 유휴 시간 검사
    const interval = setInterval(() => {
      const idleMs = Date.now() - lastActivityRef.current;
      if (idleMs >= IDLE_LIMIT_MS) {
        clearInterval(interval);
        toast({
          title: '자동 로그아웃',
          description: '15분 동안 활동이 없어 로그아웃되었습니다.',
          variant: 'destructive',
        });
        logout(true);
      } else if (idleMs >= IDLE_LIMIT_MS - WARNING_MS && !warningShownRef.current) {
        warningShownRef.current = true;
        toast({
          title: '로그아웃 예정',
          description: '5분 내에 활동이 없으면 자동 로그아웃됩니다.',
        });
      }
    }, 10000);

    return () => {
      ACTIVITY_EVENTS.forEach(evt => window.removeEventListener(evt, updateActivity));
      window.removeEventListener('storage', onStorage);
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}