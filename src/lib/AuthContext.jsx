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
  const epoch = useRef(0);
  const signingIn = useRef(false);
  const checking = useRef(null);

  const loadProfile = useCallback(async (authUser, version) => {
    const { data: profile, error } = await supabase.from('profiles').select('*')
      .eq('auth_user_id', authUser.id).maybeSingle();
    if (error) throw new Error('Profile 조회에 실패했습니다. 앱 세션과 DB 접근 권한을 확인해 주세요.');
    if (!profile || ['suspended', 'disabled'].includes(profile.account_status)) throw new Error('사용 가능한 Profile이 없습니다.');
    let consentValid = true;
    if (profile.role === 'partner_admin') {
      const { data, error: consentError } = await supabase.rpc('get_privacy_consent_status');
      if (consentError) throw new Error('개인정보 동의 상태를 확인할 수 없습니다.');
      consentValid = data?.valid === true;
    }
    if (version !== epoch.current) return;
    setPrivacyConsentValid(consentValid);
    setUser({ ...profile, is_verified: Boolean(authUser.email_confirmed_at) });
    setAuthError(null);
  }, []);

  const checkUserAuth = useCallback(() => {
    if (signingIn.current) return Promise.resolve();
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

  const login = useCallback(async (email, password) => {
    signingIn.current = true;
    const version = ++epoch.current;
    setIsLoadingAuth(true); setUser(null); setAuthError(null);
    try {
      // Revoke this tab's previous app session before replacing its Auth identity.
      if (getAppSession()) await secureLogout();
      clearAppSession();
      const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw new Error('이메일 또는 비밀번호를 확인해 주세요.');
      // Server checks mfa_enabled=false; mfa_required is never treated as success.
      const appSession = await invokeAppAuth('activate-without-mfa');
      if (version !== epoch.current) throw new Error('로그인이 취소되었습니다. 다시 시도해 주세요.');
      saveAppSession(data.user.id, appSession);
      await invokeAppAuth('validate-session');
      await loadProfile(data.user, version);
    } catch (error) {
      await secureLogout();
      setUser(null); setAuthError({ message: error.message }); throw error;
    } finally { signingIn.current = false; setIsLoadingAuth(false); }
  }, [loadProfile]);

  const logout = useCallback(async (shouldRedirect = true) => {
    ++epoch.current; setUser(null); setAuthError(null); setPrivacyConsentValid(false);
    await secureLogout(shouldRedirect ? '/login' : undefined);
  }, []);

  useEffect(() => {
    void checkUserAuth();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (signingIn.current) return;
      if (event === 'SIGNED_OUT') { ++epoch.current; clearAppSession(); setUser(null); setIsLoadingAuth(false); }
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
    privacyConsentValid, mfaVerified: !!user, emailVerified: !!user?.is_verified,
    sessionEndedReason: null, login, logout, checkUserAuth }}>
    {children}
  </AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
