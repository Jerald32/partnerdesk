// Offline security-contract tests. All credentials/identities are public fixtures.
// Load the actual TS modules without installing Deno or resolving remote imports.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, webcrypto } from 'node:crypto';

const require = createRequire(import.meta.url);
const ts = require('typescript');
globalThis.crypto ??= webcrypto;
const directory = dirname(fileURLToPath(import.meta.url));
const cache = new Map();
function load(name) {
  const path = resolve(directory, name);
  if (cache.has(path)) return cache.get(path).exports;
  const module = { exports: {} };
  cache.set(path, module);
  const output = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: path,
  }).outputText;
  const localRequire = (id) => id.startsWith('.') ? load(resolve(dirname(path), id)) : require(id);
  new Function('require', 'module', 'exports', output)(localRequire, module, module.exports);
  return module.exports;
}

const { createHandler } = load('handler.ts');
const { HttpError, allowedOrigins } = load('http.ts');
const { unconfiguredEmail, verificationEmailText } = load('email.ts');
const { importHmacKey, codeHash, randomHex, sessionHash, verificationCode } = load('crypto.ts');
const userId = '11111111-1111-4111-8111-111111111111';
const challengeId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const nonce = '00'.repeat(32);
const token = '01'.repeat(32);
const fixtureKey = 'ab'.repeat(32); // Known test vector, not a provisioned secret.

function fixture(overrides = {}) {
  const calls = [];
  const sent = [];
  const services = {
    origins: new Set(['http://localhost:5173']),
    authenticate: async (jwt) => {
      if (jwt !== 'valid-fixture-jwt') throw new HttpError(401, 'invalid_jwt');
      return { id: userId, email: 'user@example.invalid', emailConfirmed: true };
    },
    profile: async () => ({ email: 'user@example.invalid', account_status: 'pending_login' }),
    ipPolicy: async () => ({ enabled: false, hasActiveEntries: false }),
    hmacSecret: fixtureKey,
    email: { assertConfigured() {}, async sendVerificationEmail(email) { sent.push(email); } },
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'backend_create_mfa_challenge') return {
        ok: true, skipped: false, challenge_id: challengeId,
        email: 'user@example.invalid', nonce: args.p_code_hash.split(':')[1],
        expires_at: '2030-01-01T00:05:00Z',
      };
      return { ok: true, valid: true, session_id: sessionId,
        expires_at: '2030-01-01T08:00:00Z', last_activity_at: '2030-01-01T00:00:00Z' };
    },
    ...overrides,
  };
  return { services, calls, sent, handle: createHandler(() => services) };
}
function request(body, options = {}) {
  return new Request('https://example.invalid/functions/v1/app-auth', {
    method: 'POST', headers: { authorization: 'Bearer valid-fixture-jwt',
      'content-type': 'application/json', ...options.headers }, body: JSON.stringify(body),
  });
}
async function result(handle, body, options) {
  const res = await handle(request(body, options));
  return { status: res.status, body: await res.json(), headers: res.headers };
}

