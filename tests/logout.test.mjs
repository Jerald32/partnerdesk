import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function fixture({ backendFails = false, authError = false, authThrows = false, hasApp = true } = {}) {
  const calls = [], exports = {};
  const source = ts.transpileModule(readFileSync(new URL('../src/lib/logout.js', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mocks = {
    './supabaseClient': { clearPersistedAuth() { calls.push('clear-auth'); }, supabase: { auth: { async signOut(options) {
      assert.deepEqual(options, { scope: 'local' }); calls.push('sign-out');
      if (authThrows) throw new Error('offline');
      return { error: authError ? new Error('offline') : null };
    } } } },
    './appAuth': { async invokeAppAuth(action) { assert.equal(action,'logout'); calls.push('revoke'); if (backendFails) throw new Error('offline'); } },
    './appSession': {getAppSession:()=>hasApp ? {} : null,clearAppSession:()=>calls.push('clear-app')},
    './query-client': {queryClientInstance:{clear:()=>calls.push('clear-cache')}},
  };
  new Function('require','exports','sessionStorage','window',source)(name=>mocks[name], exports,
    {removeItem:key=>{assert.equal(key,'partnerdesk_recovery_user');calls.push('clear-recovery');}},
    {location:{assign:path=>calls.push('redirect:' + path)}});
  return {calls,logout:exports.secureLogout};
}

test('logout revokes the app credential before clearing caches and redirecting', async()=>{
  const f=fixture(); await f.logout('/login');
  assert.deepEqual(f.calls,['revoke','clear-app','clear-recovery','clear-cache','sign-out','redirect:/login']);
});
test('backend revocation outage still clears both credentials and redirects',async()=>{
  const f=fixture({backendFails:true,authError:true}); await f.logout('/login');
  assert.deepEqual(f.calls,['revoke','clear-app','clear-recovery','clear-cache','sign-out','clear-auth','sign-out','redirect:/login']);
});
test('thrown Auth outage is locally cleared; no redirect when caller stays on recovery page',async()=>{
  const f=fixture({authThrows:true,hasApp:false}); await f.logout();
  assert.deepEqual(f.calls,['clear-app','clear-recovery','clear-cache','sign-out','clear-auth']);
});
