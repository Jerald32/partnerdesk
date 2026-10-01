// 클라이언트 IP 추출 유틸 (공통 모듈)
export function getClientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  return '';
}

// IP 접근 제한 판정 (공통 모듈) — 관리자 포함 모든 사용자에게 동일 적용
// - 관리자가 제한을 중단한 경우(ip_restriction_enabled=false): 모든 IP 허용
// - 등록된 IP가 없는 경우: 모든 IP 허용
// - 그 외: 화이트리스트에 등록된 IP만 허용
export async function evaluateIpAccess(base44: any, req: Request) {
  const clientIp = getClientIp(req);

  const settings = await base44.asServiceRole.entities.SystemSetting.filter({ key: 'ip_restriction_enabled' });
  const restrictionDisabled = settings.length > 0 && settings[0].value === 'false';
  if (restrictionDisabled) {
    return { allowed: true, ip: clientIp, restriction_disabled: true };
  }

  const whitelist = await base44.asServiceRole.entities.IpWhitelist.filter({ is_active: true });
  const allowedIps = whitelist.map((w: any) => w.ip_address);
  if (allowedIps.length === 0) {
    return { allowed: true, ip: clientIp, whitelist_active: false };
  }

  return { allowed: allowedIps.includes(clientIp), ip: clientIp, whitelist_active: true };
}

// 미등록 IP 차단 응답 (인증 단계 공통)
export function ipDeniedResponse(ipAccess: { ip: string }) {
  return Response.json(
    {
      error: `등록된 IP에서만 접속할 수 있습니다. 관리자에게 IP 등록을 요청해 주세요. (현재 IP: ${ipAccess.ip || '확인 불가'})`,
      reason: 'ip_denied',
      ip: ipAccess.ip,
    },
    { status: 403 }
  );
}