test('missing, invalid and expired JWTs do not reach DB/email', async () => {
  const f = fixture();
  for (const authorization of ['', 'Bearer invalid', 'Bearer expired', 'Basic anything']) {
    const r = await result(f.handle, { action: 'send-code' }, { headers: { authorization } });
    assert.equal(r.status, 401);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
});

test('body identities, arbitrary RPC and client touch are rejected', async () => {
  const f = fixture();
  for (const body of [
    { action: 'send-code', auth_user_id: sessionId },
    { action: 'verify-code', profile_id: sessionId },
    { action: 'validate-session', touch: true },
    { action: 'revoke-profile-sessions' },
    { action: 'constructor' },
  ]) assert.equal((await result(f.handle, body)).status, 400);
  assert.equal(f.calls.length, 0);
});

test('CSPRNG output, exact Step14 HMAC and raw-byte token hash', async () => {
  for (let i = 0; i < 100; i++) assert.match(verificationCode(), /^[1-9][0-9]{5}$/);
  assert.equal(randomHex(32).length, 64);
  const key = await importHmacKey(fixtureKey);
  const actual = await codeHash(key, userId.toUpperCase(), nonce, '123456');
  const expected = createHmac('sha256', Buffer.from(fixtureKey, 'hex'))
    .update(`partnerdesk-mfa-v1|${userId}|${nonce}|123456`).digest('hex');
  assert.equal(actual, `hmac-sha256-v1:${nonce}:${expected}`);
  assert.equal(await sessionHash(token), createHash('sha256').update(Buffer.from(token, 'hex')).digest('hex'));
  await assert.rejects(importHmacKey(undefined));
  await assert.rejects(importHmacKey('weak'));
});

test('provider/key not configured: no challenge creation or fake success', async () => {
  for (const override of [{ email: unconfiguredEmail }, { hmacSecret: undefined }]) {
    const f = fixture(override);
    const r = await result(f.handle, { action: 'send-code' });
    assert.equal(r.status, 503); assert.equal(r.body.success, false);
    assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
  }
});

test('send delivers the exact generated code, but response/RPC never contains raw code', async () => {
  const f = fixture();
  const r = await result(f.handle, { action: 'send-code' });
  assert.equal(r.status, 200); assert.equal(r.body.delivery_status, 'accepted');
  assert.equal(f.sent.length, 1); assert.equal(f.calls[0].args.p_auth_user_id, userId);
  const email = f.sent[0];
  const key = await importHmacKey(fixtureKey);
  assert.equal(f.calls[0].args.p_code_hash, await codeHash(key, userId, r.body.nonce, email.code));
  assert(!Object.values(r.body).includes(email.code));
  assert(!Object.hasOwn(f.calls[0].args, 'code'));
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert(verificationEmailText(email).body.includes('유효시간: 5분'));
});

test('skipped challenge does not send a newly generated code or claim delivery', async () => {
  const f = fixture({ rpc: async () => ({ ok: true, skipped: true,
    challenge_id: challengeId, nonce, expires_at: '2030-01-01T00:05:00Z' }) });
  const r = await result(f.handle, { action: 'send-code' });
  assert.equal(r.body.skipped, true); assert.equal(r.body.delivery_status, 'unknown');
  assert.equal(f.sent.length, 0);
});

test('post-commit provider error is redacted and gives explicit force recovery', async () => {
  const f = fixture({ email: { assertConfigured() {}, async sendVerificationEmail() {
    throw new Error('secret provider stack/code');
  } } });
  const r = await result(f.handle, { action: 'send-code', force: true });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].args.p_force, true);
  assert.deepEqual(r.body, { success: false, reason: 'email_delivery_failed', retry_with_force: true });
  assert.equal(r.status, 503);
});

test('successful verify returns one raw token; DB sees hashes only', async () => {
  const f = fixture();
  const r = await result(f.handle, { action: 'verify-code', challenge_id: challengeId,
    nonce, code: '123456' });
  assert.equal(r.status, 200); assert.match(r.body.app_session_token, /^[0-9a-f]{64}$/);
  assert.equal(f.calls[0].args.p_session_token_hash, await sessionHash(r.body.app_session_token));
  assert.equal(f.calls[0].args.p_candidate_code_hash,
    await codeHash(await importHmacKey(fixtureKey), userId, nonce, '123456'));
  assert(!Object.hasOwn(f.calls[0].args, 'code'));
  assert(!Object.hasOwn(f.calls[0].args, 'app_session_token'));
});

