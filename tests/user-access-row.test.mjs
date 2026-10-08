// Exercise the real component handlers and useRpcAction with isolated React
// hook state and an in-memory RPC. No remote user or database is modified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const operatorId = '11111111-1111-4111-8111-111111111111';
const otherOperatorId = '22222222-2222-4222-8222-222222222222';
const partnerId = '33333333-3333-4333-8333-333333333333';
const incompletePartnerId = '44444444-4444-4444-8444-444444444444';
const profile = { id: '55555555-5555-4555-8555-555555555555', role: 'admin', organization_id: operatorId, account_status: 'active', email: 'fixture@example.invalid' };
const organizations = [
  { id: operatorId, name: 'Operator A', type: 'operator', is_active: true },
  { id: otherOperatorId, name: 'Operator B', type: 'operator', is_active: true },
  { id: partnerId, name: 'Partner A', type: 'partner', is_active: true, partner_details: { organization_id: partnerId } },
  { id: incompletePartnerId, name: 'Incomplete partner', type: 'partner', is_active: true, partner_details: null },
  { id: '66666666-6666-4666-8666-666666666666', name: 'Inactive', type: 'operator', is_active: false },
];

function fixture(options = {}) {
  const slots = [], modules = new Map(), calls = [];
  let cursor = 0, saved = 0, confirmations = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
  };
  const supabase = { async rpc(name, args) {
    calls.push({ name, args });
    if (options.rpc) return options.rpc(name, args);
    return { data: { id: args.p_profile_id, role: args.p_role, organization_id: args.p_organization_id }, error: null };
  } };
  function load(path) {
    if (modules.has(path)) return modules.get(path);
    const exports = {}; modules.set(path, exports);
    const source = ts.transpileModule(readFileSync(new URL('../' + path, import.meta.url), 'utf8'), {
      fileName: path,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const imports = name => name === 'react' ? react
      : name === '@/lib/supabaseClient' || name === './supabaseClient' ? { supabase }
      : name === './roles' ? load('src/lib/roles.js')
      : name.startsWith('@/') ? load('src/' + name.slice(2) + (name.endsWith('useRpcAction') || name.endsWith('userAccessForm') || name.endsWith('supabaseData') || name.endsWith('roles') ? '.js' : '.jsx'))
      : require(name);
    new Function('require', 'exports', 'window', source)(imports, exports, { confirm() { confirmations++; return options.confirm !== false; } });
    return exports;
  }
  const Row = load('src/components/users/UserAccessRow.jsx').default;
  const props = { profile, organizations, actorId: profile.id, onSaved: () => { saved++; }, ...options.props };
  const render = () => { cursor = 0; return Row(props); };
  function find(node, predicate) {
    if (node && typeof node === 'object' && predicate(node)) return node;
    for (const child of [node?.props?.children].flat(Infinity)) {
      if (child && typeof child === 'object') { const result = find(child, predicate); if (result) return result; }
    }
  }
  const text = node => typeof node === 'string' ? node : [node?.props?.children].flat(Infinity).map(child => typeof child === 'string' ? child : child?.props ? text(child) : '').join(' ');
  const select = label => find(render(), node => node.type === 'select' && node.props['aria-label'] === label);
  return {
    calls, render, find, text, saved: () => saved, confirmations: () => confirmations,
    changeRole: value => select('사용자 역할').props.onChange({ target: { value } }),
    changeOrganization: value => select('사용자 조직').props.onChange({ target: { value } }),
    organization: () => select('사용자 조직').props.value,
    saveButton: () => find(render(), node => node.type === 'button' && node.props.type === 'submit'),
    submit: () => render().props.onSubmit({ preventDefault() {} }),
    alert: () => text(find(render(), node => node.props.role === 'alert')),
  };
}

test('unchanged access is disabled with a visible reason and cannot submit', async () => {
  const f = fixture();
  assert.equal(f.saveButton().props.disabled, true);
  assert.match(f.text(f.render()), /역할 또는 조직을 변경/);
  await f.submit(); assert.equal(f.calls.length, 0);
});

test('admin to operator keeps the compatible org and submits the exact RPC contract', async () => {
  const f = fixture(); f.changeRole('operator');
  assert.equal(f.organization(), operatorId);
  assert.equal(f.saveButton().props.disabled, false);
  await f.submit();
  assert.deepEqual(f.calls, [{ name: 'change_profile_role_organization', args: { p_profile_id: profile.id, p_role: 'operator', p_organization_id: operatorId } }]);
  assert.equal(f.saved(), 1);
});

test('organization is selected first and partner supports Admin and Operator without resetting org', async () => {
  const f = fixture(); f.changeOrganization(partnerId);
  assert.equal(f.organization(), partnerId); assert.equal(f.saveButton().props.disabled, false);
  assert.ok(!f.text(f.render()).includes('Incomplete partner'));
  assert.match(f.text(f.render()), /Business Partner.*Service Partner/);
  f.changeRole('operator'); assert.equal(f.organization(), partnerId);
  await f.submit(); assert.equal(f.calls[0].args.p_organization_id, partnerId);
  assert.equal(f.calls[0].args.p_role, 'operator');
  assert.equal(f.saved(), 1);
  f.changeRole('admin'); await f.submit(); assert.equal(f.calls[1].args.p_role,'admin');
});

test('org-only edits save, while reverting both fields disables saving', async () => {
  const f = fixture(); f.changeOrganization(otherOperatorId);
  assert.equal(f.saveButton().props.disabled, false);
  await f.submit(); assert.equal(f.calls[0].args.p_role, 'admin');
  f.changeOrganization(operatorId); assert.equal(f.saveButton().props.disabled, true);
});

test('confirmation cancellation does not call the RPC', async () => {
  const f = fixture({ confirm: false }); f.changeRole('operator');
  await f.submit(); assert.equal(f.calls.length, 0); assert.equal(f.saved(), 0);
});

test('last-active-admin rejection is shown without treating it as success', async () => {
  const f = fixture({ rpc: async () => ({ error: { code: '42501', message: 'last_active_admin_protected' } }) });
  f.changeRole('operator'); await f.submit();
  assert.match(f.alert(), /마지막 활성 관리자/); assert.equal(f.saved(), 0);
  assert.equal(f.saveButton().props.disabled, false);
});

test('expired app session rejection tells the admin to log in again', async () => {
  const f = fixture({ rpc: async () => ({ error: { code: '28000', message: 'app_session_required' } }) });
  f.changeRole('operator'); await f.submit(); assert.match(f.alert(), /다시 로그인/);
  assert.equal(f.saved(), 0);
});

test('pending save blocks duplicate submissions and shows progress', async () => {
  let finish;
  const f = fixture({ rpc: (name, args) => new Promise(resolve => { finish = () => resolve({ data: { id: args.p_profile_id, role: args.p_role, organization_id: args.p_organization_id } }); }) });
  f.changeRole('operator'); const pending = f.submit();
  assert.equal(f.saveButton().props.disabled, true); assert.match(f.text(f.render()), /저장 중/);
  await f.submit(); assert.equal(f.calls.length, 1); assert.equal(f.confirmations(), 1);
  finish(); await pending; assert.equal(f.saved(), 1);
});

test('network result uncertainty blocks resubmission until the list is refreshed', async () => {
  const f = fixture({ rpc: async () => { throw new Error('offline'); } });
  f.changeRole('operator'); await f.submit();
  assert.equal(f.saveButton().props.disabled, true); assert.match(f.alert(), /목록을 새로고침/);
  await f.submit(); assert.equal(f.calls.length, 1); assert.equal(f.saved(), 0);
});

test('mismatched saved role/org response is not reported as success', async () => {
  const f = fixture({ rpc: async () => ({ data: { id: profile.id, role: 'admin', organization_id: partnerId } }) });
  f.changeRole('operator'); await f.submit();
  assert.equal(f.saved(), 0); assert.equal(f.saveButton().props.disabled, true);
  assert.match(f.alert(), /처리 결과를 확인/);
});

test('inactive or missing partner-detail org cannot be submitted', async () => {
  const f = fixture(); f.changeRole('admin'); f.changeOrganization(incompletePartnerId);
  assert.equal(f.saveButton().props.disabled, true); await f.submit(); assert.equal(f.calls.length, 0);
  f.changeRole('operator'); f.changeOrganization(organizations[4].id);
  assert.equal(f.saveButton().props.disabled, true); await f.submit(); assert.equal(f.calls.length, 0);
});

test('no eligible org is explained; arbitrary role cannot enable save', async () => {
  const f = fixture({ props: { organizations: [] } }); f.changeRole('operator');
  assert.match(f.text(f.render()), /활성 조직이 없습니다/); assert.equal(f.saveButton().props.disabled, true);
  f.changeRole('super_admin'); await f.submit(); assert.equal(f.calls.length, 0);
});

test('missing org and holding-org approval keep normal validation restrictions', async () => {
  const f=fixture(); f.changeOrganization('');
  assert.equal(f.saveButton().props.disabled,true); assert.match(f.text(f.render()),/조직을 먼저/);
  await f.submit(); assert.equal(f.calls.length,0);
  const holding='10a8e084-c396-4a97-b301-c4ef4aa59d71';
  const g=fixture({props:{organizations:[...organizations,{id:holding,name:'대기 조직',type:'operator',is_active:true}]}});
  g.changeOrganization(holding); assert.equal(g.saveButton().props.disabled,true);
  g.changeRole('guest'); assert.equal(g.saveButton().props.disabled,false);
});

test('other-organization denial is explained and not reported as success', async () => {
  const f=fixture({rpc:async()=>({error:{code:'42501',message:'organization_management_forbidden'}})});
  f.changeOrganization(partnerId); await f.submit();
  assert.match(f.alert(),/다른 조직/); assert.equal(f.saved(),0);
});
