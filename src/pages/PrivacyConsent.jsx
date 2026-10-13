import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useRpcAction } from '@/hooks/useRpcAction';
import { useAuth } from '@/lib/AuthContext';
import { Button } from '@/components/ui/button';
import { FileText } from 'lucide-react';
import { consentSubmission } from '@/lib/consent';
import AuthLayout from '@/components/AuthLayout';

function ConsentDocument({ policy, onSaved }) {
  const [agreed, setAgreed] = useState(false);
  const { run, busy, error, unknown } = useRpcAction(onSaved, failure =>
    failure.code === '40001' ? '동의 문서가 변경되었습니다. 새로고침 후 다시 확인해 주세요.' : '동의를 저장하지 못했습니다. 세션과 문서를 확인해 주세요.');
  const submission = consentSubmission(policy, agreed);
  return <form className="space-y-3 rounded-lg border border-border p-4" onSubmit={e => {
    e.preventDefault();
    if (submission) void run('record_policy_consent', submission, data =>
      typeof data?.id === 'string' && data.consent_type === policy.kind && data.pledge_version === policy.version && data.text_hash === policy.text_hash);
  }}>
    <h3 className="font-medium">{policy.title || '동의 문서를 확인할 수 없습니다'}</h3>
    <p className="text-xs text-muted-foreground">버전 {policy.version || '미확인'}{policy.kind === 'privacy_pledge' && ' · 서약 유효기간 1년'}</p>
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs font-sans">{policy.document_text || '문서가 준비되지 않았습니다. 관리자에게 문의해 주세요.'}</pre>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={agreed} disabled={busy || unknown || !policy.text_hash}
      onChange={e => setAgreed(e.target.checked)} />위 내용을 확인하고 동의합니다.</label>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button disabled={!submission || busy || unknown} type="submit">{busy ? '저장 중...' : '동의 제출'}</Button>
  </form>;
}

export default function PrivacyConsent() {
  const { checkUserAuth, logout, consentRequirements } = useAuth();

  return (
    <AuthLayout
      icon={FileText}
      title="동의 및 개인정보보호 서약"
      subtitle="업무 이용에 필요한 동의 내용을 확인해 주세요"
    >
      <div className="space-y-4">{consentRequirements.filter(p => !p.valid).map(p =>
        <ConsentDocument key={`${p.kind}:${p.version}:${p.text_hash}`} policy={p} onSaved={() => { void checkUserAuth(); }} />)}</div>
      <div className="mt-4 flex gap-4 text-xs"><Link to="/my" className="text-primary">내 계정 및 동의 관리</Link>
        <button onClick={() => logout(true)}>로그아웃</button></div>
    </AuthLayout>
  );
}
