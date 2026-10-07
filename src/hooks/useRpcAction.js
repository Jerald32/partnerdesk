import { useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { isUuid } from '@/lib/supabaseData';

export function useRpcAction(onSuccess, formatError) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unknown, setUnknown] = useState(false);
  async function run(name, args, validate = data => isUuid(data?.id)) {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setError('');
    let result;
    let release = true;
    try {
      const { data, error } = await supabase.rpc(name, args);
      if (error) throw error;
      if (!validate(data)) throw new Error('invalid_rpc_response');
      result = data;
    } catch (failure) {
      if (!failure.code) {
        release = false; setUnknown(true);
        setError('처리 결과를 확인할 수 없습니다. 다시 제출하지 말고 목록을 새로고침해 확인해 주세요.');
      } else {
        setError(formatError?.(failure) || (failure.code === '40001' ? '다른 변경이 저장되었습니다. 창을 닫고 최신 정보를 새로고침해 주세요.'
          : failure.code === '23505' ? '이미 등록되었거나 처리 중인 요청이 있습니다. 목록을 확인해 주세요.'
          : failure.code === '28000' ? '세션이 만료되었습니다. 다시 로그인해 주세요.'
          : '저장하지 못했습니다. 입력값과 권한을 확인해 주세요.'));
      }
      return false;
    } finally { if (release) pending.current = false; setBusy(false); }
    // Refresh errors are separate from mutation results; never retry automatically.
    onSuccess?.(result);
    return true;
  }
  return { run, busy, error, unknown };
}
