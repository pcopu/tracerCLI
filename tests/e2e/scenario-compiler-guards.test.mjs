import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only fixture construction happens here; every compiler operation uses the public CLI.
const cli = fileURLToPath(new URL('../../bin/tracer.mjs', import.meta.url));
const mapPath = 'docs/testing/code-e2e-links.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tracer-compiler-guards-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const home = join(root, 'home'); mkdirSync(home);
  const env = { ...process.env, TRACER_NO_UPDATE: '1', HOME: home, USERPROFILE: home, CODEX_HOME: '', NODE_OPTIONS: '' };
  const put = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)); };
  const read = path => readFileSync(join(root, path), 'utf8');
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, '--root', root, ...args], { cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
    assert.ifError(result.error); assert.equal(result.signal, null); return result;
  };
  const ok = (...args) => { const result = run(...args); assert.equal(result.status, 0, result.stderr); return result; };
  const json = (...args) => JSON.parse(ok(...args).stdout);
  put('model.mjs', 'export const title = "Synthetic";\nexport const reopened = title;\n');
  put('assertions.mjs', 'assert.equal(title, "Synthetic");\nassert.equal(reopened, "Synthetic");\n');
  put('review.mjs', '// Fixture-only retired branch candidate.\nexport const legacy = "retained";\n');
  const catalog = { version: 1, kind: 'scenario-step-catalog', steps: [{ id: 'create', title: 'Create fixture', preconditions: ['Synthetic isolated repository'], actions: ['app create'], expectations: [{ id: 'title', description: 'The title is Synthetic', witness: { path: 'assertions.mjs', start: 1, end: 1 } }], mappings: [{ source: { path: 'model.mjs', start: 1, end: 1 }, expectation: 'title', why: 'Inspect the exact title assertion.' }] }], scenarios: [{ id: 'roundtrip', title: 'Create fixture', steps: ['create'] }] };
  put('draft.json', catalog); ok('init');
  const pinned = json('scenario', 'prepare', '--file', 'draft.json', '--json'); put('catalog.json', pinned);
  const link = () => run('scenario', 'link', '--file', 'catalog.json', '--reviewed', '--expect-catalog-sha256', hash(read('catalog.json')), '--expect-map-sha256', hash(read(mapPath)), '--json');
  return { root, put, read, run, ok, json, catalog, pinned, link };
}

test('scenario schema boundaries: reject malformed identities, ranges and declarations without mutation, then recover', t => {
  const f = fixture(t), before = f.read(mapPath);
  const variants = [
    [c => { c.version = 2; }, /version 1/],
    [c => { c.kind = 'not-scenarios'; }, /kind scenario-step-catalog/],
    [c => { c.extra = true; }, /Invalid scenario catalog/],
    [c => { c.steps = []; }, /Catalog steps/],
    [c => { c.scenarios = []; }, /Catalog scenarios/],
    [c => { c.steps[0].title = ' padded '; }, /Step title/],
    [c => { c.steps[0].id = '-bad'; }, /step id/],
    [c => { c.steps[0].preconditions = []; }, /preconditions/],
    [c => { c.steps[0].preconditions = ['bad\nline']; }, /Precondition/],
    [c => { c.steps[0].actions = ['x'.repeat(16385)]; }, /Action/],
    [c => { c.steps[0].expectations.push(structuredClone(c.steps[0].expectations[0])); }, /Duplicate expectation/],
    [c => { c.steps[0].expectations[0].witness.path = '.git/config'; }, /witness path/],
    [c => { c.steps[0].expectations[0].witness.start = 0; }, /line range/],
    [c => { c.steps[0].expectations[0].witness.end = 0; }, /line range/],
    [c => { c.steps[0].expectations[0].witness.sha256 = 'A'.repeat(64); }, /lowercase SHA/],
    [c => { c.steps[0].mappings[0].why = ''; }, /Mapping explanation/],
    [c => { c.steps[0].mappings[0].expectation = 'unknown'; }, /Unknown expectation/],
    [c => { c.scenarios.push(structuredClone(c.scenarios[0])); }, /Duplicate scenario/],
    [c => { c.scenarios[0].steps = ['unknown']; }, /Unknown step/],
    [c => { c.scenarios[0].steps = ['bad/id']; }, /step reference/],
    [c => { c.scenarios[0].steps = []; }, /Scenario roundtrip steps/],
  ];
  for (const [change, error] of variants) {
    const data = structuredClone(f.pinned); change(data); f.put('case.json', data);
    const result = f.run('scenario', 'check', '--file', 'case.json', '--json');
    assert.equal(result.status, 1); assert.match(result.stderr, error); assert.equal(result.stdout, '');
    assert.equal(f.read(mapPath), before); assert.equal(existsSync(join(f.root, `${mapPath}.lock`)), false);
  }
  const invalidSelector = f.run('scenario', 'report', '--file', 'catalog.json', '--scenario', 'bad/id');
  assert.equal(invalidSelector.status, 1); assert.match(invalidSelector.stderr, /scenario selector/);
  assert.equal(f.json('scenario', 'check', '--file', 'catalog.json', '--json').valid, true);
  assert.equal(f.read(mapPath), before);
});

