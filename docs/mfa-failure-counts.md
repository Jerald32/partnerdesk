# MFA failure counts

Applied 2026-11-09 (KST). The existing server policy remains five failed verification attempts followed by a five-minute lock.

The reserve/finish RPCs return bounded `fail_count` and `max_attempts` metadata. The main app-auth Edge function and authenticated gateway forward these values; the browser renders the server count without a local attempt counter.

- Failures 1–4: `인증번호가 일치하지 않습니다. (1/5 - 5회 실패시 5분간 잠금됩니다)` (current count replaces 1).
- Fifth failure: `인증 시도 5회로 5분간 잠겼습니다. (5/5) 잠금 해제 후 인증번호를 다시 요청해 주세요.`
- Missing or malformed metadata retains the existing generic message.

Migration: `20261109000005_mfa_failure_counts.sql`; only response metadata changes. Successful verification, expiry, locks, audit, and permissions are preserved.

Validation: 200 Node tests passed, ESLint and Deno check passed. Tests exercise real in-memory PostgreSQL attempt/lock behavior, Edge responses, gateway filtering and exact browser messages. No production OTP emails or deliberate failed sign-ins were used.

Deployed to Supabase project `bqtlopwgjvvugalktldr` and the PartnerDesk production Vercel project. Frontend/API release overlays only `api/gateway.js` and `src/lib/appAuth.js` over production baseline `dpl_8aViGuwMsx9MRrQ6FpwXZUTSmWae`.
