import React, { useState } from "react";
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


export default function Login() {
  const { login, authError } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
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

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      // 이전 MFA·IP 세션 정리
      await login(email, password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err.message || "Invalid email or password");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = () => {
    setError("Google 로그인은 아직 연결되지 않았습니다. 이메일과 비밀번호로 로그인해 주세요.");
  };

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
          {error || authError?.message}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
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
