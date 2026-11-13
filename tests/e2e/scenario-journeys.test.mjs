import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Journeys drive the public CLI. Only the synthetic application imports the optional runtime adapter.
const cli = fileURLToPath(new URL('../../bin/tracer.mjs', import.meta.url));
const runtime = new URL('../../src/scenario-runtime.mjs', import.meta.url).href;
const map = 'docs/testing/code-e2e-links.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function project(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tracer-step-journey-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const env = { ...process.env, TRACER_NO_UPDATE: '1', HOME: root, CODEX_HOME: '', NODE_OPTIONS: '' };
  const put = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'); };
  const read = path => readFileSync(join(root, path), 'utf8');
  const run = (...args) => spawnSync(process.execPath, [cli, '--root', root, ...args], { encoding: 'utf8', env, timeout: 15000 });
  const ok = (...args) => { const result = run(...args); assert.equal(result.status, 0, result.stderr); return result; };
  const json = (...args) => JSON.parse(ok(...args).stdout);
  put('model.mjs', "import { readFileSync, writeFileSync } from 'node:fs';\nconst action = process.argv[2];\nif (action === 'create') writeFileSync('state.json', JSON.stringify({title:'Synthetic'}));\nif (action === 'inspect') console.log(readFileSync('state.json', 'utf8'));\n");
  put('assertions.mjs', "import assert from 'node:assert/strict';\nexport function checkTitle(state) { assert.equal(state.title, 'Synthetic'); }\nexport function checkReopened(reopened) { assert.equal(reopened.title, 'Synthetic'); }\n");
  const step = (id, action, line) => ({ id, title: id === 'create' ? 'Create project' : 'Inspect project', preconditions: [id === 'create' ? 'Isolated empty fixture directory' : 'The create step has completed'], actions: [`app ${action}`], expectations: [{ id: 'title', description: 'The project title is Synthetic', witness: { path: 'assertions.mjs', start: line, end: line } }], mappings: [{ source: { path: 'model.mjs', start: action === 'create' ? 3 : 4, end: action === 'create' ? 3 : 4 }, expectation: 'title', why: 'The public fixture command preserves the exact project title.' }] });
  const catalog = { version: 1, kind: 'scenario-step-catalog', steps: [step('create', 'create', 2), step('inspect', 'inspect', 3)], scenarios: [{ id: 'roundtrip', title: 'Create and inspect twice', steps: ['create', 'inspect', 'inspect'] }, { id: 'simple', title: 'Create and inspect', steps: ['create', 'inspect'] }] };
  put('draft.json', catalog);
  const prepare = () => { const pinned = json('scenario', 'prepare', '--file', 'draft.json', '--json'); put('catalog.json', pinned); return pinned; };
  const link = (extra = []) => json('scenario', 'link', '--file', 'catalog.json', '--reviewed', '--expect-catalog-sha256', hash(read('catalog.json')), '--expect-map-sha256', existsSync(join(root, map)) ? hash(read(map)) : hash(''), ...extra, '--json');
  return { root, env, put, read, run, ok, json, catalog, prepare, link };
}

