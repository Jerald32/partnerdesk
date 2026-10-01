// 다운로드(내보내기) 파일에 적용하는 개인정보 마스킹 공통 모듈
// 원칙: 저장된 원본은 그대로 보관하고, 사용자가 내려받는 파일에만 마스킹된 값을 넣는다.
//       티켓 내보내기와 접속기록 백업이 동일한 규칙을 쓰도록 이 모듈에서만 정의한다.

// 고객명·사용자명: 첫/끝 글자 제외 → '*' (예: 홍길동 → 홍*동)
export function maskName(name?: string): string {
  if (!name) return '–';
  const value = String(name);
  if (value.length <= 2) return value;
  return value[0] + '*'.repeat(value.length - 2) + value[value.length - 1];
}

// 연락처: 가운데 자리 → '*' (예: 010-1234-5678 → 010-****-5678)
export function maskPhone(phone?: string): string {
  if (!phone) return '–';
  const match = String(phone).match(/^(\d{2,3})-?(\d{3,4})-?(\d{4})$/);
  if (match) return `${match[1]}-${'*'.repeat(match[2].length)}-${match[3]}`;
  return maskText(String(phone));
}

// 이메일: 아이디 앞 3자만 남기고 '*' (예: jeukjung20@gmail.com → jeu*******@gmail.com)
export function maskEmail(email?: string): string {
  if (!email) return '–';
  const value = String(email);
  const at = value.indexOf('@');
  if (at < 1) return maskText(value);
  const id = value.slice(0, at);
  const domain = value.slice(at);
  const visible = id.slice(0, Math.min(3, id.length));
  return `${visible}${'*'.repeat(Math.max(id.length - visible.length, 3))}${domain}`;
}

// 접속지 정보(IP): 마지막 자리 → '*' (예: 218.238.50.65 → 218.238.50.***)
export function maskIp(ip?: string): string {
  if (!ip) return '–';
  const parts = String(ip).split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.***`;
  return '***';
}

// 자유 입력 텍스트 안에 섞인 개인정보 패턴 마스킹 (주민등록번호·카드번호·이메일·연락처)
export function maskText(text?: string): string {
  if (!text) return '';
  let out = String(text);
  out = out.replace(/\d{6}-?\d{7}/g, (m) => `${m.slice(0, 6)}-*******`);
  out = out.replace(/\d{4}-\d{4}-\d{4}-\d{4}/g, '****-****-****-****');
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => maskEmail(m));
  out = out.replace(/\b\d{2,3}-?\d{3,4}-?\d{4}\b/g, (m) =>
    m.replace(/^(\d{2,3})-?(\d{3,4})-?(\d{4})$/, (_x, a, b, c) => `${a}-${'*'.repeat(b.length)}-${c}`)
  );
  return out;
}