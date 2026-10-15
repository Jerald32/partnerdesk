import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FunctionsClient } from '@supabase/functions-js';

function loadModule(path, imports) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL('../' + path, import.meta.url), 'utf8'), {
    fileName: path,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  new Function('require', 'exports', code)(name => {
    if (name in imports) return imports[name];
    throw Error(name);
  }, exports);
  return exports;
}

const title = '접근이 제한된 네트워크입니다.';
const message = '현재 접속 중인 네트워크는 PartnerDesk의 허용된 IP 목록에 등록되어 있지 않습니다. 회사에서 승인된 네트워크로 연결한 후 다시 로그인해 주세요. 문제가 지속되면 시스템 관리자에게 문의해 주세요.';
const generic = 'app-auth 호출에 실패했습니다. Edge Function 배포 및 연결 설정을 확인해 주세요.';

function authWithResponse(response) {
  // Exercise the installed SDK's real HTTP error/context shape.
  const functions = new FunctionsClient('https://fixture.invalid/functions/v1', {
    customFetch: async () => response.clone(),
  });
  return loadModule('src/lib/appAuth.js', {
    './supabaseClient': { supabase: {
      auth: { getSession: async () => ({ data: { session: { access_token: 'fixture', user: { id: 'fixture' } } } }) },
      functions,
    } },
    './appSession': { getAppSession: () => null },
  }).invokeAppAuth;
}

test('only HTTP 403 with the gateway IP denial marker receives network guidance', async () => {
  const invoke = authWithResponse(Response.json({ message: 'ip_not_allowed', request_id: 'fixture' }, { status: 403 }));
  await assert.rejects(invoke('activate-without-mfa'), error => {
    assert.equal(error.title, title);
    assert.equal(error.message, message);
    return true;
  });
});

test('other 403s, non-403 markers, malformed responses and transport failures keep general handling', async () => {
  for (const [status, body, expected] of [
    [403, { message: 'permission denied', code: '42501' }, generic],
    [403, { success: false, reason: 'account_disabled' }, '비활성화된 계정입니다. 관리자에게 문의해 주세요.'],
    [403, { success: false, reason: 'mfa_required' }, '이메일 추가 인증이 필요합니다.'],
    [401, { message: 'invalid_jwt' }, generic],
    [503, { message: 'ip_not_allowed' }, generic],
    [403, { reason: 'ip_not_allowed' }, generic],
  ]) {
    await assert.rejects(authWithResponse(Response.json(body, { status }))('activate-without-mfa'), error => {
      assert.equal(error.title, undefined);
      assert.equal(error.message, expected);
      assert.equal(error.reason, body.reason);
      return true;
    });
  }
  for (const response of [new Response('not JSON', { status: 403 }), Response.json({ message: 'gateway_unavailable' }, { status: 503 })]) {
    await assert.rejects(authWithResponse(response)('activate-without-mfa'), error => error.message === generic && error.title === undefined);
  }
});

test('normal activation and MFA challenge results remain unchanged', async () => {
  for (const body of [{ success: true, token: 'fixture-session' }, { success: true, challenge_id: 'fixture-challenge' }]) {
    assert.deepEqual(await authWithResponse(Response.json(body))('activate-without-mfa'), body);
  }
});

test('login renders the network title/body and retains ordinary error messages', () => {
  const oldWindow = globalThis.window;
  globalThis.window = { location: { search: '' } };
  try {
    for (const authError of [{ title, message }, { message: generic }]) {
      const Element = () => null;
      const { default: Login } = loadModule('src/pages/Login.jsx', {
        react: { ...React, default: React },
        'react-router-dom': { Link: Element, useNavigate: () => () => {} },
        '@/lib/AuthContext': { useAuth: () => ({ authError }) },
        '@/components/ui/button': { Button: Element },
        '@/components/ui/input': { Input: Element },
        '@/components/ui/label': { Label: Element },
        'lucide-react': { LogIn: Element, Mail: Element, Lock: Element, Loader2: Element },
        '@/components/AuthLayout': { default: ({ children }) => React.createElement('div', null, children) },
        '@/components/GoogleIcon': { default: Element },
        '@/lib/supabaseClient': { supabase: {} },
        '@/lib/authRedirect': { authRedirect: () => '' },
        '@/components/auth/EmailMfa': { default: Element },
      });
      const html = renderToStaticMarkup(React.createElement(Login));
      assert.ok(html.includes(authError.message));
      assert.equal(html.includes(title), Boolean(authError.title));
    }
  } finally {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  }
});
