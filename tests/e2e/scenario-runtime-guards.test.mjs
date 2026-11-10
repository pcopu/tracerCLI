import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The CLI launches this isolated synthetic app; only the app imports the adapter.
const cli = fileURLToPath(new URL('../../bin/tracer.mjs', import.meta.url));
const runtime = new URL('../../src/scenario-runtime.mjs', import.meta.url).href;
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tracer-runtime-guards-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const env = { ...process.env, TRACER_NO_UPDATE: '1', HOME: root, CODEX_HOME: '', NODE_OPTIONS: '' };
  const put = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value)); };
  const invoke = (...args) => spawnSync(process.execPath, [cli, '--root', root, ...args], { encoding: 'utf8', env, timeout: 20000 });
  const ok = (...args) => { const r = invoke(...args); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  put('fixture.mjs', 'export const fixture = true;\n');
  put('assertions.mjs', "import assert from 'node:assert/strict'; export function check(calls) { assert.deepEqual(calls, ['first', 'second']); }\n");
  put('draft.json', { version: 1, kind: 'scenario-step-catalog', steps: [{ id: 'one', title: 'One', preconditions: ['Clean fixture'], actions: ['first', 'second'], expectations: [{ id: 'verified', description: 'Fixture verified', witness: { path: 'assertions.mjs', start: 1, end: 1 } }], mappings: [{ source: { path: 'fixture.mjs', start: 1, end: 1 }, expectation: 'verified', why: 'Verify fixture.' }] }], scenarios: [{ id: 'journey', title: 'Fixture journey', steps: ['one'] }] });
  const pinned = JSON.parse(ok('scenario', 'prepare', '--file', 'draft.json', '--json'));
  put('catalog.json', pinned);
  put('app.mjs', `import { createScenarioRun } from ${JSON.stringify(runtime)};
import { readFileSync } from 'node:fs'; import { check } from './assertions.mjs';
const catalog = JSON.parse(readFileSync('catalog.json', 'utf8'));
const mode = process.argv[2], calls = [];
const args = { catalog, scenarioId: 'journey', runId: 'run-1', context: { build: 'v1', platform: 'test', inputRoute: 'CLI' } };
const attempt = async fn => { try { await fn(); return 'none'; } catch (e) { return e.code || 'untyped'; } };
const result = {};
if (mode === 'initialization') {
  const cases = [];
  function add(name, change, code) { const input = structuredClone(args); change(input); cases.push([name, input, code]); }
  add('run empty', x => x.runId = '', 'invalid-run-id');
  add('run length', x => x.runId = 'a'.repeat(129), 'invalid-run-id');
  add('run punctuation', x => x.runId = 'a.b', 'invalid-run-id');
  add('scenario type', x => x.scenarioId = 1, 'invalid-scenario-id');
  add('scenario unknown', x => x.scenarioId = 'unknown', 'unknown-scenario');
  add('context array', x => x.context = [], 'invalid-context');
  add('context null', x => x.context = null, 'invalid-context');
  add('context extra', x => x.context.secret = 'SECRET-DATA', 'invalid-context');
  add('context empty', x => x.context.build = '', 'invalid-context');
  add('context spaces', x => x.context.build = ' x ', 'invalid-context');
  add('context controls', x => x.context.build = 'x\\ny', 'invalid-context');
  add('context length', x => x.context.build = 'x'.repeat(257), 'invalid-context');
  add('context type', x => x.context.build = 4, 'invalid-context');
  add('catalog missing', x => x.catalog = {}, 'invalid-catalog');
  add('catalog nonfinite', x => x.catalog.version = Infinity, 'invalid-catalog');
  add('catalog bigint', x => x.catalog.version = 1n, 'invalid-catalog');
  add('catalog cycle', x => x.catalog.cycle = x.catalog, 'invalid-catalog');
  add('catalog sparse', x => x.catalog.steps = Array(1), 'invalid-catalog');
  add('catalog function', x => x.catalog.x = () => {}, 'invalid-catalog');
  add('catalog symbol', x => x.catalog[Symbol('s')] = 1, 'invalid-catalog');
  add('catalog prototype', x => Object.setPrototypeOf(x.catalog, new Date()), 'invalid-catalog');
  add('catalog hidden', x => Object.defineProperty(x.catalog, 'hidden', { value: 1 }), 'invalid-catalog');
  add('catalog depth', x => { let y = x.catalog; for (let i=0; i<35; i++) y = y.deep = {}; }, 'invalid-catalog');
  let getterCalls = 0;
  add('catalog getter', x => Object.defineProperty(x.catalog, 'secret', { enumerable: true, get() { getterCalls++; return 'SECRET-DATA'; } }), 'invalid-catalog');
  add('context getter', x => Object.defineProperty(x.context, 'build', { enumerable: true, get() { getterCalls++; return 'SECRET-DATA'; } }), 'invalid-context');
  result.codes = [];
  for (const [name, input, expected] of cases) result.codes.push({ name, expected, got: await attempt(() => createScenarioRun(input)) });
  result.getterCalls = getterCalls;
  const nullProto = Object.assign(Object.create(null), { build: 'boundary' });
  result.nullPrototype = (await attempt(() => createScenarioRun({ ...args, context: nullProto }))) === 'none';
  result.limit = (await attempt(() => createScenarioRun({ ...args, context: {build: 'x'.repeat(256)} }))) === 'none';
  const oversized = structuredClone(args);
  oversized.catalog.steps[0].actions = Array(1000).fill('synthetic');
  oversized.catalog.scenarios[0].steps = Array(100).fill('one');
  result.tooManyEvents = await attempt(() => createScenarioRun(oversized));
  const oversizedBytes = structuredClone(args);
  oversizedBytes.catalog.steps[0].actions = Array(5).fill('x'.repeat(16000));
  oversizedBytes.catalog.scenarios[0].steps = Array(850).fill('one');
  result.tooManyBytes = await attempt(() => createScenarioRun(oversizedBytes));
} else if (mode === 'capture') {
  const run = createScenarioRun(args);
  args.catalog.steps[0].actions[0] = 'mutated'; args.context.build = 'mutated';
  let api;
  const step = await run.step('one', async context => {
    api = context;
    await context.action('first', () => { calls.push('first'); return 10; });
    await context.action('second', () => { calls.push('second'); });
    await context.expect('verified', () => { check(calls); calls.push('expect'); });
  });
  result.finish = run.finish(); result.calls = calls;
  result.stepFrozen = Object.isFrozen(step) && Object.isFrozen(step.actions) && Object.isFrozen(step.actions[0]);
  result.apiFrozen = Object.isFrozen(api) && Object.isFrozen(run);
  result.finalFrozen = Object.isFrozen(result.finish) && Object.isFrozen(result.finish.context) && Object.isFrozen(result.finish.events[0]);
  result.sameFinish = run.finish() === result.finish;
  result.afterStep = await attempt(() => run.step('one', () => calls.push('late-step')));
  result.afterAction = await attempt(() => api.action('first', () => calls.push('late-action')));
} else if (mode === 'guards') {
  result.checks = [];
  async function check(name, operation, expected) {
    const run = createScenarioRun(args); let invokeCount = 0;
    const callback = () => { invokeCount++; throw new Error('SECRET-DATA'); };
    const code = await operation(run, callback);
    const report = run.finish();
    result.checks.push({ name, expected, code, invokeCount, failures: report.failures, status: report.status });
  }
  await check('step invalid', async (r, cb) => attempt(() => r.step('bad.id', cb)), 'step-id-invalid');
  await check('step order', async (r, cb) => attempt(() => r.step('other', cb)), 'step-order');
  await check('step callback', async r => attempt(() => r.step('one', null)), 'step-callback-required');
  await check('action callback', async r => attempt(() => r.step('one', c => c.action('first', null))), 'operation-callback-required');
  await check('action order', async (r, cb) => attempt(() => r.step('one', c => c.action('second', cb))), 'action-order');
  await check('early expectation', async (r, cb) => attempt(() => r.step('one', c => c.expect('verified', cb))), 'expectation-before-actions');
  await check('unknown expectation', async (r, cb) => attempt(() => r.step('one', async c => { await c.action('first', () => {}); await c.action('second', () => {}); await c.expect('missing', cb); })), 'expectation-unknown');
  await check('repeat expectation', async (r, cb) => attempt(() => r.step('one', async c => { await c.action('first', () => {}); await c.action('second', () => {}); await c.expect('verified', () => {}); await c.expect('verified', cb); })), 'expectation-repeated');
  await check('nested action', async (r, cb) => attempt(() => r.step('one', c => c.action('first', () => c.action('second', cb)))), 'operation-nested');
  await check('concurrent operation', async (r, cb) => { let code; await attempt(() => r.step('one', async c => { let release; const gate = new Promise(resolve => release = resolve); const first = c.action('first', () => gate); code = await attempt(() => c.action('second', cb)); release(); await first; })); return code; }, 'operation-concurrent');
  await check('outside async scope', async (r, cb) => { let api, release; const gate = new Promise(resolve => release = resolve); const working = r.step('one', async c => { api = c; await gate; }); const code = await attempt(() => api.action('first', cb)); release(); await attempt(() => working); return code; }, 'operation-outside-step');
  await check('concurrent step', async (r, cb) => { let release; const gate = new Promise(resolve => release = resolve); const working = r.step('one', () => gate); const code = await attempt(() => r.step('one', cb)); release(); await attempt(() => working); return code; }, 'step-concurrent');
  await check('nested step', async (r, cb) => attempt(() => r.step('one', () => r.step('one', cb))), 'step-nested');
  await check('escaped operation', async (r, cb) => { let api; await r.step('one', c => { api = c; }); return attempt(() => api.action('first', cb)); }, 'operation-outside-step');
  const duplicate = createScenarioRun(args);
  await attempt(() => duplicate.step('wrong', () => {})); await attempt(() => duplicate.step('wrong', () => {}));
  result.duplicate = duplicate.finish().failures;
  const callbacks = createScenarioRun(args);
  await attempt(() => callbacks.step('one', async c => { try { await c.action('first', () => { throw new Error('SECRET-DATA'); }); } catch {} }));
  result.callbackFailure = callbacks.finish();
}
console.log(JSON.stringify(result));
`);
  ok('init', '--app-json', JSON.stringify([process.execPath, 'app.mjs']));
  return mode => JSON.parse(ok('app', '--', mode));
}