test('scenario lifecycle: reuse steps, preserve ordered prefixes, review once, atomically link and detect stale pins', t => {
  const p = project(t); p.ok('init');
  const before = p.read(map), pinned = p.prepare();
  assert.equal(p.read(map), before); assert.equal(existsSync(join(p.root, 'state.json')), false);
  assert.match(pinned.steps[0].mappings[0].source.sha256, /^[a-f0-9]{64}$/);
  assert.match(pinned.steps[1].expectations[0].witness.sha256, /^[a-f0-9]{64}$/);
  p.ok('scenario', 'check', '--file', 'catalog.json');
  const report = p.json('scenario', 'report', '--file', 'catalog.json', '--scenario', 'roundtrip');
  assert.equal(report.catalogSha256, hash(p.read('catalog.json')));
  assert.match(report.notice, /not|never/i);
  assert.equal(report.scenarios[0].occurrences.length, 3);
  assert.equal(report.steps.length, 2);
  assert.equal(report.scenarios[0].occurrences[1].actionStart, 2);
  assert.equal(report.scenarios[0].occurrences[2].actionEnd, 3);
  assert.equal(Object.hasOwn(report.scenarios[0].occurrences[0], 'mappings'), false);
  const packet = p.json('scenario', 'packet', '--file', 'catalog.json');
  assert.equal(packet.version, 1); assert.equal(packet.links.length, 4);
  assert.deepEqual(packet.links.map(l => l.actions).sort((a,b) => a.length-b.length), [['app create', 'app inspect'], ['app create', 'app inspect'], ['app create', 'app inspect', 'app inspect'], ['app create', 'app inspect', 'app inspect']]);
  assert.equal(p.json('scenario', 'packet', '--file', 'catalog.json', '--scenario', 'simple').links.length, 2);
  const custom = JSON.parse(before); custom.note = 'preserved metadata'; p.put(map, custom);
  const applied = p.link(); assert.equal(applied.changed, true);
  const linked = p.read(map); assert.equal(JSON.parse(linked).note, 'preserved metadata');
  assert.equal(JSON.parse(linked).links.length, 4);
  assert.equal(p.link().changed, false); assert.equal(p.read(map), linked);
  p.ok('check');
  assert.notEqual(p.run('scenario', 'link', '--file', 'catalog.json', '--expect-catalog-sha256', hash(p.read('catalog.json')), '--expect-map-sha256', hash(linked)).status, 0);
  assert.notEqual(p.run('scenario', 'link', '--file', 'catalog.json', '--reviewed', '--expect-catalog-sha256', '0'.repeat(64), '--expect-map-sha256', hash(linked)).status, 0);
  assert.notEqual(p.run('scenario', 'link', '--file', 'catalog.json', '--reviewed', '--expect-catalog-sha256', hash(p.read('catalog.json')), '--expect-map-sha256', hash(before)).status, 0);
  assert.equal(p.read(map), linked);
  p.put('model.mjs', p.read('model.mjs').replace("title:'Synthetic'", "title:'Changed'"));
  for (const mode of ['prepare', 'check', 'report', 'packet']) assert.notEqual(p.run('scenario', mode, '--file', 'catalog.json').status, 0);
  assert.throws(() => p.link()); assert.equal(p.read(map), linked);
  assert.equal(existsSync(join(p.root, 'state.json')), false, 'catalog operations never execute described actions');
});

test('scenario validation: reject malformed catalogs, unsafe paths, missing witnesses and conflicting reviewed links', t => {
  const p = project(t), pinned = p.prepare(); p.ok('init'); const original = p.read(map);
  const bad = [
    c => { c.steps[0].actions = []; },
    c => { c.steps[0].extra = 'unknown'; },
    c => { c.steps[0].expectations = []; },
    c => { c.steps[1].id = 'create'; },
    c => { c.scenarios[0].steps = ['missing']; },
    c => { c.steps[0].mappings[0].expectation = 'missing'; },
    c => { c.steps[0].expectations[0].witness.path = '../outside'; },
    c => { c.steps[0].expectations[0].witness.start = 99; },
    c => { delete c.steps[0].mappings[0].source.sha256; },
    c => { c.steps[0].mappings[0].source.sha256 = '0'.repeat(64); },
  ];
  for (const change of bad) {
    const data = structuredClone(pinned); change(data); p.put('bad.json', data);
    assert.notEqual(p.run('scenario', 'check', '--file', 'bad.json').status, 0);
    assert.equal(p.read(map), original);
  }
  symlinkSync(join(p.root, 'catalog.json'), join(p.root, 'linked.json'));
  assert.notEqual(p.run('scenario', 'check', '--file', 'linked.json').status, 0);
  assert.notEqual(p.run('scenario', 'check', '--file', map).status, 0);
  assert.notEqual(p.run('scenario', 'report', '--file', 'catalog.json', '--scenario', 'unknown').status, 0);
  assert.notEqual(p.run('scenario', 'check', '--file', 'catalog.json', '--file', 'catalog.json').status, 0);
  p.link(); const before = p.read(map);
  const changed = structuredClone(pinned); changed.steps[0].mappings[0].why = 'Different reviewed rationale.'; p.put('catalog.json', changed);
  assert.throws(() => p.link()); assert.equal(p.read(map), before);
  p.put(`${map}.lock`, 'owned writer\n'); assert.throws(() => p.link()); assert.equal(p.read(map), before);
});