test('verification/activation failures return no token or DB secret detail', async () => {
  for (const reason of ['code_invalid', 'mfa_locked', 'challenge_consumed', 'mfa_required', 'secret_sql_error', 'constructor']) {
    const f = fixture({ rpc: async () => ({ ok: false, reason, hash: 'sensitive' }) });
    const r = await result(f.handle, { action: 'verify-code', challenge_id: challengeId, nonce, code: '123456' });
    assert.equal(r.body.success, false); assert(!Object.hasOwn(r.body, 'app_session_token'));
    assert(!JSON.stringify(r.body).includes('sensitive'));
    if (reason === 'secret_sql_error' || reason === 'constructor') assert.equal(r.body.reason, 'backend_unavailable');
  }
  const f = fixture({ rpc: async () => { throw new Error('SQL secret'); } });
  assert.deepEqual((await result(f.handle, { action: 'activate-without-mfa' })).body,
    { success: false, reason: 'backend_unavailable' });
});

test('activation delegates MFA setting decision to the fixed DB RPC', async () => {
  const f = fixture();
  const r = await result(f.handle, { action: 'activate-without-mfa' });
  assert.equal(r.status, 200); assert.equal(f.calls[0].name, 'backend_activate_app_session_without_mfa');
  assert.equal(f.calls[0].args.p_session_token_hash, await sessionHash(r.body.app_session_token));
});

test('validate is no-touch and logout revokes only the hashed own session', async () => {
  const f = fixture();
  const headers = { 'x-partnerdesk-session': token };
  const validation = await result(f.handle, { action: 'validate-session' }, { headers });
  assert.equal(validation.status, 200); assert.equal(f.calls[0].args.p_touch, false);
  assert.equal(f.calls[0].args.p_session_token_hash, await sessionHash(token));
  assert(!Object.hasOwn(validation.body, 'app_session_token'));
  const logout = await result(f.handle, { action: 'logout' }, { headers });
  assert.equal(logout.status, 200); assert.equal(f.calls[1].name, 'backend_revoke_app_session');
  assert.equal(f.calls[1].args.p_auth_user_id, userId);
});

test('bad nonce/code/device/token formats are rejected before RPC', async () => {
  const f = fixture();
  for (const change of [{ code: '12345' }, { code: 123456 }, { nonce: 'invalid' },
    { challenge_id: 'invalid' }, { device_label: 'bad\nlabel' }]) {
    assert.equal((await result(f.handle, { action: 'verify-code', challenge_id: challengeId,
      nonce, code: '123456', ...change })).status, 400);
  }
  assert.equal((await result(f.handle, { action: 'validate-session' },
    { headers: { 'x-partnerdesk-session': 'invalid' } })).status, 400);
  assert.equal(f.calls.length, 0);
});

test('suspended/disabled/email mismatch cannot create authentication', async () => {
  for (const account_status of ['suspended', 'disabled']) {
    const f = fixture({ profile: async () => ({ email: 'user@example.invalid', account_status }) });
    const denied = await result(f.handle, { action: 'activate-without-mfa' });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.reason, 'account_' + account_status);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture({ profile: async () => ({ email: 'other@example.invalid', account_status: 'active' }) });
  assert.equal((await result(f.handle, { action: 'send-code' })).body.reason, 'email_identity_mismatch');
});

