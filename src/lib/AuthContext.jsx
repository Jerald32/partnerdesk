import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { supabase } from './supabaseClient';
import { invokeAppAuth } from './appAuth';
import { clearAppSession, getAppSession, saveAppSession } from './appSession';
import { secureLogout } from './logout';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [privacyConsentValid, setPrivacyConsentValid] = useState(false);
  const [consentRequirements, setConsentRequirements] = useState([]);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [mfaChallenge, setMfaChallenge] = useState(null);
  const pendingMfa = useRef(null);
  const mfaBusy = useRef(false);
  const epoch = useRef(0);
  const signingIn = useRef(false);
  const signingOut = useRef(false);
  const checking = useRef(null);

  const loadProfile = useCallback(async (authUser, version) => {
    const { data: profile, error } = await supabase.from('profiles').select('*,organization:organizations!profiles_organization_id_fkey(id,name,type,is_active)')
      .eq('auth_user_id', authUser.id).maybeSingle();
    if (error) throw new Error('Profile 조회에 실패했습니다. 앱 세션과 DB 접근 권한을 확인해 주세요.');
    if (!profile || ['suspended', 'disabled'].includes(profile.account_status)) throw new Error('사용 가능한 Profile이 없습니다.');
    if (!profile.organization || (!profile.organization.is_active && profile.role !== 'guest')) throw new Error('소속 조직을 사용할 수 없습니다. 관리자에게 문의해 주세요.');
    const { data: consentStatus, error: consentError } = await supabase.rpc('get_my_consent_requirements');
    if (consentError || !Array.isArray(consentStatus?.requirements)) throw new Error('개인정보 동의 상태를 확인할 수 없습니다.');
    if (version !== epoch.current) return;
    setPrivacyConsentValid(consentStatus.valid === true);
    setConsentRequirements(consentStatus.requirements);
    setUser({ ...profile, organization_type: profile.organization.type, is_verified: Boolean(authUser.email_confirmed_at) });
    setAuthError(null);
  }, []);

  const checkUserAuth = useCallback(() => {
    if (signingIn.current || signingOut.current || pendingMfa.current) return Promise.resolve();
    if (checking.current) return checking.current;
    const version = epoch.current;
    checking.current = (async () => {
      try {
        const { data: { user: authUser }, error } = await supabase.auth.getUser();
        if (version !== epoch.current) return;
        if (error || !authUser) { clearAppSession(); if (version === epoch.current) setUser(null); return; }
        const appSession = getAppSession();
        if (!appSession || appSession.authUserId !== authUser.id) throw new Error('앱 세션이 없습니다. 다시 로그인해 주세요.');
        await invokeAppAuth('validate-session'); // No touch on polling or restore.
        await loadProfile(authUser, version);
      } catch (error) {
        if (version === epoch.current) {
          clearAppSession(); setUser(null); setAuthError({ message: error.message });
        }
      } finally {
        if (version === epoch.current) setIsLoadingAuth(false);
        checking.current = null;
      }
    })();
    return checking.current;
  }, [loadProfile]);

  const login = useCallback(async (email, password, { emailMfa = false } = {}) => {
    if (signingOut.current || signingIn.current) throw new Error('인증 처리 중입니다. 잠시 후 다시 시도해 주세요.');
    sessionStorage.removeItem('partnerdesk_recovery_user'); setRecoveryReady(false);
    signingIn.current = true;
    const version = ++epoch.current;
    pendingMfa.current = null; setMfaChallenge(null);
    setIsLoadingAuth(true); setUser(null); setAuthError(null); setPrivacyConsentValid(false); setConsentRequirements([]);
    try {
      // Revoke this tab's previous app session before replacing its Auth identity.
      if (getAppSession()) await secureLogout();
      clearAppSession();
      const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw new Error(error.code === 'email_not_confirmed' ? '이메일 확인이 필요합니다. 확인 메일을 열거나 아래에서 다시 요청해 주세요.' : '이메일 또는 비밀번호를 확인해 주세요.');
      // A primary Auth JWT grants no business access. Issue the second app
      // credential only after the server permits the disabled policy or MFA.
      let appSession;
      let needsMfa = emailMfa === true;
      if (!needsMfa) {
        try { appSession = await invokeAppAuth('activate-without-mfa'); }
        catch (failure) {
          if (failure.reason !== 'mfa_required') throw failure;
          needsMfa = true;
        }
      }
      if (needsMfa) {
        pendingMfa.current = { authUser: data.user, version };
        setMfaChallenge({ pending: true });
        try {
          const challenge = await invokeAppAuth('send-code');
          if (version === epoch.current) setMfaChallenge({ pending: true, ...challenge });
        } catch (sendFailure) { if (version === epoch.current) setAuthError({ message: sendFailure.message }); }
        return { mfaRequired: true };
      }
      if (version !== epoch.current) throw new Error('로그인이 취소되었습니다. 다시 시도해 주세요.');
      saveAppSession(data.user.id, appSession);
      await invokeAppAuth('validate-session');
      await loadProfile(data.user, version);
    } catch (error) {
      await secureLogout();
      setUser(null); setAuthError({ message: error.message }); throw error;
    } finally { signingIn.current = false; setIsLoadingAuth(false); }
  }, [loadProfile]);

  const resendMfa = useCallback(async () => {
    if (!pendingMfa.current || mfaBusy.current) throw new Error('이메일과 비밀번호로 다시 로그인해 주세요.');
    mfaBusy.current = true;
    const version = epoch.current;
    try {
      const challenge = await invokeAppAuth('send-code', { force: true });
      if (version !== epoch.current) throw new Error('인증이 취소되었습니다.');
      setMfaChallenge({ pending: true, ...challenge }); setAuthError(null);
      return challenge;
    } finally { mfaBusy.current = false; }
  }, []);

  const verifyMfa = useCallback(async code => {
    const pending = pendingMfa.current;
    if (!pending || !mfaChallenge?.challenge_id || mfaBusy.current) throw new Error('인증번호를 먼저 요청해 주세요.');
    mfaBusy.current = true;
    try {
      const appSession = await invokeAppAuth('verify-code', { code,
        challenge_id: mfaChallenge.challenge_id, nonce: mfaChallenge.nonce });
      if (pending.version !== epoch.current) throw new Error('인증이 취소되었습니다.');
      saveAppSession(pending.authUser.id, appSession);
      await invokeAppAuth('validate-session');
      await loadProfile(pending.authUser, pending.version);
      pendingMfa.current = null; setMfaChallenge(null);
    } catch (failure) {
      clearAppSession(); setUser(null); throw failure;
    } finally { mfaBusy.current = false; }
  }, [mfaChallenge, loadProfile]);

  const logout = useCallback(async (shouldRedirect = true) => {
    signingOut.current = true;
    pendingMfa.current = null; setMfaChallenge(null);
    ++epoch.current; setUser(null); setAuthError(null); setPrivacyConsentValid(false); setConsentRequirements([]); setRecoveryReady(false); setIsLoadingAuth(true);
    try { await secureLogout(shouldRedirect ? '/login' : undefined); }
    finally { signingOut.current = false; setIsLoadingAuth(false); }
  }, []);

  useEffect(() => {
    void checkUserAuth();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        pendingMfa.current = null; setMfaChallenge(null);
        sessionStorage.setItem('partnerdesk_recovery_user', session.user.id);
        ++epoch.current; clearAppSession(); setUser(null); setRecoveryReady(true); setIsLoadingAuth(false);
        if (window.location.pathname !== '/reset-password') window.location.replace('/reset-password' + window.location.hash);
        return;
      }
      if (event === 'INITIAL_SESSION' && window.location.pathname === '/reset-password'
        && session?.user.id === sessionStorage.getItem('partnerdesk_recovery_user')) {
        setRecoveryReady(true);
      }
      if (signingIn.current) return;
      if (event === 'SIGNED_OUT') { ++epoch.current; pendingMfa.current = null; setMfaChallenge(null); clearAppSession(); setUser(null); setRecoveryReady(false); setIsLoadingAuth(false); }
      // Defer SDK calls outside the auth callback.
      if (event === 'SIGNED_IN') setTimeout(() => { void checkUserAuth(); }, 0);
    });
    return () => subscription.unsubscribe();
  }, [checkUserAuth]);

  useEffect(() => {
    if (!user) return;
    const onFocus = () => { if (document.visibilityState === 'visible') void checkUserAuth(); };
    const timer = setInterval(onFocus, 60000);
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [user, checkUserAuth]);

  return <AuthContext.Provider value={{ user, isAuthenticated: !!user, isLoadingAuth, authError,
    privacyConsentValid, consentRequirements, mfaVerified: !!user, emailVerified: !!user?.is_verified,
    sessionEndedReason: null, recoveryReady, login, logout, checkUserAuth, mfaChallenge, verifyMfa, resendMfa }}>
    {children}
  </AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
