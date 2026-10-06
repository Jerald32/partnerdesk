import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import { createHandler, type Services } from "./handler.ts";
import { allowedOrigins, HttpError } from "./http.ts";
import { unconfiguredEmail } from "./email.ts";

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
  return {
    origins, hmacSecret: Deno.env.get("PARTNERDESK_MFA_HMAC_SECRET"), email: unconfiguredEmail,
    async authenticate(jwt) {
      // Auth server verifies the token, including validity/expiry; do not decode
      // an unverified JWT or use getSession / user_metadata as identity evidence.
      const { data, error } = await userClient().auth.getUser(jwt);
      if (error && (error.status === undefined || error.status === 0 || error.status >= 500)) {
        throw new HttpError(503, "backend_unavailable");
      }
      if (error || !data.user) throw new HttpError(401, "invalid_jwt");
      return { id: data.user.id, email: data.user.email,
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
      if (setting?.value !== "true") return { enabled: false, hasActiveEntries: false };
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

Deno.serve(createHandler(services));