test('runtime initialization rejects unsafe values without invoking accessors or disclosing data', t => {
  const app = fixture(t), result = app('initialization');
  for (const entry of result.codes) assert.equal(entry.got, entry.expected, entry.name);
  assert.equal(result.getterCalls, 0);
  assert.equal(result.nullPrototype, true); assert.equal(result.limit, true);
  assert.equal(result.tooManyEvents, 'run-too-large');
  assert.equal(result.tooManyBytes, 'run-too-large');
  assert.equal(JSON.stringify(result).includes('SECRET-DATA'), false);
});

test('runtime pins inputs, freezes reports, orders callbacks and rejects work after finish', t => {
  const app = fixture(t), result = app('capture');
  assert.deepEqual(result.calls, ['first', 'second', 'expect']);
  assert.equal(result.finish.status, 'passed'); assert.equal(result.finish.context.build, 'v1');
  assert.equal(result.finish.steps[0].actions[0].label, 'first');
  assert.deepEqual(result.finish.events.map(e => e.sequence), [1, 2, 3]);
  assert.ok(result.stepFrozen && result.apiFrozen && result.finalFrozen && result.sameFinish);
  assert.equal(result.afterStep, 'run-finished'); assert.equal(result.afterAction, 'run-finished');
});

test('runtime protocol guards reject before callbacks and record failures without leaking exceptions', t => {
  const app = fixture(t), result = app('guards');
  for (const entry of result.checks) {
    assert.equal(entry.code, entry.expected, entry.name);
    assert.equal(entry.invokeCount, 0, entry.name);
    assert.equal(entry.status, 'failed', entry.name);
    assert.ok(entry.failures.some(f => f.code === entry.expected), entry.name);
  }
  assert.deepEqual(result.duplicate, [{ code: 'step-order', count: 2 }]);
  assert.ok(result.callbackFailure.failures.some(f => f.code === 'action-callback-failed'));
  assert.equal(JSON.stringify(result).includes('SECRET-DATA'), false);
});
