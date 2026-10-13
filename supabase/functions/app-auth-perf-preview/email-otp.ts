import { randomHex, sessionHash } from './crypto.ts';
import { HttpError, response } from './http.ts';
import type { Services } from './handler.ts';

// Supabase Auth owns PIN generation, hash storage and SMTP delivery. The Auth
// session returned by verifyOtp stays inside a fresh, non-persistent client.
export interface EmailOtpAdapter {
  ready: boolean;
  send(email: string): Promise<void>;
  verify(email: string, code: string): Promise<string | null>;
}

export async function emailOtpAction(services: Services, user: { id: string; email?: string; passwordSessionId?: string },
  body: Record<string, unknown>, origin?: string): Promise<Response> {
  const adapter = services.emailOtp!;
  if (!adapter.ready) throw new HttpError(503, 'email_otp_not_configured');
  if (!user.passwordSessionId || !user.email) throw new HttpError(403, 'password_login_required');
  const base = { p_auth_user_id: user.id, p_password_session_id: user.passwordSessionId };
  const action = body.action;
  if (action === 'send-code') {
    if (body.force !== undefined && typeof body.force !== 'boolean') throw new HttpError(400, 'invalid_force');
    const result = await services.rpc('backend_begin_email_mfa', base);
    if (result.ok !== true) throw new HttpError(result.reason === 'mfa_locked' ? 423 : 429,
      typeof result.reason === 'string' ? result.reason : 'mfa_rate_limited');
    if (typeof result.challenge_id !== 'string' || typeof result.nonce !== 'string' || typeof result.expires_at !== 'string') {
      throw new HttpError(503, 'backend_unavailable');
    }
    let delivered = false;
    try { await adapter.send(user.email); delivered = true; } catch { /* Never relay SMTP/Auth details. */ }
    const receipt = await services.rpc('backend_email_mfa_delivery', { ...base, p_challenge_id: result.challenge_id, p_delivered: delivered });
    if (receipt.ok !== true) throw new HttpError(503, 'backend_unavailable');
    if (!delivered) throw new HttpError(503, 'email_delivery_failed');
    return response(200, { success: true, challenge_id: result.challenge_id, nonce: result.nonce,
      expires_at: result.expires_at, skipped: false, delivery_status: 'accepted' }, origin);
  }
  if (typeof body.challenge_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.challenge_id) ||
    typeof body.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(body.nonce) ||
    typeof body.code !== 'string' || !/^[0-9]{6}$/.test(body.code)) throw new HttpError(400, 'invalid_verification_input');
  if (body.device_label !== undefined && (typeof body.device_label !== 'string' || body.device_label.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(body.device_label))) throw new HttpError(400, 'invalid_device_label');
  const context = { ...base, p_challenge_id: body.challenge_id, p_nonce: body.nonce };
  const attempt = await services.rpc('backend_reserve_email_mfa_attempt', context);
  if (attempt.ok !== true) {
    const reason = typeof attempt.reason === 'string' ? attempt.reason : 'challenge_invalid';
    throw new HttpError(reason === 'mfa_locked' ? 423 : reason === 'challenge_expired' ? 410 : 400, reason);
  }
  let verified = false;
  try { verified = await adapter.verify(user.email, body.code) === user.id; } catch { /* Count failure, including transport uncertainty. */ }
  const token = randomHex(32);
  const result = await services.rpc('backend_finish_email_mfa', { ...context, p_attempt_id: attempt.attempt_id,
    p_verified: verified, p_session_token_hash: verified ? await sessionHash(token) : null,
    p_device_label: body.device_label ?? null });
  if (result.ok !== true) {
    const reason = typeof result.reason === 'string' ? result.reason : 'code_invalid';
    throw new HttpError(reason === 'mfa_locked' ? 423 : 400, reason);
  }
  if (!verified || typeof result.session_id !== 'string' || typeof result.expires_at !== 'string' ||
    typeof result.last_activity_at !== 'string') throw new HttpError(503, 'backend_unavailable');
  return response(200, { success: true, app_session_token: token, session_id: result.session_id,
    expires_at: result.expires_at, last_activity_at: result.last_activity_at }, origin);
}