test('scenario input safety: refuse non-files, redirections, invalid bytes and oversized catalogs, preserving state', t => {
  const f = fixture(t), before = f.read(mapPath);
  f.put('invalid.json', Buffer.from([0xff, 0xfe])); f.put('nul.json', '{"x":"\0"}'); f.put('broken.json', '{broken');
  f.put('oversized.json', Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
  mkdirSync(join(f.root, 'directory.json')); symlinkSync(join(f.root, 'catalog.json'), join(f.root, 'alias.json'));
  mkdirSync(join(f.root, 'catalogs')); f.put('catalogs/current.json', f.pinned); symlinkSync(join(f.root, 'catalogs'), join(f.root, 'aliased'));
  for (const path of ['invalid.json', 'nul.json', 'broken.json', 'oversized.json', 'directory.json', 'alias.json', 'aliased/current.json', '.git/config', `${mapPath}.lock`]) {
    const result = f.run('scenario', 'check', '--file', path, '--json');
    assert.equal(result.status, 1, path); assert.equal(result.stdout, ''); assert.match(result.stderr, /tracer:/);
    assert.equal(f.read(mapPath), before); assert.equal(existsSync(join(f.root, `${mapPath}.lock`)), false);
  }
  assert.equal(f.json('scenario', 'check', '--file', 'catalog.json', '--json').valid, true);
  assert.equal(f.read(mapPath), before);
});

test('scenario expansion budgets: bound declarations, occurrences, action prefixes, mapping sequences and output bytes', { timeout: 120000 }, t => {
  const f = fixture(t), before = f.read(mapPath);
  const variants = [
    [c => { const step = c.steps[0]; step.preconditions = Array(1000).fill('condition'); c.steps = Array.from({ length: 21 }, (_, i) => ({ ...structuredClone(step), id: `step${i}` })); c.scenarios[0].steps = ['step0']; }, /20000 declared/],
    [c => { c.scenarios = Array.from({ length: 11 }, (_, i) => ({ id: `scenario${i}`, title: 'Many occurrences', steps: Array(1000).fill('create') })); }, /10000 step occurrences/],
    [c => { c.steps[0].actions = Array(101).fill('app inspect'); c.steps[0].mappings = []; c.scenarios[0].steps = Array(100).fill('create'); }, /10000 actions/],
    [c => { c.steps[0].actions = Array(50).fill('app inspect'); c.steps[0].mappings = []; c.scenarios[0].steps = Array(200).fill('create'); }, /action-prefix limit/],
    [c => { c.steps[0].actions = Array(100).fill('app inspect'); c.steps[0].mappings = Array.from({ length: 2 }, () => structuredClone(c.steps[0].mappings[0])); c.scenarios[0].steps = Array(100).fill('create'); }, /action-sequence limit/],
    [c => { c.steps[0].mappings = Array.from({ length: 1000 }, () => structuredClone(c.steps[0].mappings[0])); c.scenarios = Array.from({ length: 101 }, (_, i) => ({ id: `scenario${i}`, title: 'Mapping budget', steps: ['create'] })); }, /100000 mappings/],
    [c => { c.steps[0].actions = Array(300).fill('x'.repeat(16000)); c.steps[0].mappings = []; c.scenarios[0].steps = Array(14).fill('create'); }, /64 MiB/],
  ];
  for (const [change, error] of variants) {
    const data = structuredClone(f.catalog); change(data); f.put('case.json', data);
    const result = f.run('scenario', 'prepare', '--file', 'case.json', '--json');
    assert.equal(result.status, 1); assert.match(result.stderr, error); assert.equal(result.stdout, '');
    assert.equal(f.read(mapPath), before); assert.equal(existsSync(join(f.root, `${mapPath}.lock`)), false);
  }
  assert.equal(f.json('scenario', 'check', '--file', 'catalog.json', '--json').valid, true);
});

test('scenario batch integrity: preserve existing witnesses and declarations, reject stale and colliding links, then recover', t => {
  const f = fixture(t);
  f.ok('comment', 'review.mjs:1');
  f.ok('dead-code', 'review.mjs:2', '--why', 'Retained fixture candidate', '--evidence', 'Synthetic caller review only, not a proof of unreachability');
  f.ok('link', 'model.mjs:2', '--action', 'app inspect', '--step', 'assertions.mjs:2', '--why', 'Existing reopened assertion.');
  const prior = JSON.parse(f.read(mapPath)); prior.note = 'Keep metadata'; f.put(mapPath, prior);
  const applied = f.link(); assert.equal(applied.status, 0, applied.stderr); assert.equal(JSON.parse(applied.stdout).added, 1);
  const after = JSON.parse(f.read(mapPath)); assert.equal(after.note, prior.note);
  assert.deepEqual(after.commentExclusions, prior.commentExclusions); assert.deepEqual(after.deadCode, prior.deadCode);
  assert.deepEqual(after.links.slice(0, prior.links.length), prior.links);
  const bytes = f.read(mapPath); assert.equal(JSON.parse(f.link().stdout).changed, false); assert.equal(f.read(mapPath), bytes);
  const packet = f.json('scenario', 'packet', '--file', 'catalog.json');
  const candidate = packet.links[0];
  for (const kind of ['stale-witness', 'conflicting-identity', 'id-collision']) {
    const data = JSON.parse(bytes);
    if (kind === 'stale-witness') data.links[0].step.sha256 = '0'.repeat(64);
    if (kind === 'conflicting-identity') data.links.push({ ...data.links[0], id: 'legacy-copy', why: 'Different explanation' });
    if (kind === 'id-collision') { data.links = data.links.filter(link => link.id !== candidate.id); data.links[0].id = candidate.id; }
    f.put(mapPath, data); const unchanged = f.read(mapPath), rejected = f.link();
    assert.equal(rejected.status, 1, kind); assert.match(rejected.stderr, /invalid or stale|conflicting links|id collision/);
    assert.equal(f.read(mapPath), unchanged); assert.equal(existsSync(join(f.root, `${mapPath}.lock`)), false);
  }
  f.put(mapPath, bytes); f.ok('check'); assert.equal(JSON.parse(f.link().stdout).changed, false);
  assert.equal(f.read(mapPath), bytes);
});
