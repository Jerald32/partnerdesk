import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Lock } from 'lucide-react';
import AuthLayout from '@/components/AuthLayout';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabaseClient';
import { authRedirect } from '@/lib/authRedirect';
import { validatePassword, PASSWORD_RULE_TEXT } from '@/lib/password';
import { useAuth } from '@/lib/AuthContext';

export default function PasswordRecovery({ reset = false }) {
  const { logout, recoveryReady } = useAuth();
  const [email,setEmail] = useState(''), [password,setPassword] = useState(''), [confirm,setConfirm] = useState('');
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [done,setDone] = useState(false);
  async function submit(event) {
    event.preventDefault(); setError('');
    if (reset && (!validatePassword(password).valid || password !== confirm)) return setError(password !== confirm ? '비밀번호 확인이 일치하지 않습니다.' : PASSWORD_RULE_TEXT);
    setBusy(true);
    try {
      if (reset) {
        if (!recoveryReady) throw new Error('복구 링크를 다시 요청해 주세요.');
        const {error} = await supabase.auth.updateUser({password});
        if (error) throw new Error('비밀번호를 변경하지 못했습니다. 복구 링크와 비밀번호 규칙을 확인해 주세요.');
        await logout(false);
      } else {
        // Keep both response paths identical to avoid account enumeration.
        await supabase.auth.resetPasswordForEmail(email.trim(), {redirectTo:authRedirect('/reset-password')});
      }
      setDone(true); setPassword(''); setConfirm('');
    } catch (err) { setError(reset ? err.message : '요청을 전송하지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
    finally {setBusy(false);}
  }
  return <AuthLayout icon={Lock} title={reset ? '비밀번호 재설정' : '비밀번호 찾기'} subtitle="PartnerDesk 계정" footer={<Link to="/login">로그인으로 돌아가기</Link>}>
    {done ? <p role="status">{reset ? '비밀번호가 변경되었습니다. 새 비밀번호로 다시 로그인해 주세요.' : '가입된 이메일이면 복구 메일이 발송됩니다. 받은 편지함과 스팸함을 확인해 주세요.'}</p> : <form onSubmit={submit} className="space-y-4">
      {reset && !recoveryReady && <p role="alert">유효한 복구 링크를 확인하고 있습니다. 링크가 만료되었다면 <Link to="/forgot-password" className="text-primary">다시 요청</Link>해 주세요.</p>}
      <fieldset disabled={busy || (reset && !recoveryReady)} className="space-y-4">
        {reset ? <><label className="block text-sm">새 비밀번호<Input required type="password" autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} /></label><label className="block text-sm">비밀번호 확인<Input required type="password" autoComplete="new-password" value={confirm} onChange={e=>setConfirm(e.target.value)} /></label><p className="text-xs">{PASSWORD_RULE_TEXT}</p></> : <label className="block text-sm">이메일<Input required type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} /></label>}
        <Button type="submit" className="w-full">{busy ? '처리 중…' : reset ? '비밀번호 변경' : '복구 메일 요청'}</Button>
      </fieldset>{error && <p role="alert" className="text-destructive">{error}</p>}
    </form>}
  </AuthLayout>;
}

export function EmailConfirmation() {
  const [message,setMessage] = useState('이메일 확인 결과를 확인하고 있습니다…');
  useEffect(()=>{let active=true;
    const linkError = new URLSearchParams(window.location.hash.slice(1)).has('error') || new URLSearchParams(window.location.search).has('error');
    void supabase.auth.getUser().then(({data,error})=>{
    if(active) {
      setMessage(!linkError && !error && data.user?.email_confirmed_at ? '이메일 확인이 완료되었습니다. 로그인 후 관리자 승인을 기다려 주세요.' : '확인 링크가 만료되었거나 유효하지 않습니다. 로그인 화면에서 확인 메일을 다시 요청해 주세요.');
      window.history.replaceState(null,'','/auth/confirm');
    }
  }).catch(()=>{if(active) setMessage('확인 결과를 조회하지 못했습니다. 잠시 후 다시 시도해 주세요.');});
    return()=>{active=false;};},[]);
  return <AuthLayout icon={Lock} title="이메일 확인" subtitle="PartnerDesk 계정" footer={<Link to="/login">로그인</Link>}><p role="status">{message}</p></AuthLayout>;
}
