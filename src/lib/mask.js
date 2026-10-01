// 고객명 마스킹: 첫/끝 글자 제외 → '*' (예: 홍길동 → 홍*동, 김철수 → 김*수, 이씨 → 이씨)
export const maskName = (name) => {
  if (!name) return '–';
  if (name.length <= 2) return name;
  return name[0] + '*'.repeat(name.length - 2) + name[name.length - 1];
};

// 전화번호 마스킹: 가운데 자리 → '*' (예: 010-1234-5678 → 010-****-5678)
export const maskPhone = (phone) => {
  if (!phone) return '–';
  const match = phone.match(/^(\d{2,3})-?(\d{3,4})-?(\d{4})$/);
  if (match) return `${match[1]}-${'*'.repeat(match[2].length)}-${match[3]}`;
  return phone;
};

// 지역 요약: 주소에서 시/도 + 시/군/구까지만 추출 (예: "서울특별시 강남구 테헤란로 123" → "서울특별시 강남구")
// 세종특별자치시처럼 시 자체가 최하위 단위인 경우는 시까지만. 파싱 실패/주소 없음 → '–' (전체 주소는 상세 화면에서만 노출)
export const regionSummary = (address) => {
  if (!address) return '–';
  const tokens = String(address).trim().split(/\s+/);
  const first = tokens[0] || '';
  const fullSido = /(특별시|광역시|특별자치시|도)$/.test(first);
  const isMetroShort = ['서울', '부산', '대구', '인천', '광주', '대전', '울산'].includes(first);
  const isSidoShort = ['경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주', '세종'].includes(first);
  if (!fullSido && !isMetroShort && !isSidoShort) return '–'; // 파싱 실패 — 전체 주소 노출 안 함
  if (/특별자치시$/.test(first) || first === '세종') return first; // 세종특별자치시: 시 자체가 최하위 단위
  if (/(특별시|광역시)$/.test(first) || isMetroShort) {
    return tokens[1] ? `${first} ${tokens[1]}` : first;
  }
  // 도: 시/군 + 그 아래 구 (예: 성남시 분당구)
  let result = first;
  if (tokens[1]) result += ` ${tokens[1]}`;
  if (tokens[2] && /구$/.test(tokens[2])) result += ` ${tokens[2]}`;
  return result;
};