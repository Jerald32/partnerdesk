import { useState, useEffect } from 'react';
import { Search, MapPin } from 'lucide-react';

const POSTCODE_SRC = '//t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js';

function loadPostcodeScript() {
  if (window.daum?.Postcode) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${POSTCODE_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('postcode-load-failed')));
      return;
    }
    const script = document.createElement('script');
    script.src = POSTCODE_SRC;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('postcode-load-failed'));
    document.head.appendChild(script);
  });
}

// 3단 주소 입력 블록: 1 주소 검색 → 2 도로명 주소(읽기전용) → 3 상세주소
export default function AddressField({ value, onChange }) {
  const { address = '', address_detail = '' } = value || {};
  const [zonecode, setZonecode] = useState('');
  const [ready, setReady] = useState(!!window.daum?.Postcode);
  const [error, setError] = useState('');

  useEffect(() => {
    if (ready) return;
    loadPostcodeScript().then(() => setReady(true)).catch(() => setError('주소 검색 서비스를 불러올 수 없습니다.'));
  }, [ready]);

  const openSearch = () => {
    setError('');
    new window.daum.Postcode({
      oncomplete: (data) => {
        setZonecode(data.zonecode || '');
        onChange({ address: data.roadAddress || data.address || '', address_detail });
      },
    }).open();
  };

  const stepNum = 'flex items-center justify-center w-4 h-4 rounded-full bg-[#2A364F] text-[10px] font-semibold text-muted-foreground shrink-0';

  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-muted-foreground">현장 지원 출동 주소 <span className="text-muted-foreground/60">(선택)</span></label>

      {/* Step 1 — 주소 검색 */}
      <div className="flex items-center gap-2">
        <span className={stepNum}>1</span>
        <button
          type="button"
          onClick={openSearch}
          disabled={!ready}
          className="flex items-center gap-1.5 h-8 px-3.5 text-xs font-medium border border-primary text-primary rounded-md hover:bg-primary/10 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors disabled:opacity-50"
        >
          <Search className="w-3.5 h-3.5" />
          {address ? '주소 다시 검색' : '주소 검색'}
        </button>
        {error && <span className="text-[11px] text-destructive">{error}</span>}
      </div>

      {/* Step 2 — 도로명 주소 (읽기전용) */}
      <div className="flex items-center gap-2">
        <span className={stepNum}>2</span>
        <div className="flex-1 flex items-center gap-2 h-8 px-3 rounded-md border border-[#2A364F] bg-[#0F172A]">
          {zonecode && <span className="font-mono text-xs text-muted-foreground shrink-0">({zonecode})</span>}
          <span className="text-xs text-foreground truncate">
            {address || <span className="text-[#64748B]">주소 검색을 통해 자동 입력됩니다</span>}
          </span>
          {!address && <MapPin className="w-3.5 h-3.5 text-[#64748B] ml-auto shrink-0" />}
        </div>
      </div>

      {/* Step 3 — 상세주소 */}
      <div className="flex items-center gap-2">
        <span className={stepNum}>3</span>
        <input
          value={address_detail}
          onChange={e => onChange({ address, address_detail: e.target.value })}
          placeholder="상세주소 (건물·층·호수 등)"
          maxLength={100}
          className="flex-1 h-8 px-3 text-xs bg-[#0F172A] border border-[#2A364F] rounded-md text-foreground placeholder-[#64748B] focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </div>
    </div>
  );
}