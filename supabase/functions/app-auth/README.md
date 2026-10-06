# PartnerDesk app-auth backend contract

One endpoint: `POST /functions/v1/app-auth`, JSON body with an `action`.
Every POST requires a valid Supabase user access JWT in `Authorization: Bearer ...`.
When invoking through the gateway, also supply the project's public API key in
`apikey` (normally handled by supabase-js). Never send a service-role credential.

This code is not deployed. No frontend integration or migration is included.
The email adapter is deliberately unconfigured; end-to-end email verification
is unavailable until a real provider is selected and explicitly wired in `index.ts`.
No development mock can log or return codes. No secrets have been provisioned.

## Requests and responses

| Action | JSON fields in addition to action | Session header | Behavior |
| --- | --- | --- | --- |
| `send-code` | `force?: boolean` | None | Returns challenge_id, nonce, expires_at, skipped, delivery_status |
| `verify-code` | `challenge_id`, `nonce`, `code`, `device_label?: string` | None | Returns app_session_token only on success, plus session metadata |
| `activate-without-mfa` | `device_label?: string` | None | DB requires the exact setting value `mfa_enabled='false'` |
| `validate-session` | None | `X-PartnerDesk-Session` | Always no-touch; returns valid session metadata |
| `logout` | None | `X-PartnerDesk-Session` | Revokes the matching app session only |

Unexpected JSON fields are rejected, including user/profile/email IDs, hash,
RPC name, table name and touch. No administrative profile-revoke HTTP action exists.
JSON bodies are limited to 4096 bytes. Device labels are at most 200 characters
and cannot contain control characters. Raw session tokens are exactly 64 lowercase
hex characters encoding 32 random bytes. Responses carry `Cache-Control: no-store`.

Failures use `{success:false, reason:<stable code>}`. No SQL/provider exception,
hash, key, raw token or stack trace is relayed or logged. Missing/invalid/expired
JWTs produce 401 when the Auth service is available. Backend availability and
configuration errors produce 503. Account/email failures produce 403. MFA lock
produces 423; a consumed challenge produces 409; an expired challenge produces 410.
Email delivery failure adds `retry_with_force:true`. Session expiry produces 401
but must prompt **app reauthentication**, not a Supabase Auth logout.

## Identity and primary email

The anonymous/public-key client calls Auth `getUser(jwt)` for every POST. The
separate service-role client has no caller Authorization header. Only the verified
Auth user ID is used in fixed profile queries and backend RPC arguments.
Except logout, actions require a confirmed Auth email, a linked profile with the
same email (trimmed, case-insensitive comparison), and a non-suspended/non-disabled
profile. The DB rechecks linkage and account status. Logout remains available
after an email/account/IP policy change. It never invokes Supabase Auth signOut.

`verify_jwt=false` is deliberate: this function performs mandatory server-side
Auth validation itself, supporting asymmetric signing keys without relying on
the legacy gateway verification layer. OPTIONS is the sole unauthenticated path.
See https://supabase.com/docs/guides/functions/auth-legacy-jwt and
https://supabase.com/docs/guides/functions/auth-headers.

## Cryptography and nonce

Code generation uses Web Crypto uint32 rejection sampling over 900,000 values,
then adds 100,000, preserving the existing 100000..999999 code range without bias.
Nonce and raw token each use 32 CSPRNG bytes.

`PARTNERDESK_MFA_HMAC_SECRET` must be hex encoding of 32-128 random bytes, held
only as an Edge secret. Missing or malformed keys are rejected. Provisioning and
rotation are future operational work; rotation invalidates outstanding challenges.
It must remain stable for their five-minute lifetime.

The exact UTF-8 HMAC-SHA-256 input is:
`partnerdesk-mfa-v1|<lowercase auth UUID>|<64 lowercase nonce hex>|<6-digit code>`.
Only `hmac-sha256-v1:<nonce>:<digest>` enters the DB. The browser keeps the returned
challenge ID and public nonce and sends both with its code; it never sends a hash.
There is no existing nonce-read RPC, and private tables are not exposed. Reading
private hashes via service-role table access would broaden this contract needlessly.
DB verification binds the challenge to the profile and compares the stored nonce
and computed digest. Tampering with the public nonce cannot bypass verification;
it causes a failed attempt counted by the DB.

The token hash is SHA-256 of the decoded 32 raw bytes, NOT SHA-256 of the hex text.
Only the hash enters the DB. A newly generated raw token appears only in the one
successful creation response, never a failure or validation response. If the
response is lost after a committed successful verification, the consumed challenge
cannot be retried to retrieve that token; reauthenticate with a new challenge.

## Email configuration, delivery and retries

`EmailAdapter.assertConfigured()` runs before challenge creation. The production
entry uses `unconfiguredEmail`, always producing `503 email_not_configured` and
creating no challenge, sending no email and consuming no resend window.
The existing Korean subject/body are retained by `verificationEmailText`.

