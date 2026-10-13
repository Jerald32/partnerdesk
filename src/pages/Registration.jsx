import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { UserPlus } from 'lucide-react';
import AuthLayout from '@/components/AuthLayout';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabaseClient';
import { secureLogout } from '@/lib/logout';
import { authRedirect } from '@/lib/authRedirect';
import { validatePassword, PASSWORD_RULE_TEXT } from '@/lib/password';
import { signupConsentEntries } from '@/lib/consent';

export default function Registration() {
  const [form, setForm] = useState({ email: '', name: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [done, setDone] = useState(false);
  const [policies, setPolicies] = useState(null), [acknowledgements, setAcknowledgements] = useState({});
  useEffect(() => {
    let active = true;
    void supabase.rpc('list_signup_consent_policies').then(({ data, error }) => {
      if (!active) return;
      if (error || !Array.isArray(data)) setError('가입 동의 문서를 확인하지 못했습니다. 새로고침해 주세요.');
      else setPolicies(data);
    }).catch(() => { if (active) setError('가입 동의 문서를 확인하지 못했습니다. 새로고침해 주세요.'); });
    return () => { active = false; };
  }, []);
  async function submit(event) {
    event.preventDefault(); setError('');
    if (!form.name.trim()) return setError('이름을 입력해 주세요.');
    if (!validatePassword(form.password).valid) return setError(PASSWORD_RULE_TEXT);
    if (form.password !== form.confirm) return setError('비밀번호 확인이 일치하지 않습니다.');
    const entries = signupConsentEntries(policies, acknowledgements);
    if (!entries) return setError('필수 동의 내용을 확인해 주세요.');
    setBusy(true);
    try {
      await secureLogout();
      const { error } = await supabase.auth.signUp({ email: form.email.trim(), password: form.password,
        options: { data: { full_name: form.name.trim(), signup_consents: entries }, emailRedirectTo: authRedirect('/auth/confirm') } });
      if (error) throw error;
      await secureLogout(); setDone(true);
    } catch { setError('가입을 완료하지 못했습니다. 입력 내용과 잠시 후 재시도를 확인해 주세요. 이미 가입했다면 로그인 또는 비밀번호 찾기를 이용해 주세요.'); }
    finally { setBusy(false); }
  }
  return <AuthLayout icon={UserPlus} title="회원가입" subtitle="관리자 승인 후 업무를 이용할 수 있습니다." footer={<Link to="/login">로그인으로 돌아가기</Link>}>
    {done ? <p role="status">가입 가능한 이메일이면 확인 메일이 발송됩니다. 이메일 확인 후 로그인하여 관리자 승인을 기다려 주세요.</p> : <form onSubmit={submit} className="space-y-4">
      <fieldset disabled={busy} className="space-y-4">
        { [['email','이메일','email','email'],['name','이름','text','name'],['password','비밀번호','password','new-password'],['confirm','비밀번호 확인','password','new-password']].map(([key,label,type,complete]) => <label key={key} className="block text-sm">{label}<Input required type={type} autoComplete={complete} maxLength={key === 'name' ? 200 : undefined} value={form[key]} onChange={e=>setForm({...form,[key]:e.target.value})} /></label>) }
        <p className="text-xs text-muted-foreground">{PASSWORD_RULE_TEXT}</p>
        {policies?.map(p => <label key={`${p.kind}:${p.version}`} className="block space-y-1 text-xs">
          <span className="block">{p.title} ({p.required ? '필수' : '선택'}) · {p.version}</span>
          <span className="block whitespace-pre-wrap text-muted-foreground">{p.document_text}</span>
          <input type="checkbox" checked={acknowledgements[p.kind] === true} onChange={e => setAcknowledgements(a => ({ ...a, [p.kind]: e.target.checked }))} /> 동의합니다.
        </label>)}
        {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
        <Button type="submit" disabled={!policies || !signupConsentEntries(policies, acknowledgements)} className="w-full">{busy ? '처리 중…' : '가입하기'}</Button>
      </fieldset>
    </form>}
  </AuthLayout>;
}
