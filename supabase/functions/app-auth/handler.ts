import { codeHash, importHmacKey, randomHex, sessionHash, verificationCode } from "./crypto.ts";
import type { EmailAdapter } from "./email.ts";
import { HttpError, requestBody, response } from "./http.ts";

export type RpcName = "backend_create_mfa_challenge" | "backend_verify_mfa_and_create_app_session" |
  "backend_activate_app_session_without_mfa" | "backend_validate_and_touch_app_session" | "backend_revoke_app_session";

export interface Services {
  origins: Set<string>;
  authenticate(jwt: string): Promise<{ id: string; email?: string; emailConfirmed: boolean }>;
  // Only fixed server queries and fixed RPCs; no request-supplied table/filter/RPC.
  profile(userId: string): Promise<{ email: string; account_status: string } | null>;
  ipPolicy(): Promise<{ enabled: boolean; hasActiveEntries: boolean }>;
  rpc(name: RpcName, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  hmacSecret?: string;
  email: EmailAdapter;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;
const fields: Record<string, string[]> = {
  "send-code": ["action", "force"],
  "verify-code": ["action", "challenge_id", "nonce", "code", "device_label"],
  "activate-without-mfa": ["action", "device_label"],
  "validate-session": ["action"],
  "logout": ["action"],
};

function deviceLabel(body: Record<string, unknown>): string | null {
  if (body.device_label === undefined) return null;
  if (typeof body.device_label !== "string" || body.device_label.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(body.device_label)) throw new HttpError(400, "invalid_device_label");
  return body.device_label;
}

function dbFailure(result: Record<string, unknown>): never {
  const reason = typeof result.reason === "string" ? result.reason : "";
  const statuses: Record<string, number> = {
    profile_not_found: 403, account_unavailable: 403, mfa_locked: 423,
    challenge_not_found: 400, challenge_consumed: 409, challenge_expired: 410,
    challenge_invalid: 400, code_invalid: 400, mfa_required: 409,
    session_not_found: 401, session_revoked: 401, absolute_expired: 401, idle_expired: 401,
    invalid_session_input: 400,
  };
  const known = Object.hasOwn(statuses, reason);
  throw new HttpError(known ? statuses[reason] : 503, known ? reason : "backend_unavailable");
}

function sessionMetadata(result: Record<string, unknown>): Record<string, unknown> {
  if (typeof result.session_id !== "string" || !UUID.test(result.session_id) ||
      typeof result.expires_at !== "string" || typeof result.last_activity_at !== "string") {
    throw new HttpError(503, "backend_unavailable");
  }
  return { session_id: result.session_id, expires_at: result.expires_at,
    last_activity_at: result.last_activity_at };
}

export function createHandler(getServices: () => Services): (req: Request) => Promise<Response> {
  return async (req) => {
    let origin: string | undefined;
    try {
      const services = getServices();
      const requestOrigin = req.headers.get("origin");
      if (requestOrigin !== null) {
        if (!services.origins.has(requestOrigin)) throw new HttpError(403, "origin_not_allowed");
        origin = requestOrigin;
      }
      if (req.method === "OPTIONS") {
        if (!origin || req.headers.get("access-control-request-method") !== "POST") {
          throw new HttpError(400, "invalid_preflight");
        }
        return response(204, {}, origin);
      }
      if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
      const authorization = req.headers.get("authorization");
      const jwt = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
      if (!jwt) throw new HttpError(401, "authentication_required");
      const user = await services.authenticate(jwt);
      if (!UUID.test(user.id)) throw new HttpError(401, "invalid_jwt");
      const body = await requestBody(req);
      const action = typeof body.action === "string" ? body.action : "";
      if (!Object.hasOwn(fields, action)) throw new HttpError(400, "invalid_action");
      if (Object.keys(body).some((key) => !fields[action].includes(key))) {
        throw new HttpError(400, "unexpected_field");
      }

      // Logout must remain usable even if the account, email or IP policy changes.
      if (action !== "logout") {
        if (!user.emailConfirmed || !user.email) throw new HttpError(403, "email_not_verified");
        const profile = await services.profile(user.id);
        if (!profile) throw new HttpError(403, "profile_not_found");
        if (["suspended", "disabled"].includes(profile.account_status)) throw new HttpError(403, "account_" + profile.account_status);
        if (profile.email.trim().toLowerCase() !== user.email.trim().toLowerCase()) {
          throw new HttpError(403, "email_identity_mismatch");
        }
        const policy = await services.ipPolicy();
        if (policy.enabled && policy.hasActiveEntries) {
          // No trustworthy, spoof-resistant source has been established for this
          // deployment. This is an unavailable capability, NOT an IP deny verdict.
          // Never inspect client-controlled X-Forwarded-For / X-Real-IP here.
          throw new HttpError(503, "ip_enforcement_not_configured");
        }
      }

      if (action === "send-code") {
        if (body.force !== undefined && typeof body.force !== "boolean") throw new HttpError(400, "invalid_force");
        // Preflight provider configuration BEFORE creating/throttling a challenge.
        try { services.email.assertConfigured(); } catch { throw new HttpError(503, "email_not_configured"); }
        let key: CryptoKey;
        try { key = await importHmacKey(services.hmacSecret); } catch { throw new HttpError(503, "mfa_configuration_error"); }
        const code = verificationCode();
        const nonce = randomHex();
        const result = await services.rpc("backend_create_mfa_challenge", {
          p_auth_user_id: user.id, p_code_hash: await codeHash(key, user.id, nonce, code),
          p_force: body.force === true,
        });
        if (result.ok !== true) dbFailure(result);
        if (typeof result.challenge_id !== "string" || !UUID.test(result.challenge_id) ||
            typeof result.nonce !== "string" || !HEX64.test(result.nonce) ||
            typeof result.expires_at !== "string" || typeof result.skipped !== "boolean") {
          throw new HttpError(503, "backend_unavailable");
        }
        if (!result.skipped) {
          // Bind the actual recipient and returned nonce to the values just used.
          if (result.nonce !== nonce || typeof result.email !== "string" ||
              result.email.trim().toLowerCase() !== user.email!.trim().toLowerCase()) {
            throw new HttpError(503, "backend_unavailable");
          }
          try {
            await services.email.sendVerificationEmail({ to: result.email, code, expiresInMinutes: 5 });
          } catch {
            // DB has committed. Do not fake success, delete rows, or retry with
            // a different code under the same challenge. force creates a new code.
            return response(503, { success: false, reason: "email_delivery_failed",
              retry_with_force: true }, origin);
          }
        }
        return response(200, { success: true, skipped: result.skipped,
          challenge_id: result.challenge_id, nonce: result.nonce,
          expires_at: result.expires_at,
          delivery_status: result.skipped ? "unknown" : "accepted" }, origin);
      }

      if (action === "verify-code" || action === "activate-without-mfa") {
        const label = deviceLabel(body);
        let candidate: string | undefined;
        if (action === "verify-code") {
          if (typeof body.challenge_id !== "string" || !UUID.test(body.challenge_id) ||
              typeof body.nonce !== "string" || !HEX64.test(body.nonce) ||
              typeof body.code !== "string" || !/^[0-9]{6}$/.test(body.code)) {
            throw new HttpError(400, "invalid_verification_input");
          }
          let key: CryptoKey;
          try { key = await importHmacKey(services.hmacSecret); } catch { throw new HttpError(503, "mfa_configuration_error"); }
          candidate = await codeHash(key, user.id, body.nonce, body.code);
        }
        const rawToken = randomHex(32);
        const hash = await sessionHash(rawToken);
        const result = action === "verify-code"
          ? await services.rpc("backend_verify_mfa_and_create_app_session", {
            p_auth_user_id: user.id, p_challenge_id: (body.challenge_id as string).toLowerCase(),
            p_candidate_code_hash: candidate, p_session_token_hash: hash, p_device_label: label,
          })
          : await services.rpc("backend_activate_app_session_without_mfa", {
            p_auth_user_id: user.id, p_session_token_hash: hash, p_device_label: label,
          });
        if (result.ok !== true) dbFailure(result);
        return response(200, { success: true, ...sessionMetadata(result), app_session_token: rawToken }, origin);
      }

      const rawToken = req.headers.get("x-partnerdesk-session");
      if (!rawToken || !HEX64.test(rawToken)) throw new HttpError(400, "invalid_session_token");
      const hash = await sessionHash(rawToken);
      if (action === "validate-session") {
        const result = await services.rpc("backend_validate_and_touch_app_session", {
          p_auth_user_id: user.id, p_session_token_hash: hash, p_touch: false,
        });
        if (result.valid !== true) dbFailure(result);
        return response(200, { success: true, valid: true, ...sessionMetadata(result) }, origin);
      }
      const result = await services.rpc("backend_revoke_app_session", {
        p_auth_user_id: user.id, p_session_token_hash: hash,
      });
      if (result.ok !== true) dbFailure(result);
      return response(200, { success: true }, origin);
    } catch (error) {
      if (error instanceof HttpError) return response(error.status, { success: false, reason: error.reason }, origin);
      // Never relay SQL/provider exceptions, credentials, tokens or stack traces.
      return response(503, { success: false, reason: "backend_unavailable" }, origin);
    }
  };
}
