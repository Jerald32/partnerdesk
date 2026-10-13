import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import { createHandler, type Services } from "./handler.ts";
import { allowedOrigins, HttpError } from "./http.ts";
import { unconfiguredEmail } from "./email.ts";
import { consumeGateway } from './gateway.ts';
import { response } from './http.ts';
import {timedServices} from './timing.ts';

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new HttpError(503, "backend_configuration_error");
  return value;
}

function userApiKey(): string {
  const legacy = Deno.env.get("SUPABASE_ANON_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
    if (typeof keys.default === "string" && keys.default) return keys.default;
  } catch { /* Return a stable configuration error, never the environment value. */ }
  throw new HttpError(503, "backend_configuration_error");
}

function services(): Services {
  const origins = allowedOrigins(Deno.env.get("PARTNERDESK_ALLOWED_ORIGINS"),
    Boolean(Deno.env.get("DENO_DEPLOYMENT_ID")));
  const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  // Lazy creation: missing JWTs and preflight do not require backend credentials.
  const userClient = () => createClient(requiredEnv("SUPABASE_URL"), userApiKey(), options);
  const adminClient = () => createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), options);
  const otpClient = () => createClient(requiredEnv('SUPABASE_URL'), userApiKey(), { ...options,
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10000) }) } });
  return {
    origins, hmacSecret: Deno.env.get("PARTNERDESK_MFA_HMAC_SECRET"), email: unconfiguredEmail,
    emailOtp: {
      // Explicit readiness gate: configured SMTP, six-digit Token template,
      // 300-second Auth expiry and multi-session compatibility must be checked.
      ready: Deno.env.get('PARTNERDESK_EMAIL_OTP_READY') === 'true',
      async send(email) {
        const { error } = await otpClient().auth.signInWithOtp({ email,
          options: { shouldCreateUser: false, emailRedirectTo: 'https://partnerdesk-phi.vercel.app/login' } });
        if (error) throw new HttpError(503, 'email_delivery_failed');
      },
      async verify(email, token) {
        const { data, error } = await otpClient().auth.verifyOtp({ email, token, type: 'email' });
        // Never return the OTP Auth session or change the browser's password session.
        return error ? null : data.user?.id ?? null;
      },
    },
    async authenticate(jwt) {
      // Auth server verifies the token, including validity/expiry; do not decode
      // an unverified JWT or use getSession / user_metadata as identity evidence.
      const { data, error } = await userClient().auth.getUser(jwt);
      if (error && (error.status === undefined || error.status === 0 || error.status >= 500)) {
        throw new HttpError(503, "backend_unavailable");
      }
      if (error || !data.user) throw new HttpError(401, "invalid_jwt");
      // Decode claims only AFTER getUser has verified the exact JWT with Auth.
      // OTP/magic-link/recovery JWTs alone cannot act as the password factor.
      let claims: { sub?: string; session_id?: string; amr?: { method: string }[] } = {};
      try {
        const payload = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        claims = JSON.parse(atob(payload));
      } catch { /* Legacy/malformed tokens cannot initiate new authentication. */ }
      const passwordSessionId = claims.sub === data.user.id &&
        /^[0-9a-f-]{36}$/i.test(claims.session_id ?? '') &&
        Array.isArray(claims.amr) && claims.amr.some(item => item.method === 'password') ? claims.session_id : undefined;
      return { id: data.user.id, email: data.user.email, passwordSessionId,
        emailConfirmed: Boolean(data.user.email_confirmed_at) };
    },
    async profile(userId) {
      const { data, error } = await adminClient().from("profiles")
        .select("email,account_status").eq("auth_user_id", userId).maybeSingle();
      if (error) throw new HttpError(503, "backend_unavailable");
      return data;
    },
    async ipPolicy() {
      const admin = adminClient();
      const { data: setting, error: settingError } = await admin.from("system_settings")
        .select("value").eq("key", "ip_restriction_enabled").maybeSingle();
      if (settingError) throw new HttpError(503, "backend_unavailable");
      // The verified gateway proof is now the authoritative per-request IP gate.
      if (Deno.env.get('PARTNERDESK_GATEWAY_REQUIRED') === 'true' || setting?.value !== "true") return { enabled: false, hasActiveEntries: false };
      const { data: entries, error: entriesError } = await admin.from("ip_whitelist")
        .select("id").eq("is_active", true).limit(1);
      if (entriesError) throw new HttpError(503, "backend_unavailable");
      return { enabled: true, hasActiveEntries: Boolean(entries?.length) };
    },
    async rpc(name, args) {
      const { data, error } = await adminClient().rpc(name, args);
      if (error || !data || typeof data !== "object" || Array.isArray(data)) {
        throw new HttpError(503, "backend_unavailable");
      }
      return data;
    },
  };
}

Deno.serve(async(req)=>{
 const timing=timedServices(services()),service=timing.service;
 if((Deno.env.get('PARTNERDESK_GATEWAY_REQUIRED')==='true'||req.headers.has('x-partnerdesk-proof'))&&req.method!=='OPTIONS'){
  try{await consumeGateway(req,service);}catch{return timing.finish(response(403,{success:false,reason:'gateway_required'}));}
 }
 return timing.finish(await createHandler(()=>service)(req));
});