test('required IP enforcement is unavailable, spoofed headers cannot permit access', async () => {
  const f = fixture({ ipPolicy: async () => ({ enabled: true, hasActiveEntries: true }) });
  const r = await result(f.handle, { action: 'activate-without-mfa' },
    { headers: { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' } });
  assert.equal(r.status, 503); assert.equal(r.body.reason, 'ip_enforcement_not_configured');
  assert.equal(f.calls.length, 0);
  const zero = fixture({ ipPolicy: async () => ({ enabled: true, hasActiveEntries: false }) });
  assert.equal((await result(zero.handle, { action: 'activate-without-mfa' })).status, 200);
});

test('logout remains available after email/account/IP changes', async () => {
  const f = fixture({
    authenticate: async () => ({ id: userId, emailConfirmed: false }),
    profile: async () => { throw new Error('must not query'); },
    ipPolicy: async () => { throw new Error('must not query'); },
  });
  assert.equal((await result(f.handle, { action: 'logout' },
    { headers: { 'x-partnerdesk-session': token } })).status, 200);
});

test('CORS uses approved exact origins and authenticated POST; hosted defaults empty', async () => {
  assert.equal(allowedOrigins(undefined, true).size, 0);
  assert(allowedOrigins(undefined, false).has('http://localhost:5173'));
  for (const value of ['*', 'null', 'https://example.invalid/path', 'http://example.invalid']) {
    assert.throws(() => allowedOrigins(value, true));
  }
  const f = fixture();
  const preflight = await f.handle(new Request('https://example.invalid', {
    method: 'OPTIONS', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
  }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  assert.equal((await result(f.handle, { action: 'send-code' },
    { headers: { origin: 'https://evil.invalid' } })).status, 403);
});

test('oversized JSON and malformed DB success metadata do not leak token', async () => {
  const f = fixture();
  assert.equal((await result(f.handle, { action: 'send-code', padding: 'x'.repeat(5000) })).status, 413);
  const bad = fixture({ rpc: async () => ({ ok: true, hash: 'secret' }) });
  assert.deepEqual((await result(bad.handle, { action: 'activate-without-mfa' })).body,
    { success: false, reason: 'backend_unavailable' });
});

test('actual entry validates JWT with public client and keeps service-role client isolated', async () => {
  const created = [];
  const authCalls = [];
  const rpcCalls = [];
  const environment = {
    SUPABASE_URL: 'https://example.invalid', SUPABASE_ANON_KEY: 'public-test-fixture',
    SUPABASE_SERVICE_ROLE_KEY: 'admin-test-fixture', PARTNERDESK_ALLOWED_ORIGINS: 'http://localhost:5173',
  };
  let handle;
  const deno = { env: { get: (name) => environment[name] }, serve: (handler) => { handle = handler; } };
  const sdk = { createClient(url, key, options) {
    assert.equal(url, 'https://example.invalid');
    created.push({ key, options });
    return {
      auth: { async getUser(jwt) {
        assert.equal(key, 'public-test-fixture');
        authCalls.push(jwt);
        if (jwt === 'auth-outage') return { data: {}, error: { status: 503 } };
        if (jwt !== 'valid-fixture-jwt') return { data: {}, error: { status: 401 } };
        return { data: { user: { id: userId, email: 'user@example.invalid',
          email_confirmed_at: '2030-01-01T00:00:00Z' } }, error: null };
      } },
      from(table) {
        assert.equal(key, 'admin-test-fixture');
        const query = {
          select() { return query; }, eq() { return query; },
          async maybeSingle() { return { data: table === 'profiles'
            ? { email: 'user@example.invalid', account_status: 'active' } : null, error: null }; },
        };
        return query;
      },
      async rpc(name, args) {
        assert.equal(key, 'admin-test-fixture'); rpcCalls.push({ name, args });
        return { data: { ok: true, session_id: sessionId, expires_at: '2030-01-01T08:00:00Z',
          last_activity_at: '2030-01-01T00:00:00Z' }, error: null };
      },
    };
  } };
  const output = ts.transpileModule(readFileSync(resolve(directory, 'index.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const imports = (id) => id === 'npm:@supabase/supabase-js@2.95.0' ? sdk : load(id);
  new Function('require', 'Deno', 'exports', output)(imports, deno, {});
  assert.equal((await result(handle, { action: 'logout' }, { headers: { authorization: '' } })).status, 401);
  assert.equal(authCalls.length, 0);
  assert.equal((await result(handle, { action: 'logout' }, { headers: { authorization: 'Bearer expired' } })).status, 401);
  assert.equal((await result(handle, { action: 'logout' }, { headers: { authorization: 'Bearer auth-outage' } })).status, 503);
  const success = await result(handle, { action: 'activate-without-mfa' });
  assert.equal(success.status, 200); assert.equal(rpcCalls[0].args.p_auth_user_id, userId);
  assert.equal(rpcCalls[0].name, 'backend_activate_app_session_without_mfa');
  for (const client of created) {
    assert.equal(client.options.auth.persistSession, false);
    assert.equal(client.options.global, undefined);
  }
});
