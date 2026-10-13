import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { useRpcAction } from '@/hooks/useRpcAction';
import { supabase } from '@/lib/supabaseClient';

export default function ConsentManagement() {
  const { user, consentRequirements, checkUserAuth } = useAuth();
  const [selected, setSelected] = useState(null);
  const [history, setHistory] = useState([]), [historyError, setHistoryError] = useState('');
  const { run, busy, error, unknown } = useRpcAction(() => { setSelected(null); void checkUserAuth(); });
  useEffect(() => {
    const controller = new AbortController();
    void supabase.from('privacy_consents').select('id,consent_type,pledge_version,consent_date,valid_until,withdrawn_at,policy_text_hash,source')
      .eq('profile_id', user.id).order('consent_date', { ascending: false }).order('id', { ascending: false }).limit(50).abortSignal(controller.signal)
      .then(({ data, error }) => {
        if (controller.signal.aborted) return;
        if (error) setHistoryError('동의 이력을 조회하지 못했습니다.');
        else { setHistory(data || []); setHistoryError(''); }
      }).catch(() => { if (!controller.signal.aborted) setHistoryError('동의 이력을 조회하지 못했습니다.'); });
    return () => controller.abort();
  }, [user.id, consentRequirements]);
  return <section className="rounded-lg border border-border p-5 space-y-3"><h3 className="text-sm font-medium">동의 및 서약 관리</h3>
    <p className="text-xs text-muted-foreground">필수 동의를 철회하면 업무 데이터 접근이 제한됩니다. 계정 관리와 재동의는 계속 이용할 수 있습니다.</p>
    {consentRequirements.map(p => <div key={p.kind} className="text-xs space-y-2">
      <p>{p.title || p.kind} · {p.version} · {p.valid ? '유효' : '동의 필요'}</p>
    </div>)}
    {historyError && <p role="alert" className="text-xs text-destructive">{historyError}</p>}
    {history.length > 0 && <div className="space-y-2 text-xs"><p>최근 동의 이력 (최대 50건)</p>{history.map(receipt => <div key={receipt.id}>
      <p>{receipt.consent_type || '과거 동의'} · {receipt.pledge_version || '버전 미기록'} · {new Date(receipt.consent_date).toLocaleString('ko-KR')}
        {receipt.withdrawn_at && ' · 철회됨'}{!receipt.policy_text_hash && ' · 과거 문서 원문 증빙 없음'}</p>
      {!receipt.withdrawn_at && <button disabled={busy || unknown} className="text-destructive" onClick={() => setSelected({ receipt_id: receipt.id, title: receipt.consent_type || '과거 동의' })}>동의 철회</button>}
    </div>)}</div>}
    {selected && <div className="text-xs space-x-3"><span>{selected.title} 동의를 철회하시겠습니까?</span>
      <button disabled={busy || unknown} onClick={() => void run('withdraw_policy_consent', { p_consent_id: selected.receipt_id }, d => d?.id === selected.receipt_id && typeof d.withdrawn_at === 'string')}>철회 확인</button>
      <button disabled={busy || unknown} onClick={() => setSelected(null)}>취소</button></div>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {consentRequirements.some(p => !p.valid) && <Link to="/" className="block text-xs text-primary">동의 문서 확인 및 재동의</Link>}
  </section>;
}
