import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import ts from 'typescript';

function fixture({ search = '', login = async () => ({}) } = {}) {
  const slots = [], effects = [], listeners = new Map(), auth = { login, mfaChallenge: null };
  let cursor = 0, authListener, resets = 0, unsubscribed = 0;
  const navigations = [];
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = value; }];
    },
    useRef(initial) {
      const index = cursor++;
      return slots[index] ||= { current: initial };
    },
    useEffect(effect, dependencies) {
      const index = cursor++, previous = slots[index];
      if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) {
        effects.push(() => {
          previous?.cleanup?.();
          slots[index] = { dependencies, cleanup: effect() };
        });
      }
    },
  };
  const Input = () => null, Element = () => null;
  const imports = {
    react: { ...React, ...hooks, default: React },
    'react-router-dom': { Link: Element, useNavigate: () => (...args) => navigations.push(args) },
    '@/lib/AuthContext': { useAuth: () => auth },
    '@/components/ui/button': { Button: Element },
    '@/components/ui/input': { Input },
    '@/components/ui/label': { Label: Element },
    'lucide-react': { LogIn: Element, Mail: Element, Lock: Element, Loader2: Element },
    '@/components/AuthLayout': { default: Element },
    '@/components/GoogleIcon': { default: Element },
    '@/lib/supabaseClient': { supabase: { auth: { onAuthStateChange(callback) {
      authListener = callback;
      return { data: { subscription: { unsubscribe() { unsubscribed++; authListener = undefined; } } } };
    } } } },
    '@/lib/authRedirect': { authRedirect: () => '' },
    '@/components/auth/EmailMfa': { default: Element },
  };
  const exports = {};
  const source = ts.transpileModule(readFileSync(new URL('../src/pages/Login.jsx', import.meta.url), 'utf8'), {
    fileName: 'Login.jsx', compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  const window = { location: { search }, addEventListener: (event, callback) => listeners.set(event, callback),
    removeEventListener: event => listeners.delete(event) };
  new Function('require', 'exports', 'window', source)(name => {
    assert.ok(name in imports, name);
    return imports[name];
  }, exports, window);
  function find(element, predicate) {
    if (!element || typeof element !== 'object') return undefined;
    if (predicate(element)) return element;
    for (const child of React.Children.toArray(element.props?.children)) {
      const result = find(child, predicate);
      if (result) return result;
    }
  }
  function render() {
    cursor = 0;
    const tree = exports.default();
    const form = find(tree, element => element.type === 'form');
    if (form) form.ref.current = { reset() { resets++; } };
    effects.splice(0).forEach(effect => effect());
    return { form, input: id => find(tree, element => element.type === Input && element.props.id === id) };
  }
  render();
  return { auth, render, navigations, emit: event => authListener?.(event),
    pageShow: persisted => listeners.get('pageshow')?.({ persisted }),
    get resets() { return resets; }, get unsubscribed() { return unsubscribed; }, listeners,
    dispose() { for (const slot of slots) slot?.cleanup?.(); } };
}

function fill(f) {
  const view = f.render();
  view.input('email').props.onChange({ target: { value: 'fixture@example.invalid' } });
  view.input('password').props.onChange({ target: { value: 'fixture-password' } });
}
function assertEmpty(f) {
  const view = f.render();
  assert.equal(view.input('email').props.value, '');
  assert.equal(view.input('password').props.value, '');
}

test('logout clears both inputs and resets the form without touching saved browser credentials', () => {
  const f = fixture();
  fill(f);
  f.emit('TOKEN_REFRESHED');
  assert.equal(f.render().input('password').props.value, 'fixture-password');
  f.emit('SIGNED_OUT');
  assertEmpty(f);
  assert.ok(f.resets >= 2);
  f.dispose();
  assert.equal(f.unsubscribed, 1);
  assert.equal(f.listeners.size, 0);
});

test('MFA cancel clears retained inputs even without an SDK signout event', () => {
  const f = fixture({ search: '?mfa-test=1' });
  fill(f);
  f.auth.mfaChallenge = { pending: true };
  f.render();
  f.auth.mfaChallenge = null;
  f.render();
  assertEmpty(f);
});

test('restoring a cached page clears inputs; ordinary pageshow does not erase typing', () => {
  const f = fixture();
  fill(f);
  f.pageShow(false);
  assert.equal(f.render().input('password').props.value, 'fixture-password');
  f.pageShow(true);
  assertEmpty(f);
});

test('normal and MFA test submissions preserve arguments, navigation and clear passwords on success or failure', async () => {
  for (const search of ['', '?mfa-test=1']) {
    for (const failure of [false, true]) {
      const calls = [], mfaRequired = Boolean(search);
      const f = fixture({ search, login: async (...args) => {
        calls.push(args);
        if (failure) throw Error('fixture failure');
        return { mfaRequired };
      } });
      fill(f);
      await f.render().form.props.onSubmit({ preventDefault() {} });
      assert.deepEqual(calls, [['fixture@example.invalid', 'fixture-password', { emailMfa: mfaRequired }]]);
      assert.equal(f.render().input('password').props.value, '');
      assert.equal(f.navigations.length, !failure && !mfaRequired ? 1 : 0);
    }
  }
});