test('runtime adapter journey: explicitly capture actions and assertions through the configured application, never infer passes', t => {
  const p = project(t); p.prepare();
  p.put('app.mjs', `import { createScenarioRun } from ${JSON.stringify(runtime)};
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { checkTitle, checkReopened } from './assertions.mjs';
const mode = process.argv[2];
const catalog = JSON.parse(readFileSync('catalog.json', 'utf8'));
const run = createScenarioRun({catalog, scenarioId:'roundtrip', runId:'synthetic-run', context:{build:'fixture-v1',platform:process.platform,inputRoute:'CLI'}});
let leaked;
try {
  if (mode === 'pending') {
    const working = run.step('create', async ctx => { await ctx.action('app create', () => new Promise(resolve => setTimeout(resolve, 10))); });
    try { run.finish(); } catch {}
    try { await working; } catch {}
  }
  else if (mode === 'wrong-order') await run.step('inspect', async () => {});
  else for (const id of ['create','inspect','inspect']) {
    await run.step(id, async ctx => {
      leaked = ctx;
      if (mode === 'early-assertion') { await ctx.expect('title', () => { throw new Error('CALLBACK SHOULD NOT RUN'); }); return; }
      if (mode === 'nested') { await ctx.action('app '+id, async () => { await ctx.expect('title', () => true); }); return; }
      if (mode === 'concurrent') {
        const first = ctx.action('app '+id, () => new Promise(resolve => setTimeout(resolve, 10)));
        try { await ctx.action('app '+id, () => true); } catch {}
        await first; return;
      }
      if (mode === 'unawaited') { ctx.action('app '+id, () => new Promise(resolve => setTimeout(resolve, 10))); return; }
      let state;
      await ctx.action('app '+id, async () => {
        execFileSync(process.execPath, ['model.mjs', id]);
        state = JSON.parse(readFileSync('state.json','utf8'));
      });
      if (mode === 'missing-assertion') return;
      if (mode === 'false') { await ctx.expect('title', () => false); return; }
      if (mode === 'swallowed') { try { await ctx.expect('title', () => { throw new Error('SECRET MUST NOT APPEAR'); }); } catch {} return; }
      if (mode === 'unknown-expectation') { await ctx.expect('wrong', () => true); return; }
      await ctx.expect('title', () => id === 'create' ? checkTitle(state) : checkReopened(state));
      if (mode === 'duplicate-expectation') await ctx.expect('title', () => true);
    });
  }
} catch {}
let escapedRejected = true;
if (mode === 'leaked') { try { await leaked.expect('title', () => true); escapedRejected = false; } catch {} }
const result = run.finish();
let frozen = false;
try { result.steps[0].status = 'invented'; } catch { frozen = true; }
console.log(JSON.stringify({result, frozen, escapedRejected, repeatedFinish:JSON.stringify(run.finish()) === JSON.stringify(result)}));
process.exitCode = result.status === 'passed' ? 0 : 1;
`);
  p.ok('init', '--app-json', JSON.stringify([process.execPath, 'app.mjs']));
  const passed = p.json('app', '--', 'success');
  assert.equal(passed.result.status, 'passed'); assert.equal(passed.result.evidence, 'adapter-reported');
  assert.equal(passed.frozen, true); assert.equal(passed.escapedRejected, true); assert.equal(passed.repeatedFinish, true);
  assert.equal(passed.result.steps.length, 3);
  assert.equal(passed.result.steps.flatMap(s => s.actions).filter(a => a.status === 'passed').length, 3);
  assert.equal(passed.result.steps.flatMap(s => s.expectations).filter(a => a.status === 'passed').length, 3);
  for (const mode of ['missing-assertion', 'false', 'swallowed', 'wrong-order', 'leaked', 'pending', 'early-assertion', 'nested', 'concurrent', 'unawaited', 'unknown-expectation', 'duplicate-expectation']) {
    const result = p.run('app', '--', mode); assert.equal(result.status, 1, result.stderr);
    const parsed = JSON.parse(result.stdout).result;
    assert.notEqual(parsed.status, 'passed');
    if (!['leaked', 'duplicate-expectation'].includes(mode)) assert.ok(parsed.steps.flatMap(s => s.expectations).some(e => e.status !== 'passed'));
    assert.equal(result.stdout.includes('SECRET MUST NOT APPEAR'), false);
  }
  assert.equal(JSON.parse(p.read(map)).links.length, 0, 'captured application results never create mappings');
});
