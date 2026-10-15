import React, { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LogIn, Mail, Lock, Loader2 } from "lucide-react";
import AuthLayout from "@/components/AuthLayout";
import GoogleIcon from "@/components/GoogleIcon";
import { supabase } from '@/lib/supabaseClient';
import { authRedirect } from '@/lib/authRedirect';
import EmailMfa from '@/components/auth/EmailMfa';


export default function Login() {
  const { login, authError, mfaChallenge } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const formRef = useRef(null);

  useEffect(() => {
    const clearInputs = () => {
      formRef.current?.reset();
      setEmail('');
      setPassword('');
    };
    clearInputs();
    const { data: { subscription } } = supabase.auth.onAuthStateChange(event => {
      if (event === 'SIGNED_OUT') clearInputs();
    });
    const onPageShow = event => { if (event.persisted) clearInputs(); };
    window.addEventListener('pageshow', onPageShow);
    return () => {
      subscription.unsubscribe();
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [mfaChallenge?.pending]);
  const resendConfirmation = async () => {
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError('이메일을 입력해 주세요.'); return; }
    setLoading(true); setNotice('');
    try {
      await supabase.auth.resend({type:'signup',email:email.trim(),options:{emailRedirectTo:authRedirect('/auth/confirm')}});
      setNotice('확인이 필요한 가입 계정이면 확인 메일이 발송됩니다.');
    } catch { setError('요청을 전송하지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
    finally {setLoading(false);}
  };

  const urlParams = new URLSearchParams(window.location.search);
  const sessionReason = urlParams.get('reason');
  const emailMfaTest = urlParams.get('mfa-test') === '1';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      // 이전 MFA·IP 세션 정리
      const result = await login(email, password, { emailMfa: emailMfaTest });
      if (!result?.mfaRequired) navigate("/", { replace: true });
    } catch (err) {
      setError({ message: err.message || "Invalid email or password", title: err.title });
    } finally {
      setPassword('');
      setLoading(false);
    }
  };

  const handleGoogle = () => {
    setError("Google 로그인은 아직 연결되지 않았습니다. 이메일과 비밀번호로 로그인해 주세요.");
  };

  if (mfaChallenge?.pending) return <AuthLayout icon={Lock} title="이메일 2차 인증" subtitle="인증을 완료하면 업무 세션이 발급됩니다.">
    <EmailMfa onComplete={() => navigate('/', { replace: true })} />
  </AuthLayout>;

  return (
    <AuthLayout
      icon={LogIn}
      title="Welcome back"
      subtitle="Log in to your account"
      footer={
        <>
          Don't have an account?{" "}
          <Link to="/register" className="text-primary font-medium hover:underline">
            Create one
          </Link>
        </>
      }
    >
      {emailMfaTest && <p role="status" className="mb-4 text-sm text-primary">관리자 이메일 2차 인증 테스트입니다. 비밀번호 확인 후 새 인증번호를 발송합니다.</p>}
      {sessionReason === 'reauth_required' && (
        <div className="mb-4 p-3 rounded-lg bg-primary/10 text-primary text-sm leading-relaxed">
          보안을 위해 주기적 재인증이 필요합니다. 다시 로그인해 주세요.
        </div>
      )}
      {sessionReason === 'session_revoked' && (
        <div className="mb-4 p-3 rounded-lg bg-primary/10 text-primary text-sm leading-relaxed">
          해당 계정의 세션이 로그아웃 처리되어 무효화되었습니다. 다시 로그인해 주세요.
        </div>
      )}
      {sessionReason === 'concurrent_login' && (
        <div className="mb-4 p-3 rounded-lg bg-primary/10 text-primary text-sm leading-relaxed">
          다른 기기에서 로그인하여 이 기기의 접속이 종료되었습니다. 다시 로그인해 주세요.
        </div>
      )}
      <Button
        variant="outline"
        className="w-full h-12 text-sm font-medium mb-6"
        onClick={handleGoogle}
      >
        <GoogleIcon className="w-5 h-5 mr-2" />
        Continue with Google
      </Button>

      <div className="relative mb-6">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-border" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-card px-3 text-muted-foreground">or</span>
        </div>
      </div>

      {(error || authError?.message) && (
        <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          {(error?.title || (!error && authError?.title)) && (
            <p className="font-semibold mb-1">{error?.title || authError?.title}</p>
          )}
          {error?.message || error || authError?.message}
        </div>
      )}

      <form ref={formRef} onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
            <Input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="pl-10 h-12"
              required
            />
          </div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link to="/forgot-password" className="text-xs text-primary hover:underline">
              Forgot password?
            </Link>
          </div>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="pl-10 h-12"
              required
            />
          </div>
        </div>
        <Button type="submit" className="w-full h-12 font-medium" disabled={loading}>
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Logging in...
            </>
          ) : (
            "Log in"
          )}
        </Button>
      </form>
      {notice && <p role="status" className="mt-4 text-sm">{notice}</p>}
      <button type="button" disabled={loading} onClick={resendConfirmation} className="mt-4 text-xs text-primary">이메일 확인 메일 다시 받기</button>
    </AuthLayout>
  );
}
