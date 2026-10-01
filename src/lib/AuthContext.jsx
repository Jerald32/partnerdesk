import React, { createContext, useState, useContext, useEffect, useCallback, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { secureLogout } from '@/lib/logout';
import { clearSessionId, clearAuthCache, setSessionEndedHandler, markIpDenied, clearIpDenied } from '@/lib/session';
import { appParams } from '@/lib/app-params';
import { isPartnerRole } from '@/lib/roles';
import { createAxiosClient } from '@base44/sdk/dist/utils/axios-client';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [isLoadingPublicSettings, setIsLoadingPublicSettings] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [mfaVerified, setMfaVerified] = useState(false);
  const [mfaEnabled, setMfaEnabled] = useState(true);
  const [privacyConsentValid, setPrivacyConsentValid] = useState(false);
  const [emailVerified, setEmailVerified] = useState(false);
  const [ipAllowed, setIpAllowed] = useState(true);
  const [appPublicSettings, setAppPublicSettings] = useState(null); // Contains only { id, public_settings }
  const [sessionEndedReason, setSessionEndedReason] = useState(null);
  const endingRef = useRef(false);

  // 세션 종료 처리(중복 로그인·무효화·재인증 만료):
  // 짧은 안내를 화면에 표시한 뒤 플랫폼 로그아웃으로 로그인 화면까지 이동시킨다.
  const endSession = useCallback((reason) => {
    if (endingRef.current) return;
    endingRef.current = true;
    setSessionEndedReason(reason);
    clearAuthCache();
    clearSessionId();
    setTimeout(() => {
      base44.auth.logout(`/login?reason=${reason}`);
    }, 2500);
  }, []);

  // 백엔드 함수가 세션 거부(401)를 반환한 경우에도 동일한 종료 절차를 수행
  useEffect(() => {
    setSessionEndedHandler(endSession);
  }, [endSession]);

  useEffect(() => {
    checkAppState();
  }, []);

  const checkAppState = async () => {
    try {
      setIsLoadingPublicSettings(true);
      setAuthError(null);
      
      // First, check app public settings (with token if available)
      // This will tell us if auth is required, user not registered, etc.
      const appClient = createAxiosClient({
        baseURL: `/api/apps/public`,
        headers: {
          'X-App-Id': appParams.appId
        },
        token: appParams.token, // Include token if available
        interceptResponses: true
      });
      
      try {
        const publicSettings = await appClient.get(`/prod/public-settings/by-id/${appParams.appId}`);
        setAppPublicSettings(publicSettings);
        
        // If we got the app public settings successfully, check if user is authenticated
        if (appParams.token) {
          await checkUserAuth();
        } else {
          setIsLoadingAuth(false);
          setIsAuthenticated(false);
          setAuthChecked(true);
        }
        setIsLoadingPublicSettings(false);
      } catch (appError) {
        console.error('App state check failed:', appError);
        
        // Handle app-level errors
        if (appError.status === 403 && appError.data?.extra_data?.reason) {
          const reason = appError.data.extra_data.reason;
          if (reason === 'auth_required') {
            setAuthError({
              type: 'auth_required',
              message: 'Authentication required'
            });
          } else if (reason === 'user_not_registered') {
            setAuthError({
              type: 'user_not_registered',
              message: 'User not registered for this app'
            });
          } else {
            setAuthError({
              type: reason,
              message: appError.message
            });
          }
        } else {
          setAuthError({
            type: 'unknown',
            message: appError.message || 'Failed to load app'
          });
        }
        setIsLoadingPublicSettings(false);
        setIsLoadingAuth(false);
      }
    } catch (error) {
      console.error('Unexpected error:', error);
      setAuthError({
        type: 'unknown',
        message: error.message || 'An unexpected error occurred'
      });
      setIsLoadingPublicSettings(false);
      setIsLoadingAuth(false);
    }
  };

  const checkUserAuth = async () => {
    try {
      // Now check if the user is authenticated
      setIsLoadingAuth(true);
      const currentUser = await base44.auth.me();
      setUser(currentUser);
      setIsAuthenticated(true);
      // 이메일 인증 여부 확인 (세션 캐시 없이 매 로그인 시 수행)
      setEmailVerified(currentUser.is_verified !== false);
      // MFA 설정 확인 (관리자가 비활성화한 경우 2차 인증 생략)
      let mfaOn = true;
      const cachedMfa = sessionStorage.getItem(`mfa_enabled_${currentUser.id}`);
      if (cachedMfa !== null) {
        mfaOn = cachedMfa !== 'false';
      } else {
        try {
          const mfaRes = await base44.functions.invoke('getMfaSetting', {});
          mfaOn = mfaRes.data?.enabled !== false;
          sessionStorage.setItem(`mfa_enabled_${currentUser.id}`, String(mfaOn));
        } catch (e) {
          mfaOn = true;
        }
      }
      setMfaEnabled(mfaOn);
      // 이 탭에서 인증을 마쳤는지(임시 표시) + 이 기기의 세션 식별자
      const mfaFlag = sessionStorage.getItem(`mfa_verified_${currentUser.id}`) === 'true';

      // 서버 측 세션 상태 조회 — 인증 완료 여부 판정과 무효화(로그아웃·중복 로그인·재인증 만료) 감지에 함께 사용
      // (세션 가드가 적용되지 않는 함수이므로 인증 진행 중에도 안전하게 호출할 수 있다)
      let sessionStatus = null;
      try {
        const sessRes = await base44.functions.invoke('getSessionStatus', {});
        sessionStatus = sessRes.data || null;
      } catch (e) {
        // 상태 조회 실패 시 서버 측 가드에 맡김
      }

      // 인증 완료 여부: 이 탭의 인증 완료 표시 또는 서버 기록상 이 기기의 인증(식별자 일치·유효)
      // 서버 기록을 근거로 삼으므로 인증 직후 임시 표시가 사라져도 인증 화면으로 되돌아가지 않는다.
      const verified = !mfaOn || mfaFlag || !!sessionStatus?.authenticated;
      setMfaVerified(verified);

      // 인증된 세션이 무효화(다른 기기 인증·로그아웃·8시간 경과)된 경우에만 종료 안내 후 로그인 화면으로 이동
      // (인증을 마치기 전에는 무효화 기록이 남아 있어도 종료 처리하지 않는다)
      if (verified && sessionStatus && (sessionStatus.concurrent || sessionStatus.revoked || sessionStatus.expired)) {
        // 중복 로그인(다른 기기 인증) → 무효화 → 재인증 만료 순으로 사유 판정
        const reason = sessionStatus.concurrent
          ? 'concurrent_login'
          : sessionStatus.revoked
            ? 'session_revoked'
            : 'reauth_required';
        endSession(reason);
        return;
      }

      // 개인정보보호 서약서 유효성 확인 (파트너 역할만)
      if (isPartnerRole(currentUser)) {
        try {
          const consents = await base44.entities.PrivacyConsent.filter(
            { user_id: currentUser.id },
            '-consent_date',
            1
          );
          const hasValid = consents.length > 0 && consents[0].valid_until && new Date(consents[0].valid_until) > new Date();
          setPrivacyConsentValid(hasValid);
        } catch (e) {
          setPrivacyConsentValid(true);
        }
      } else {
        setPrivacyConsentValid(true);
      }

      // IP 접근 제한 확인 (관리자 포함 모든 역할 적용, 세션 스토리지 캐시)
      // 이메일 인증 완료 전에는 세션 검증이 적용되는 요청을 보내지 않는다 —
      // 로그아웃 직후 재로그인 시 무효화된 세션으로 거부되어 로그인 반복이 발생하는 것을 막는다.
      // (인증 단계의 IP 제한은 인증번호 발송·검증 함수가 서버에서 직접 검사한다)
      if (!verified) {
        setIpAllowed(true);
      } else if (sessionStorage.getItem(`ip_allowed_${currentUser.id}`) === 'true') {
        setIpAllowed(true);
        clearIpDenied();
      } else {
        try {
          const ipRes = await base44.functions.invoke('checkIpAccess', {});
          const allowed = ipRes.data?.allowed !== false;
          setIpAllowed(allowed);
          if (allowed) {
            clearIpDenied();
            sessionStorage.setItem(`ip_allowed_${currentUser.id}`, 'true');
          } else {
            markIpDenied(ipRes.data?.ip);
          }
        } catch (e) {
          setIpAllowed(true);
        }
      }

      setIsLoadingAuth(false);
      setAuthChecked(true);
    } catch (error) {
      console.error('User auth check failed:', error);
      setIsLoadingAuth(false);
      setIsAuthenticated(false);
      setAuthChecked(true);
      
      // If user auth fails, it might be an expired token
      if (error.status === 401 || error.status === 403) {
        setAuthError({
          type: 'auth_required',
          message: 'Authentication required'
        });
      }
    }
  };

  // 세션 무효화·중복 로그인·재인증 만료를 사용 중에도 감지 (1분 주기 + 창 복귀 시 재확인)
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') checkUserAuth();
    }, 60 * 1000);
    const onFocus = () => checkUserAuth();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [user?.id]);

  const logout = (shouldRedirect = true) => {
    clearAuthCache();
    clearSessionId();
    setMfaVerified(false);
    setMfaEnabled(true);
    setPrivacyConsentValid(false);
    setEmailVerified(false);
    setIpAllowed(true);
    setUser(null);
    setIsAuthenticated(false);
    
    // 서버 측 세션 무효화(전체 기기·토큰 재사용 차단) 기록 후 플랫폼 로그아웃 진행
    secureLogout(shouldRedirect ? window.location.href : undefined);
  };

  const navigateToLogin = () => {
    // Use the SDK's redirectToLogin method
    base44.auth.redirectToLogin(window.location.href);
  };

  return (
    <AuthContext.Provider value={{ 
      user, 
      isAuthenticated, 
      isLoadingAuth,
      isLoadingPublicSettings,
      authError,
      appPublicSettings,
      authChecked,
      mfaVerified,
      mfaEnabled,
      privacyConsentValid,
      emailVerified,
      ipAllowed,
      sessionEndedReason,
      logout,
      navigateToLogin,
      checkUserAuth,
      checkAppState
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};