A future adapter must have a bounded delivery timeout, reject non-acceptance,
disable payload logging, and return only after its provider accepted the message.
Provider acceptance is not guaranteed mailbox delivery. No provider SDK, key,
generic HTTP email endpoint or mock was added.

DB commit and external delivery cannot be atomic with the existing contract:

1. DB creates the challenge, invalidating preceding unused codes.
2. Edge sends only if `skipped=false`, using that exact code and recipient.
3. A provider error returns 503 with `retry_with_force:true`; DB is already committed.
4. An ordinary resend within one minute returns the existing challenge metadata
   with `skipped=true, delivery_status='unknown'`. It does NOT prove email delivery
   and must not display a freshly-sent confirmation.
5. An explicit force resend creates a fresh code/challenge and can attempt delivery
   again. It does not bypass the DB's five-attempt/five-minute verification lock.

Never send a newly generated code when the DB skips creation, retry a different
code for the same challenge, or send first and then create a possibly-throttled
challenge. After failure/unknown delivery, the future UI should offer explicit
force resend instead of blocking the user behind an ordinary one-minute retry.
Do not silently auto-force retries: force is not delivery rate-limited by the DB.
A delivery-state/outbox/idempotent-retry design needs a separately reviewed DB
contract if stronger guarantees are required; no such migration is added here.

## IP policy: source validation deliberately deferred

The fixed query checks the exact value `ip_restriction_enabled='true'`, and then
whether any active whitelist row exists. Other values disable the restriction;
zero active rows allow access. This differs from legacy Base44's missing-setting
default and follows the explicitly confirmed Step 15 rule.

No header is treated as a trusted client IP. Supabase's maintainer discussion
documents X-Forwarded-For availability but does not establish header sanitization,
trusted hop position, or spoof resistance for this deployment:
https://github.com/orgs/supabase/discussions/7884.

When enforcement is required (enabled plus active entries), non-logout actions
return `503 ip_enforcement_not_configured` before challenge/session side effects.
This is an unsupported-configuration result, not `ip_denied`, a guessed fail-open
policy, or a claim that a supplied IP matched. Actual IP comparison is deferred.
Confirm a spoof-resistant gateway source and IPv4/IPv6 text compatibility first.
No text normalization, CIDR interpretation or DB recovery restriction is added.
Logout is always permitted with a verified JWT and the matching token.

## Idle handling, CORS and environment

`validate-session` always passes `p_touch=false`, so caller-supplied touch cannot
turn polling into activity. A browser cannot prove actual human activity by merely
claiming it. Future trusted business endpoints must validate-and-touch as part of
accepted work, while status polling stays no-touch. Until that integration exists,
the 15-minute idle interval is never extended by this endpoint. DB controls the
eight-hour absolute lifetime; session UUID metadata alone is not a credential.
Do not place the new raw token into the legacy frontend without a reviewed storage
and integration change. The existing localStorage code is untouched.

CORS uses exact configured origins, no wildcard and no cookie credentials.
Authorization carries the Supabase JWT; X-PartnerDesk-Session carries the app token.
Without configuration, local development permits only http://localhost:5173 and
http://127.0.0.1:5173. Hosted deployments (DENO_DEPLOYMENT_ID present) permit no
browser origins until configured. Non-browser requests without Origin still need
JWT validation. OPTIONS accepts approved-origin POST preflight requests only.
Do not infer production origins from the sample Base44 URL in the root README.

Hosted Supabase provides SUPABASE_URL, SUPABASE_ANON_KEY and
SUPABASE_SERVICE_ROLE_KEY. SUPABASE_PUBLISHABLE_KEYS['default'] is supported as a
public-key alternative. PARTNERDESK_ALLOWED_ORIGINS and PARTNERDESK_MFA_HMAC_SECRET
must be separately provisioned later. See ../.env.example's actual location:
`supabase/functions/.env.example`. Do not mix these with Vite environment values.
See https://supabase.com/docs/guides/functions/secrets.

No audit is appended: the current audit RPC's service-role execution is revoked
and its actor comes from auth.uid(). A trusted actor-aware audit contract needs
separate review. Never record code, token, hash or full IP values.
Distributed IP/user delivery rate limits remain a hardening prerequisite for
enabling a provider, especially force resend. No Redis, table or process-local
counter pretending to be a distributed limit has been introduced.

## Offline verification

`node --test supabase/functions/app-auth/app-auth.test.mjs` runs the actual local
TypeScript helpers/handler through the project's installed TypeScript transpiler
with fake Auth/DB/email services. It does not contact Supabase, send mail, use a
real secret, execute SQL, or exercise Deno's gateway/runtime. Strict TypeScript
checking is possible for the four dependency-free modules. Deno is not installed
in the current workspace environment, so actual Deno npm resolution, deployed JWT,
RPC permissions, concurrency, email delivery and trusted IP tests remain pending.
