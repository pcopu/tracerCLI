import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// These are black-box journeys through Tracer's shipped CLI, not its JavaScript API.
// Git and filesystem operations prepare synthetic projects and inspect results only.
const cli = fileURLToPath(new URL('../../bin/tracer.mjs', import.meta.url));
const mapPath = 'docs/testing/code-e2e-links.json';
const cartSource = 'def total(items):\n    return sum(items)\n\n# end\n';
const cartStep = 'open cart\nadd item\nassert total\n';
const cartActions = ['cart add --price 4', 'cart total'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function tree(root, prefix = '') {
  const entries = {};
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    const absolute = join(root, path), info = lstatSync(absolute);
    if (info.isSymbolicLink()) entries[path] = { symlink: readlinkSync(absolute) };
    else if (info.isDirectory()) { entries[path] = { directory: true }; Object.assign(entries, tree(root, path)); }
    else entries[path] = { bytes: readFileSync(absolute).toString('base64') };
  }
  return entries;
}

function project(t, files = {}) {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'tracer-mapping-journey-')));
  const root = join(sandbox, 'repo'), home = join(sandbox, 'home');
  mkdirSync(root); mkdirSync(home);
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), TRACER_NO_UPDATE: '1' };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  const put = (path, bytes) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  };
  for (const [path, bytes] of Object.entries({ 'src/cart.py': cartSource, 'tests/cart.spec': cartStep, ...files })) put(path, bytes);
  const launch = (args, { cwd = root, explicitRoot = true } = {}) => {
    const argv = [cli, ...(explicitRoot ? ['--root', root] : []), ...args];
    const result = spawnSync(process.execPath, argv, { cwd, env, encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, `CLI unexpectedly terminated: ${JSON.stringify(args)}\n${result.stderr}`);
    return { ...result, argv };
  };
  const expect = (args, status = 0, options) => {
    const result = launch(args, options);
    assert.equal(result.status, status, `argv: ${JSON.stringify(result.argv)}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    return result;
  };
  const ok = (...args) => expect(args).stdout;
  const json = (...args) => JSON.parse(ok(...args, '--json'));
  const fail = (args, pattern = /tracer:/) => {
    const result = expect(args, 1);
    assert.match(result.stderr, pattern, JSON.stringify(args));
    return result;
  };
  const check = (status = 0, ...args) => JSON.parse(expect(['check', ...args, '--json'], status).stdout);
  const link = ({ source = 'src/cart.py:1-2', actions = cartActions, step = 'tests/cart.spec:2-3', why = 'Add an item, then assert the total.' } = {}) => [
    'link', source, ...actions.flatMap(action => ['--action', action]), ...(step ? ['--step', step] : []), '--why', why,
  ];
  const map = () => JSON.parse(readFileSync(join(root, mapPath), 'utf8'));
  const bytes = () => readFileSync(join(root, mapPath));
  const editMap = edit => { const data = map(); edit(data); put(mapPath, `${JSON.stringify(data)}\n`); };
  return { sandbox, root, home, git, put, launch, expect, ok, json, fail, check, link, map, bytes, editMap };
}

test('mapping journey: review links from source to actions and witnesses, then explicitly repair stale evidence', t => {
  const f = project(t), untouched = tree(f.root);
  const empty = f.json('report');
  assert.deepEqual(empty.totals, { files: 1, lines: 3, linked: 0, withStep: 0, unlinked: 3, belowMinimum: 3, physicalLines: 4, blankLines: 1, commentLines: 0 });
  assert.deepEqual(f.json('config'), { minimumTraces: 1 });
  assert.equal(f.check().total, 0);
  assert.deepEqual(tree(f.root), untouched, 'read-only first use must not create a sidecar or directories');

  assert.match(f.ok(...f.link()), /^Linked:/);
  const first = f.map().links[0];
  assert.equal(f.map().version, 1);
  assert.equal(first.source.sha256, sha256('def total(items):\n    return sum(items)\n'));
  assert.equal(first.step.sha256, sha256('add item\nassert total\n'));
  assert.deepEqual(first.actions, cartActions);
  const forward = f.json('report', '--source', 'src/cart.py:2');
  assert.equal(forward.totals.linked, 1);
  assert.equal(forward.files[0].links[0].id, first.id);
  assert.deepEqual(forward.files[0].links[0].step, first.step);
  const reverse = f.json('report', '--step', 'tests/cart.spec:3');
  assert.equal(reverse.files[0].path, 'src/cart.py');
  assert.equal(reverse.files[0].links[0].source.sha256, first.source.sha256);
  assert.equal(f.json('report', '--step', 'tests/cart.spec').totals.linked, 2);
  assert.equal(f.json('report', '--action', 'cart total').totals.linked, 2);
  const human = f.ok('report', '--source', 'src/cart.py:1-2'); assert.match(human, /src\/cart\.py:1-2/); assert.match(human, /tests\/cart\.spec:2-3/); assert.match(human, /Add an item, then assert the total\./);
  assert.equal(f.check().valid, 1);

  const original = f.bytes();
  assert.match(f.ok(...f.link()), /^Already linked:/);
  assert.deepEqual(f.bytes(), original, 'an identical relink must preserve original bytes');
  // A v1 map from the prototype can have its own id and object-key order.
  f.editMap(data => { const row = data.links[0]; data.links[0] = {
    why: row.why, actions: row.actions, source: row.source, step: row.step, id: 'legacy-seed',
  }; });
  const legacy = f.bytes();
  assert.match(f.ok(...f.link()), /Already linked: legacy-seed/);
  assert.deepEqual(f.bytes(), legacy);
  assert.equal(f.json('config').minimumTraces, 1);

  f.put('src/cart.py', cartSource.replace('# end', '# changed outside the linked snippet'));
  assert.equal(f.check().valid, 1, 'unlinked surrounding changes do not invalidate the selected snippet');
  f.fail(f.link({ why: 'A new rationale.' }), /different content/);
  assert.deepEqual(f.bytes(), legacy);
  f.ok('unlink', 'legacy-seed');
  f.ok(...f.link({ why: 'A new rationale.' }));
  assert.equal(f.map().links[0].why, 'A new rationale.');

  const beforeSourceChange = f.bytes();
  f.put('src/cart.py', cartSource.replace('sum(items)', '0'));
  assert.match(f.check(1).invalid[0].errors.join('; '), /source snippet is stale/);
  assert.equal(f.json('report').totals.linked, 0);
  f.fail(f.link({ why: 'A new rationale.' }), /never silently refreshed/);
  assert.deepEqual(f.bytes(), beforeSourceChange, 'stale relink must not refresh hashes');
  f.ok('unlink', f.map().links[0].id);
  f.ok(...f.link({ why: 'Reviewed the changed implementation.' }));
  assert.equal(f.check().valid, 1);

  const beforeWitnessChange = f.bytes();
  f.put('tests/cart.spec', cartStep.replace('assert total', 'assert zero'));
  assert.match(f.check(1).invalid[0].errors.join('; '), /step snippet is stale/);
  assert.equal(f.json('report').totals.linked, 0);
  f.fail(f.link({ why: 'Reviewed the changed implementation.' }), /never silently refreshed/);
  assert.deepEqual(f.bytes(), beforeWitnessChange);
  f.put('tests/cart.spec', 'short\n');
  assert.match(f.check(1).invalid[0].errors.join('; '), /Invalid range/);
  rmSync(join(f.root, 'src/cart.py'));
  assert.match(f.check(1).invalid[0].errors.join('; '), /source inventory/);
  f.ok('unlink', f.map().links[0].id);
  assert.equal(f.check().total, 0);
  assert.equal(readFileSync(join(f.root, 'tests/cart.spec'), 'utf8'), 'short\n', 'unlink must not edit the witness');
  assert.equal(existsSync(join(f.root, 'src/cart.py')), false, 'unlink must not recreate source');
});

test('mapping journey: exact ordered sequences deduplicate per line and enforce only requested thresholds', t => {
  const f = project(t);
  const actions = ['echo a,b:1; touch NEVER', 'key', 'key'];
  f.ok(...f.link({ actions }));
  f.ok(...f.link({ source: 'src/cart.py:2-3', actions, step: 'tests/cart.spec:1-2' }));
  f.editMap(data => data.links.push({ ...data.links.find(link => link.source.start === 1), id: 'copied-row' }));
  assert.deepEqual(f.map().links[0].actions, actions, 'punctuation and repeated actions must remain literal');
  assert.equal(existsSync(join(f.root, 'NEVER')), false, 'mapping actions must never execute');
  assert.deepEqual(f.json('report').files[0].traceCounts, [
    { start: 1, end: 3, count: 1, withStepCount: 1 }, { start: 4, end: 4, count: 0, withStepCount: 0 },
  ]);
  assert.equal(f.json('report', '--sequence', JSON.stringify(actions)).totals.linked, 2);
  assert.equal(f.json('report', '--sequence', JSON.stringify(actions.slice(0, 2))).totals.linked, 0);
  assert.equal(f.json('report', '--sequence', JSON.stringify([...actions].reverse())).totals.linked, 0);
  assert.equal(f.json('report', '--action', 'key').totals.linked, 2);
  assert.equal(f.json('report', '--action', 'ke').totals.linked, 0, 'action matching must be exact');

  const unwitnessed = ['cart add --price 0', 'cart total'];
  f.ok(...f.link({ source: 'src/cart.py:2-4', actions: unwitnessed, step: null }));
  assert.deepEqual(f.json('report').files[0].traceCounts, [
    { start: 1, end: 1, count: 1, withStepCount: 1 },
    { start: 2, end: 3, count: 2, withStepCount: 1 },
    { start: 4, end: 4, count: 1, withStepCount: 0 },
  ]);
  assert.equal(f.json('report', '--step', 'tests/cart.spec:3').files[0].links.length, 2);
  f.ok('config', '--minimum-traces', '2');
  const persisted = f.bytes(), declared = f.json('report');
  assert.equal(declared.minimumTraces, 2);
  assert.equal(declared.totals.belowMinimum, 2);
  assert.equal(declared.kind, 'manual-links');
  assert.equal(declared.traceIdentity, 'exact-ordered-action-sequence');
  assert.match(declared.notice, /not observed execution/);
  assert.equal(f.json('report', '--minimum-traces', '1').totals.belowMinimum, 0);
  assert.equal(f.json('config').minimumTraces, 2);
  assert.equal(f.check().invalid.length, 0, 'ordinary check gates integrity, not counts');
  assert.equal(f.check(1, '--require-minimum').belowMinimum, 2);
  assert.deepEqual(f.bytes(), persisted, 'report and check overrides must not change persisted policy');

  f.ok(...f.link({ source: 'src/cart.py:1-4', actions, step: 'tests/cart.spec:1-3' }));
  f.ok(...f.link({ source: 'src/cart.py:1-4', actions: unwitnessed, step: null }));
  const enough = f.check(0, '--require-minimum', '--minimum-traces', '2');
  assert.equal(enough.belowMinimum, 0);
  assert.equal(f.check(1, '--require-minimum', '--minimum-traces', '3').belowMinimum, 3);
  assert.deepEqual(f.json('report').files[0].traceCounts, [{ start: 1, end: 4, count: 2, withStepCount: 1 }]);
  assert.equal(existsSync(join(f.root, 'NEVER')), false);
});

test('mapping journey: inspect a mixed-language Git inventory and opt in new source without inflating witnesses', t => {
  const f = project(t, {
    '.gitignore': 'ignored.py\n', 'ignored.py': 'ignored\n', 'tracked.py': 'tracked\n',
    'empty.rs': '', 'single.go': 'package main\n', 'last.js': 'last',
    'package.json': '{}\n', 'src/config.yaml': 'port: 1\n', 'docs/data.json': '{}\n',
    'tests/data.json': '{}\n', 'src/fixtures/data.json': '{}\n', 'src/package-lock.json': '{}\n', 'random.json': '{}\n',
    'vendor/lib.py': 'code\n', 'src/a.generated.js': 'code\n', 'build/result.py': 'code\n',
    'src/main.zig': 'pub fn main() void {}\n', 'docs/test.md': 'Then assert total\n', 'tests/noextension': 'assert total\n',
    'src/my cart:one.py': 'first\nsecond\n',
  });
  const initial = f.json('report'), paths = initial.files.map(file => file.path);
  assert.deepEqual(paths, ['empty.rs', 'last.js', 'package.json', 'single.go', 'src/cart.py', 'src/config.yaml', 'src/my cart:one.py', 'tracked.py']);
  assert.equal(initial.totals.lines, 10); assert.equal(initial.totals.physicalLines, 11);
  assert.equal(initial.files.find(file => file.path === 'empty.rs').lines, 0);
  assert.equal(initial.files.find(file => file.path === 'single.go').lines, 1);
  assert.equal(initial.files.find(file => file.path === 'last.js').lines, 1);
  assert.deepEqual(initial.excluded.map(file => file.path), ['build/result.py', 'src/a.generated.js', 'vendor/lib.py']);
  f.fail(f.link({ step: 'vendor/lib.py:1' }), /eligible repository text files/);
  assert.equal(existsSync(join(f.root, mapPath)), false);

  f.git('add', '-f', 'ignored.py', 'tracked.py');
  rmSync(join(f.root, 'tracked.py'));
  const tracked = f.json('report');
  assert.equal(tracked.files.some(file => file.path === 'ignored.py'), true, 'tracked files remain included even if ignored');
  assert.match(tracked.excluded.find(file => file.path === 'tracked.py').reason, /missing/);
  f.ok(...f.link({ step: 'docs/test.md:1' }));
  f.ok(...f.link({ step: 'tests/noextension:1' }));
  assert.equal(f.json('report').totals.lines, initial.totals.lines, 'sidecar and witness-only text must not expand source counts');
  assert.deepEqual(f.json('report', '--source', 'src/cart.py:1-2').files[0].traceCounts,
    [{ start: 1, end: 2, count: 1, withStepCount: 1 }]);
  assert.equal(f.json('report', '--step', 'docs/test.md:1').files[0].path, 'src/cart.py');
  f.ok(...f.link({ source: 'src/my cart:one.py:1-2', step: 'tests/noextension:1' }));
  assert.equal(f.json('report', '--source', 'src/my cart:one.py:2').totals.linked, 1);

  f.fail(['report', '--source', 'src/main.zig'], /source inventory/);
  const optedIn = f.json('--include-ext', '.zig', 'report');
  assert.equal(optedIn.totals.lines, initial.totals.lines + 1);
  assert.equal(f.json('--include-ext', '.zig', 'report', '--source', 'src/main.zig').totals.lines, 1);
  f.ok('--include-ext', '.zig', ...f.link({ source: 'src/main.zig:1', actions: ['zig run src/main.zig'], step: 'docs/test.md:1' }));
  assert.equal(f.check(1).invalid.length, 1, 'an opt-in source must still require opt-in on future inspections');
  assert.equal(JSON.parse(f.ok('--include-ext', '.zig', 'check', '--json')).invalid.length, 0);
  const safe = tree(f.root);
  f.fail(['--include-ext', '../bad', 'report'], /Invalid source extension/);
  assert.deepEqual(tree(f.root), safe);
});

test('mapping journey: preserve byte-exact source and witness snapshots and reject non-text input', t => {
  const f = project(t);
  const source = '\uFEFFdef total(items):\r\n    return sum(items)\r\n';
  const witness = '\uFEFFopen cart\r\nadd item\r\nassert total\r\n';
  f.put('src/cart.py', source); f.put('tests/cart.spec', witness);
  f.ok(...f.link({ step: 'tests/cart.spec:1-3' }));
  assert.equal(f.map().links[0].source.sha256, sha256(source));
  assert.equal(f.map().links[0].step.sha256, sha256(witness));
  assert.equal(f.json('report').totals.lines, 2, 'CRLF and a final newline must not add phantom lines');
  f.put('src/cart.py', source.replaceAll('\r\n', '\n'));
  assert.match(f.check(1).invalid[0].errors.join('; '), /source snippet is stale/);
  f.put('src/cart.py', source);
  f.put('tests/cart.spec', witness.replace('\uFEFF', ''));
  assert.match(f.check(1).invalid[0].errors.join('; '), /step snippet is stale/);
  f.put('tests/cart.spec', witness);
  assert.equal(f.check().valid, 1);

  const saved = f.bytes();
  for (const [bytes, error] of [[Buffer.from([0xff]), /encoded data/], ['a\0b', /NUL/]]) {
    f.put('src/bad.js', bytes);
    f.fail(['report', '--json'], error);
    f.fail(['check', '--json'], error);
    f.fail(f.link({ actions: ['another action'] }), error);
    assert.deepEqual(f.bytes(), saved, 'a bad source file must not be silently dropped or mutate links');
    rmSync(join(f.root, 'src/bad.js'));
    f.put('tests/cart.spec', bytes);
    assert.match(f.check(1).invalid[0].errors.join('; '), error);
    f.fail(f.link({ actions: ['another action'] }), error);
    assert.deepEqual(f.bytes(), saved, 'witnesses must also be valid text');
    f.put('tests/cart.spec', witness);
  }
  assert.equal(f.check().valid, 1);
});

test('mapping journey: diagnose corrupt sidecars without laundering invalid evidence or losing recoverable data', t => {
  const f = project(t);
  f.ok(...f.link());
  const pristine = f.bytes();
  const badDocuments = ['{', 'null', '{"version":2,"links":[]}', '{"version":1,"links":{}}',
    ...[0, null, '2', 1.5, 9007199254740992].map(minimumTraces => JSON.stringify({ version: 1, minimumTraces, links: [] }))];
  for (const text of badDocuments) {
    f.put(mapPath, text);
    const before = tree(f.root);
    f.fail(['report', '--json']);
    f.fail(['check', '--json']);
    f.fail(['config', '--minimum-traces', '2']);
    assert.deepEqual(tree(f.root), before, 'failed reads or mutation must preserve corrupt evidence and remove owned locks');
  }

  f.put(mapPath, pristine);
  const duplicateId = f.map().links[0].id;
  f.editMap(data => data.links.push(data.links[0]));
  const duplicates = f.bytes(), duplicateCheck = f.check(1);
  assert.equal(duplicateCheck.invalid.length, 2);
  assert.equal(duplicateCheck.valid, 0);
  assert.equal(f.json('report').totals.linked, 0);
  f.fail(['unlink', duplicateId], /Duplicate link id/);
  f.fail(f.link({ actions: ['new'] }), /invalid links/);
  assert.deepEqual(f.bytes(), duplicates);

  f.put(mapPath, pristine);
  f.editMap(data => data.links.push(null, [], { id: 'broken', actions: null }));
  const malformed = f.bytes(), malformedCheck = f.check(1);
  assert.equal(malformedCheck.invalid.length, 3);
  assert.equal(malformedCheck.valid, 1);
  assert.equal(f.json('report').totals.linked, 2, 'valid independent records remain readable');
  f.fail(f.link({ actions: ['new'] }), /invalid links/);
  assert.deepEqual(f.bytes(), malformed);
  assert.doesNotMatch(f.ok('report'), /TypeError/);

  f.put(mapPath, pristine);
  f.editMap(data => { data.links[0].why = 'bad\u001b[2J'; });
  assert.equal(f.json('report').totals.linked, 0);
  assert.match(f.check(1).invalid[0].errors.join('; '), /single-line explanation/);
  f.ok('unlink', duplicateId);
  assert.equal(f.check().total, 0, 'an explicitly selected unique invalid record can be removed');
  f.ok(...f.link());
  assert.equal(f.check().valid, 1, 'reviewed relinking must restore a valid map');
});

test('mapping journey: reject unsafe ranges and map destinations while isolating a custom map', t => {
  const f = project(t), untouched = tree(f.root);
  for (const path of ['../a.py', '/tmp/a.py', 'a/../b.py', 'a\\b.py', './a.py', 'a//b.py', 'a\nb.py', 'C:/a.py']) {
    f.fail(f.link({ source: `${path}:1` }), /repository-relative/);
    f.fail(['report', '--source', path], /repository-relative/);
  }
  for (const source of ['src/cart.py:0', 'src/cart.py:-1', 'src/cart.py:3-2', 'src/cart.py:9007199254740992', 'src/cart.py', 'src/cart.py:1-99']) {
    f.fail(f.link({ source }), /repository-relative|Invalid.*range/i);
  }
  for (const map of ['.git/config', 'src/.git/config', '../outside.json', '/tmp/outside.json']) {
    f.fail(['--map', map, 'config', '--minimum-traces', '3'], /inside \.git|repository-relative/);
  }
  assert.deepEqual(tree(f.root), untouched, 'rejected paths must not change any source or Git metadata');

  f.ok('--map', '.tracer/links.json', 'config', '--minimum-traces', '3');
  assert.equal(f.json('--map', '.tracer/links.json', 'config').minimumTraces, 3);
  assert.equal(f.json('config').minimumTraces, 1);
  assert.equal(existsSync(join(f.root, mapPath)), false, 'a custom map must not create the default sidecar');
  f.ok('--map', '.tracer/links.json', ...f.link());
  assert.equal(f.json('--map', '.tracer/links.json', 'report').totals.linked, 2);
  assert.equal(f.json('report').totals.linked, 0);
  const bytes = readFileSync(join(f.root, '.tracer/links.json'));
  f.fail(['--map', '.tracer/links.json', 'unlink', 'unknown'], /Unknown link id/);
  assert.deepEqual(readFileSync(join(f.root, '.tracer/links.json')), bytes);
  assert.equal(existsSync(join(f.root, '.tracer/links.json.lock')), false);
});

test('mapping journey: refuse symlinked source, witnesses and sidecar paths without touching their targets', t => {
  const f = project(t, { 'nested/a.py': 'text\n', 'elsewhere.txt': '{}', 'src/a.py': 'text\n' });
  symlinkSync(join(f.root, 'src/cart.py'), join(f.root, 'alias.py'));
  symlinkSync(join(f.sandbox, 'missing.py'), join(f.root, 'dangling.py'));
  const report = f.json('report');
  assert.match(report.excluded.find(file => file.path === 'alias.py').reason, /symlink/);
  assert.match(report.excluded.find(file => file.path === 'dangling.py').reason, /dangling symlink/);
  f.fail(f.link({ source: 'alias.py:1' }), /source inventory/);
  f.fail(f.link({ step: 'alias.py:1' }), /eligible repository text files/);
  f.git('add', 'nested/a.py');
  rmSync(join(f.root, 'nested'), { recursive: true });
  symlinkSync(join(f.root, 'src'), join(f.root, 'nested'));
  assert.equal(f.json('report').files.some(file => file.path.startsWith('nested/')), false);
  f.fail(f.link({ source: 'nested/a.py:1' }), /source inventory/);
  f.fail(f.link({ step: 'nested/a.py:1' }), /eligible repository text files/);

  mkdirSync(join(f.root, 'docs/testing'), { recursive: true });
  symlinkSync(join(f.root, 'elsewhere.txt'), join(f.root, mapPath));
  const before = tree(f.root);
  f.fail(['report'], /unsymlinked/);
  f.fail(f.link(), /unsymlinked/);
  f.fail(['config', '--minimum-traces', '2'], /unsymlinked/);
  assert.deepEqual(tree(f.root), before);
  assert.equal(readFileSync(join(f.root, 'elsewhere.txt'), 'utf8'), '{}');
  rmSync(join(f.root, 'docs'), { recursive: true });
  symlinkSync(join(f.sandbox, 'missing'), join(f.root, 'docs'));
  f.fail(f.link(), /unsymlinked/);
  f.fail(['config', '--minimum-traces', '2'], /unsymlinked/);
  assert.equal(existsSync(join(f.sandbox, 'missing')), false, 'dangling parent target must never be created');

  rmSync(join(f.root, 'docs'));
  const external = join(f.sandbox, 'external');
  mkdirSync(join(external, 'testing'), { recursive: true });
  writeFileSync(join(external, 'testing/code-e2e-links.json'), 'external evidence');
  symlinkSync(external, join(f.root, 'docs'));
  f.fail(f.link(), /unsymlinked/);
  assert.equal(readFileSync(join(external, 'testing/code-e2e-links.json'), 'utf8'), 'external evidence');
  assert.equal(existsSync(join(external, 'testing/code-e2e-links.json.lock')), false);
});

test('mapping journey: respect another writer lock and recover cleanly from rejected mutations', t => {
  const f = project(t);
  f.ok(...f.link());
  const original = f.bytes(), lock = `${mapPath}.lock`;
  f.put(lock, 'another writer owns this lock\n');
  f.fail(['config', '--minimum-traces', '2'], /Another writer or stale lock/);
  f.fail(f.link({ actions: ['another sequence'] }), /Another writer or stale lock/);
  f.fail(['unlink', f.map().links[0].id], /Another writer or stale lock/);
  assert.deepEqual(f.bytes(), original);
  assert.equal(readFileSync(join(f.root, lock), 'utf8'), 'another writer owns this lock\n');
  assert.equal(f.check().valid, 1, 'read-only inspection remains available while a writer owns the lock');
  rmSync(join(f.root, lock));
  f.fail(['unlink', 'not-found'], /Unknown link id/);
  assert.deepEqual(f.bytes(), original);
  assert.equal(existsSync(join(f.root, lock)), false, 'a rejected mutation must release only its own lock');
  assert.deepEqual(readdirSync(join(f.root, dirname(mapPath))), ['code-e2e-links.json'], 'no temporary files may remain');

  const target = join(f.sandbox, 'lock-target');
  writeFileSync(target, 'do not truncate');
  symlinkSync(target, join(f.root, lock));
  f.fail(['config', '--minimum-traces', '2'], /Another writer or stale lock/);
  assert.equal(readFileSync(target, 'utf8'), 'do not truncate');
  assert.equal(lstatSync(join(f.root, lock)).isSymbolicLink(), true);
  assert.deepEqual(f.bytes(), original);
  rmSync(join(f.root, lock));
  f.ok('config', '--minimum-traces', '2');
  assert.equal(f.json('config').minimumTraces, 2);
  f.ok('unlink', f.map().links[0].id);
  assert.equal(f.check().total, 0);
  assert.equal(existsSync(join(f.root, lock)), false);
});

test('mapping journey: guide first use outside Git and reject ambiguous CLI input without side effects', t => {
  const f = project(t), untouched = tree(f.root);
  const help = f.expect(['--help'], 0, { cwd: f.home, explicitRoot: false });
  assert.match(help.stdout, /MANUAL LINKS ONLY/);
  assert.match(f.expect(['--version'], 0, { cwd: f.home, explicitRoot: false }).stdout, /^\d+\.\d+\.\d+/);
  assert.match(f.expect([], 0, { cwd: f.home, explicitRoot: false }).stdout, /Usage: tracer/);
  assert.deepEqual(tree(f.home), {}, 'help and version must work without creating user state');
  const outside = f.expect(['report'], 1, { cwd: f.home, explicitRoot: false });
  assert.match(outside.stderr, /git|repository/i);
  const subdirectory = f.expect(['--root', join(f.root, 'src'), 'report'], 1, { explicitRoot: false });
  assert.match(subdirectory.stderr, /repository root/);
  const inferred = f.expect(['report', '--json'], 0, { cwd: join(f.root, 'src'), explicitRoot: false });
  assert.equal(JSON.parse(inferred.stdout).totals.lines, 3);

  const invalid = [
    ['report', 'cart'], ['report', '--source', 'src/cart.py', '--action', 'cart'], ['report', '--action', 'cart', '--action', 'cart'],
    ['report', '--source', 'missing.py'], ['report', '--sequence', '[]'], ['report', '--sequence', 'null'], ['report', '--sequence', 'not json'],
    ['report', '--sequence', '["cart",2]'], ['report', '--step', 'missing.spec:1'],
    ['check', '--minimum-traces', '2'], ['check', '--bogus'], ['config', '--minimum-traces'], ['unlink'],
    ['link', 'src/cart.py:1', '--action', 'cart'], ['link', 'src/cart.py:1', '--why', 'why'],
    ['link', 'src/cart.py:1', '--action', ' cart ', '--why', 'why'],
    ['link', 'src/cart.py:1', '--action', 'cart\nnext', '--why', 'why'],
    ['link', 'src/cart.py:1', '--action', 'cart', '--why', 'bad\u001b[2J'],
    ['link', 'src/cart.py:1', '--action', 'cart', '--why', 'why', '--why', 'again'],
    ['--root', f.root, 'report'], ['--bogus', 'x', 'report'], ['--map'], ['unknown'],
  ];
  for (const args of invalid) f.fail(args);
  for (const bad of ['0', '-1', '1.5', '1e2', 'NaN', 'Infinity', '9007199254740992', '01', '']) {
    f.fail(['config', '--minimum-traces', bad], /positive safe integer|requires a value/);
    f.fail(['report', '--minimum-traces', bad], /positive safe integer|requires a value/);
    f.fail(['check', '--require-minimum', '--minimum-traces', bad], /positive safe integer|requires a value/);
  }
  assert.deepEqual(tree(f.root), untouched, 'CLI validation failures must not write source, sidecars or Git metadata');
  assert.deepEqual(tree(f.home), {}, 'CLI diagnostics must not create global state');
  assert.equal(existsSync(join(f.root, 'docs')), false);
});

test('mapping journey: compare overlapping report traces with an independent per-line oracle', t => {
  const f = project(t, { 'src/cart.py': Array.from({ length: 24 }, (_, i) => `line ${i + 1}\n`).join(''), 'src/empty.py': '' });
  const sequences = [['open', 'save'], ['open', 'save', 'save'], ['save', 'open']];
  const rows = [
    [1, 7, 0, false], [3, 5, 0, true], [6, 10, 0, true], [8, 12, 0, false],
    [13, 16, 0, true], [17, 20, 0, true], [4, 18, 1, false], [9, 14, 1, true],
    [2, 22, 2, true], [11, 15, 2, false],
  ];
  // Deterministic additional overlaps exercise repeated starts/ends and trace refcounts.
  for (let i = 0; i < 8; i++) rows.push([1 + (i * 7) % 18, 19 + i % 5, i % 3, i % 2 === 0]);
  for (const [start, end, sequence, witnessed] of rows) f.ok(...f.link({
    source: `src/cart.py:${start}-${end}`, actions: sequences[sequence],
    step: witnessed ? `tests/cart.spec:${1 + sequence % 2}-${2 + sequence % 2}` : null,
  }));
  // Sidecars need not be sorted; report links must retain their persisted order.
  f.editMap(data => data.links.reverse());
  const persisted = f.bytes(), links = f.map().links;
  const ranges = values => {
    const result = [];
    for (const line of values) {
      const last = result.at(-1);
      if (last && last[1] + 1 === line) last[1] = line;
      else result.push([line, line]);
    }
    return result;
  };
  const oracle = (selected, start = 1, end = 24, minimum = 2) => {
    const traceCounts = [], linked = [], unlinked = [], withStep = [], belowMinimum = [];
    for (let line = start; line <= end; line++) {
      const atLine = selected.filter(row => row.source.start <= line && row.source.end >= line);
      const count = new Set(atLine.map(row => JSON.stringify(row.actions))).size;
      const withStepCount = new Set(atLine.filter(row => row.step).map(row => JSON.stringify(row.actions))).size;
      const previous = traceCounts.at(-1);
      if (previous && previous.count === count && previous.withStepCount === withStepCount) previous.end = line;
      else traceCounts.push({ start: line, end: line, count, withStepCount });
      (count ? linked : unlinked).push(line);
      if (withStepCount) withStep.push(line);
      if (count < minimum) belowMinimum.push(line);
    }
    return { start, end, lines: end - start + 1, linked: linked.length, withStep: withStep.length,
      unlinked: unlinked.length, belowMinimum: belowMinimum.length, traceCounts,
      linkedRanges: ranges(linked), unlinkedRanges: ranges(unlinked), belowMinimumRanges: ranges(belowMinimum) };
  };
  const cases = [
    { args: [], selected: links },
    { args: ['--source', 'src/cart.py:5-17'], selected: links, start: 5, end: 17 },
    { args: ['--source', 'src/cart.py:24'], selected: links, start: 24, end: 24 },
    { args: ['--action', 'save'], selected: links },
    { args: ['--sequence', JSON.stringify(sequences[0])], selected: links.filter(row => JSON.stringify(row.actions) === JSON.stringify(sequences[0])) },
    { args: ['--sequence', JSON.stringify(sequences[1])], selected: links.filter(row => JSON.stringify(row.actions) === JSON.stringify(sequences[1])) },
    { args: ['--sequence', JSON.stringify(sequences[2])], selected: links.filter(row => JSON.stringify(row.actions) === JSON.stringify(sequences[2])) },
    { args: ['--step', 'tests/cart.spec:3'], selected: links.filter(row => row.step?.end >= 3) },
  ];
  for (const { args, selected, start = 1, end = 24 } of cases) {
    const argv = ['report', ...args, '--minimum-traces', '2', '--json'];
    const output = f.ok(...argv), report = JSON.parse(output);
    assert.equal(f.ok(...argv), output, 'unchanged CLI output must be byte-for-byte deterministic');
    const file = report.files.find(file => file.path === 'src/cart.py');
    const expected = oracle(selected, start, end);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(file[key], value, `${args.join(' ')}: ${key}`);
    assert.deepEqual(file.links, selected.filter(row => row.source.end >= start && row.source.start <= end));
    assert.deepEqual(report.totals, { files: args.length ? 1 : 2, lines: expected.lines,
      linked: expected.linked, withStep: expected.withStep, unlinked: expected.unlinked, belowMinimum: expected.belowMinimum, physicalLines: expected.lines, blankLines: 0, commentLines: 0 });
  }
  const empty = f.json('report', '--source', 'src/empty.py').files[0];
  assert.equal(empty.lines, 0);
  for (const key of ['traceCounts', 'linkedRanges', 'unlinkedRanges', 'belowMinimumRanges', 'links']) assert.deepEqual(empty[key], []);
  assert.equal(f.json('report', '--action', 'missing action').totals.files, 0);
  assert.deepEqual(f.bytes(), persisted, 'read-only selectors and threshold overrides preserve the sidecar');
});

test('mapping journey: retain global stale and malformed diagnostics in a narrow report', t => {
  const f = project(t, { 'src/other.py': 'old\n', 'tests/other.spec': 'assert old\n' });
  f.ok(...f.link());
  f.ok(...f.link({ source: 'src/other.py:1', actions: ['other'], step: 'tests/other.spec:1' }));
  f.put('src/other.py', 'new\n');
  f.put('tests/other.spec', 'assert new\n');
  f.editMap(data => data.links.push(null, [], { id: 'malformed', actions: ['other'], source: null }));
  const saved = f.bytes(), full = f.json('report'), check = f.check(1);
  assert.equal(full.invalid.length, 4);
  assert.deepEqual(check.invalid, full.invalid);
  assert.match(full.invalid.find(row => row.link?.actions?.[0] === 'other' && row.link?.step).errors.join('; '), /source snippet is stale.*step snippet is stale/);
  for (const args of [['--source', 'src/cart.py:1'], ['--step', 'tests/cart.spec:2'], ['--action', 'cart total'], ['--sequence', JSON.stringify(cartActions)]]) {
    const report = f.json('report', ...args);
    assert.deepEqual(report.invalid, full.invalid, 'selection must not suppress unrelated integrity diagnostics');
    assert.equal(report.files.length, 1);
    assert.equal(report.files[0].path, 'src/cart.py');
    assert.equal(report.files[0].links.length, 1);
  }
  assert.deepEqual(f.bytes(), saved, 'reporting must not repair malformed rows or refresh stale hashes');
});

test('mapping journey: repeated exact UTF-8 snapshots remain fresh only until the next disk mutation', t => {
  const source = '\uFEFFconst café = "雪";\r\n// déjà vu\r\nlast';
  const witness = '\uFEFFopen 雪\r\nassert café\r\n';
  const f = project(t, { 'src/cart.py': source, 'tests/cart.spec': witness });
  for (const actions of [['open'], ['open', 'open'], ['open', 'save']]) f.ok(...f.link({ actions, step: 'tests/cart.spec:1-2' }));
  f.ok(...f.link({ source: 'src/cart.py:2-3', actions: ['tail'], step: 'src/cart.py:2-3' }));
  for (const row of f.map().links) {
    assert.equal(row.source.sha256, sha256(row.source.start === 1 ? source.slice(0, source.indexOf('last')) : '// déjà vu\r\nlast'));
    assert.equal(row.step.sha256, sha256(row.step.path === 'tests/cart.spec' ? witness : '// déjà vu\r\nlast'));
  }
  assert.equal(f.check().valid, 4);
  const saved = f.bytes();
  f.put('src/cart.py', source.replace('café', 'cafe'));
  assert.equal(f.json('report').totals.linked, 2, 'a new invocation must invalidate changed shared source ranges but preserve an unchanged tail');
  assert.equal(f.check(1).invalid.length, 3);
  f.fail(f.link({ actions: ['open'], step: 'tests/cart.spec:1-2' }), /never silently refreshed/);
  f.put('src/cart.py', source);
  f.put('tests/cart.spec', witness.replaceAll('\r\n', '\n'));
  assert.equal(f.check(1).invalid.length, 3, 'a new invocation must reread changed shared witness bytes');
  f.fail(f.link({ actions: ['open'], step: 'tests/cart.spec:1-2' }), /never silently refreshed/);
  f.put('tests/cart.spec', witness);
  assert.equal(f.check().valid, 4);
  assert.deepEqual(f.bytes(), saved, 'freshness checks never rewrite historical snapshots');
});

test('mapping journey: ignore only whitespace-only physical lines, including all-blank and empty files', t => {
  const f = project(t, {
    'src/cart.py': '\uFEFF \t\r\n\n\t\r\n  ',
    'src/empty.py': '',
    'src/comments.js': '// standalone\n# standalone\n/* block\n * body\n */\nconst text = `\n   \n`;\n',
  });
  const untouched = tree(f.root), report = f.json('report');
  assert.equal(report.lineBasis, 'nonblank-undeclared-comment-lines');
  const humanReport = f.ok('report');
  assert.match(humanReport, /7 nonblank lines/);
  assert.match(humanReport, /5 blank lines excluded/);
  assert.match(humanReport, /Unmarked comments, tests and tooling stay counted unless explicitly ignored above; whitespace-only lines and current comment declarations are excluded/);
  assert.match(f.expect(['check', '--require-minimum'], 1).stdout, /7 nonblank source lines below project minimum 1; 5 blank lines excluded/);
  assert.match(f.ok('config'), /per nonblank source line/);
  assert.deepEqual(report.totals, { files: 3, physicalLines: 12, blankLines: 5, commentLines: 0,
    lines: 7, linked: 0, withStep: 0, unlinked: 7, belowMinimum: 7 });
  const blank = report.files.find(file => file.path === 'src/cart.py');
  assert.equal(blank.physicalLines, 4);
  assert.equal(blank.blankLines, 4);
  assert.deepEqual(blank.blankRanges, [[1, 4]]);
  assert.equal(blank.lines, 0);
  for (const key of ['linked', 'withStep', 'unlinked', 'belowMinimum']) assert.equal(blank[key], 0);
  for (const key of ['linkedRanges', 'unlinkedRanges', 'belowMinimumRanges', 'links']) assert.deepEqual(blank[key], []);
  assert.deepEqual(blank.traceCounts, [{ start: 1, end: 4, count: 0, withStepCount: 0 }]);
  const empty = report.files.find(file => file.path === 'src/empty.py');
  assert.equal(empty.physicalLines, 0);
  assert.equal(empty.blankLines, 0);
  assert.equal(empty.lines, 0);
  assert.deepEqual(empty.blankRanges, []);
  assert.deepEqual(empty.traceCounts, []);
  const comments = report.files.find(file => file.path === 'src/comments.js');
  assert.equal(comments.lines, 7, 'standalone comments remain counted; only the blank physical string line is skipped');
  assert.deepEqual(comments.blankRanges, [[7, 7]]);
  assert.deepEqual(comments.unlinkedRanges, [[1, 6], [8, 8]]);
  assert.deepEqual(comments.belowMinimumRanges, [[1, 6], [8, 8]]);
  assert.deepEqual(tree(f.root), untouched, 'blank exclusion is automatic and does not create metadata');
  assert.equal(f.check(1, '--require-minimum').belowMinimum, 7);
  f.put('src/comments.js', '');
  assert.equal(f.check(0, '--require-minimum', '--minimum-traces', '9').belowMinimum, 0,
    'empty and all-blank files do not fail requested positive minimums');
});

test('mapping journey: deduplicate overlapping sequences across blank gaps and clip physical selectors', t => {
  const source = 'alpha\n\n  \t\n# counted comment\nbeta\n\t\ngamma\n\nomega';
  const f = project(t, { 'src/cart.py': source });
  const actions = ['open', 'save', 'save'];
  f.ok(...f.link({ source: 'src/cart.py:1-5', actions }));
  f.ok(...f.link({ source: 'src/cart.py:4-7', actions, step: null }));
  f.ok(...f.link({ source: 'src/cart.py:2-6', actions: ['save', 'open'], step: null }));
  f.editMap(data => data.links.push({ ...data.links.find(row => row.source.start === 1), id: 'blank-gap-duplicate' }));
  const saved = f.bytes(), report = f.json('report', '--minimum-traces', '2'), file = report.files[0];
  assert.deepEqual(report.totals, { files: 1, physicalLines: 9, blankLines: 4, commentLines: 0,
    lines: 5, linked: 4, withStep: 3, unlinked: 1, belowMinimum: 3 });
  assert.deepEqual(file.blankRanges, [[2, 3], [6, 6], [8, 8]]);
  assert.deepEqual(file.linkedRanges, [[1, 1], [4, 5], [7, 7]]);
  assert.deepEqual(file.unlinkedRanges, [[9, 9]]);
  assert.deepEqual(file.belowMinimumRanges, [[1, 1], [7, 7], [9, 9]]);
  assert.deepEqual(file.traceCounts, [
    { start: 1, end: 1, count: 1, withStepCount: 1 },
    { start: 2, end: 5, count: 2, withStepCount: 1 },
    { start: 6, end: 6, count: 2, withStepCount: 0 },
    { start: 7, end: 7, count: 1, withStepCount: 0 },
    { start: 8, end: 9, count: 0, withStepCount: 0 },
  ], 'traceCounts retain full physical intervals, including blank gaps');
  assert.deepEqual(file.links, f.map().links);
  const selected = f.json('report', '--source', 'src/cart.py:3-8', '--minimum-traces', '2');
  assert.deepEqual(selected.totals, { files: 1, physicalLines: 6, blankLines: 3, commentLines: 0,
    lines: 3, linked: 3, withStep: 2, unlinked: 0, belowMinimum: 1 });
  assert.deepEqual(selected.files[0].blankRanges, [[3, 3], [6, 6], [8, 8]]);
  assert.deepEqual(selected.files[0].linkedRanges, [[4, 5], [7, 7]]);
  assert.deepEqual(selected.files[0].belowMinimumRanges, [[7, 7]]);
  assert.deepEqual(selected.files[0].traceCounts, [
    { start: 3, end: 5, count: 2, withStepCount: 1 },
    { start: 6, end: 6, count: 2, withStepCount: 0 },
    { start: 7, end: 7, count: 1, withStepCount: 0 },
    { start: 8, end: 8, count: 0, withStepCount: 0 },
  ]);
  const onlyBlank = f.json('report', '--source', 'src/cart.py:2-3');
  assert.equal(onlyBlank.totals.lines, 0);
  assert.equal(onlyBlank.totals.physicalLines, 2);
  assert.equal(onlyBlank.totals.blankLines, 2);
  assert.equal(onlyBlank.files[0].links.length, 3, 'physical navigation still finds links over excluded lines');
  assert.deepEqual(onlyBlank.files[0].linkedRanges, []);
  assert.equal(f.json('report', '--sequence', JSON.stringify(actions)).totals.linked, 4);
  assert.equal(f.json('report', '--sequence', JSON.stringify(['open', 'save'])).totals.linked, 0);
  assert.equal(f.json('report', '--step', 'tests/cart.spec:2').totals.withStep, 3);
  assert.equal(f.check(1, '--require-minimum', '--minimum-traces', '2').belowMinimum, 3);
  assert.deepEqual(f.bytes(), saved, 'selectors and minimum checks preserve v1 map bytes');
});

test('mapping journey: blank-only links retain exact v1 hashes, navigation and whitespace-staleness checks', t => {
  const source = '\uFEFF \t\r\n\r\n// retained\r\n', witness = '\uFEFFopen\r\n\t\r\nassert\r\n';
  const f = project(t, { 'src/cart.py': source, 'tests/cart.spec': witness });
  f.ok(...f.link({ source: 'src/cart.py:1-2', actions: ['inspect blanks'], step: 'tests/cart.spec:1-3' }));
  const row = f.map().links[0];
  assert.equal(f.map().version, 1);
  assert.equal(row.source.sha256, sha256('\uFEFF \t\r\n\r\n'));
  assert.equal(row.step.sha256, sha256(witness));
  f.editMap(data => { data.links[0] = { why: row.why, step: row.step, source: row.source,
    actions: row.actions, id: 'legacy-blank-only' }; });
  const saved = f.bytes();
  for (const args of [['--source', 'src/cart.py:1-2'], ['--step', 'tests/cart.spec:2'],
    ['--action', 'inspect blanks'], ['--sequence', JSON.stringify(['inspect blanks'])]]) {
    const report = f.json('report', ...args);
    assert.equal(report.files[0].links[0].id, 'legacy-blank-only');
    assert.equal(report.totals.linked, 0);
    assert.equal(report.totals.withStep, 0);
  }
  assert.equal(f.check().valid, 1);
  assert.match(f.ok(...f.link({ source: 'src/cart.py:1-2', actions: ['inspect blanks'], step: 'tests/cart.spec:1-3' })), /Already linked: legacy-blank-only/);
  assert.deepEqual(f.bytes(), saved);
  f.put('src/cart.py', source.replace(' \t', '  \t'));
  const stale = f.check(1);
  assert.match(stale.invalid[0].errors.join('; '), /source snippet is stale/);
  const report = f.json('report');
  assert.equal(report.totals.blankLines, 2);
  assert.equal(report.totals.lines, 1);
  assert.equal(report.invalid.length, 1);
  assert.deepEqual(report.files[0].links, []);
  f.fail(f.link({ source: 'src/cart.py:1-2', actions: ['inspect blanks'], step: 'tests/cart.spec:1-3' }), /never silently refreshed/);
  assert.deepEqual(f.bytes(), saved, 'whitespace exclusion never normalizes stored hashes or refreshes history');
  f.put('src/cart.py', source);
  assert.equal(f.check().valid, 1);
  assert.deepEqual(f.bytes(), saved);
});

test('mapping journey: complete help is consistent across entry routes and does not require or mutate a project', t => {
  const f = project(t), untouched = tree(f.root);
  const outside = { cwd: f.home, explicitRoot: false };
  const version = f.expect(['--version'], 0, outside).stdout.trim();
  const expected = `Tracer ${version} — source ↔ ordered CLI actions ↔ test steps

Usage: tracer [--root REPOSITORY] [--map PATH] [--include-ext .zig] COMMAND

  init [--app-json '["node","cli/app.mjs"]'] [--actions-json '["actions","--json"]']
       [--minimum-traces N] [--agent codex|claude] [--install-skill] [--add-instruction]
  actions                 Run configured discovery, or the app’s --help
  app -- ARGS...          Explicitly run the configured app with exact arguments
  link SOURCE:START-END --action TEXT [--action TEXT ...]
       [--step TEST:START-END] --why TEXT\n  dead-code PATH:START-END --why TEXT --evidence TEXT\n  undead-code ID
  report [--source PATH[:RANGE] | --action TEXT | --step PATH[:RANGE]
          | --sequence '["first action","next action"]'] [--minimum-traces N] [--json]
  check [--require-minimum] [--minimum-traces N] [--json]
  config [--minimum-traces N] [--json]
  unlink ID
  comment SOURCE:START-END  Declare reviewed comment lines (not syntax-verified)
  uncomment ID             Remove a comment declaration after review
  ignore PATH --why TEXT    Exclude a file/directory from manual mapping totals only
  unignore EXACT_PATH      Restore a saved ignored path (directories end in /)
  update [--check | --status | --install-managed | --rollback | --refresh-skills | --auto off|check|apply]
         [--version VERSION | --commit FULL_SHA] [--json]
  measure import --before FILE --after FILE --manifest FILE --sources FILE
                 [--strip-prefix PREFIX/] [--allow-stale] [--json]
  measure report [--source PATH[:RANGE] | --action TEXT | --sequence JSON] [--json]
  measure check [--json]
  proposal prepare|check|report --file PROPOSAL [--json]
  proposal audit --file PROPOSAL [--offset N] [--limit N] [--json]
  scenario prepare|check --file CATALOG [--json]
  scenario report|packet --file CATALOG [--scenario ID] [--json]
  scenario link --file CATALOG [--scenario ID] --reviewed
                --expect-catalog-sha256 HASH --expect-map-sha256 HASH [--json]
  --help | --version

init never overwrites existing config/map or executes an app. In a terminal it may
offer agent setup. Skill installation and project guidance require separate consent. Only actions and app
execute the reviewed tracer.json argv configuration, without shell interpolation.
CLI-driven testing needs an application CLI covering the authorized app features.
If the app has no CLI, one must be built; Tracer does not build it automatically.
Global options go before the command. Repeat --include-ext to add source languages.
Ranges are 1-based, inclusive. Mapped actions are literal descriptions, never executed.
One distinct exact ordered action sequence is one manual trace per nonblank line, regardless
of duplicate links or witnesses. Repeated actions inside it remain ordered steps.
For whole-codebase mapping, propose the full scenario map first, then audit in batches.
Proposals may include unwritten tests and uncertainty; no execution is prerequisite.
The project minimum defaults to 1. check gates integrity; --require-minimum also
gates declared trace counts across included project mapping scope. Neither measures execution.
MANUAL LINKS ONLY. A current link is not observed execution, test coverage or proof of correctness.
`;
  for (const args of [[], ['-h'], ['--help']]) {
    const result = f.expect(args, 0, outside);
    assert.equal(result.stdout, expected); assert.equal(result.stderr, '');
  }
  for (const command of ['init', 'actions', 'app', 'link', 'report', 'check', 'unlink', 'comment', 'uncomment', 'dead-code', 'undead-code', 'ignore', 'unignore', 'config', 'update', 'measure', 'scenario', 'proposal']) {
    const result = f.expect([command, '--help'], 0, outside);
    assert.equal(result.stdout, expected, `${command} --help must show the same complete contract`);
    assert.equal(result.stderr, '');
  }
  const selected = f.expect(['--root', f.root, '--map', '.tracer/custom.json', 'report', '--help'], 0, outside);
  assert.equal(selected.stdout, expected); assert.equal(selected.stderr, '');
  assert.deepEqual(tree(f.root), untouched); assert.deepEqual(tree(f.home), {});
});

test('mapping journey: basename-only source inventory and project scope notices remain explicit in human output', t => {
  const f = project(t, { Makefile: 'all:\n', Dockerfile: 'FROM scratch\n', 'CMakeLists.txt': 'project(synthetic)\n',
    Gemfile: "source 'https://example.invalid'\n", Rakefile: 'task :build\n', 'docs/guide.txt': 'Not a source basename.\n' });
  const report = f.json('report');
  assert.deepEqual(report.files.map(file => file.path), ['CMakeLists.txt', 'Dockerfile', 'Gemfile', 'Makefile', 'Rakefile', 'src/cart.py']);
  f.ok('ignore', 'src', '--why', 'Synthetic explicit scope.');
  const notice = 'Project ignores exclude files only from manual mapping totals and minimum thresholds, not from tests, link integrity or measured evidence. An empty included scope is not full coverage.';
  const ignored = f.json('report');
  assert.equal(ignored.scopeNotice, notice); assert.equal(f.check().scopeNotice, notice);
  const human = f.ok('report'); assert.ok(human.split('\n').includes(notice));
  const checked = f.ok('check'); assert.ok(checked.split('\n').includes(notice));
  assert.equal(ignored.totals.lines, 5); assert.equal(ignored.ignoredTotals.lines, 3);
  assert.equal(ignored.ignoredSources[0].why, 'Synthetic explicit scope.');
});

test('progress journey: independent proposed categories, manual witnesses and reviewable dead-code marks', t => {
  const f = project(t), catalogPath = 'docs/testing/code-feature-catalog.json';
  const hash = value => sha256(value), data = cartSource.split('\n'); data.pop();
  const catalog = { schemaVersion: 1, kind: 'feature-classification-catalog', inventory: {
    schemaVersion: 1, kind: 'feature-source-inventory', scope: 'fixture', lineBasis: 'nonblank-undeclared-comment-lines',
    manifestSha256: hash('manifest'), reportSha256: hash('report'), files: [{ path: 'src/cart.py', sha256: hash(cartSource), physicalLines: 4, includedLines: 3, blankRanges: [[3, 3]], commentRanges: [] }] },
    taxonomy: { schemaVersion: 1, features: [{ id: 'cart', title: 'Cart' }] },
    proposals: [{ assignmentId: 'p1', model: 'fixture', sha256: hash('proposal') }],
    ranges: [{ path: 'src/cart.py', start: 1, end: 2, featureId: 'cart', confidence: 'high', rationale: 'Cart calculation', status: 'model-proposed', assignmentId: 'p1', fileSha256: hash(cartSource), spanSha256: hash(data.slice(0, 2).join('\n')) }] };
  const missing = f.json('report').progress;
  assert.equal(missing.categorization.status, 'missing'); assert.equal(missing.categorization.percent, null);
  f.put(catalogPath, JSON.stringify(catalog));
  let r = f.json('report').progress;
  assert.equal(r.categorization.lines, 2); assert.equal(r.categorization.percent, 200 / 3);
  assert.equal(r.mapping.manual.lines, 0); assert.equal(r.mapping.withTestWitness.lines, 0);
  f.ok(...f.link({ source: 'src/cart.py:1', step: null }));
  f.ok(...f.link({ source: 'src/cart.py:2', actions: ['cart total'], step: 'tests/cart.spec:3' }));
  r = f.json('report').progress;
  assert.equal(r.mapping.manual.lines, 2); assert.equal(r.mapping.withTestWitness.lines, 1);
  assert.match(f.ok('report'), /SCENARIO MAPPING:.*with test witnesses/);
  f.fail(['dead-code', 'src/cart.py:1', '--why', 'unused'], /evidence/);
  f.ok('dead-code', 'src/cart.py:1-2', '--why', 'candidate for removal', '--evidence', 'no callers found in reviewed build');
  const markedBytes = f.bytes();
  assert.match(f.ok('dead-code', 'src/cart.py:1-2', '--why', 'candidate for removal', '--evidence', 'no callers found in reviewed build'), /Already marked/);
  assert.deepEqual(f.bytes(), markedBytes);
  f.fail(['dead-code', 'src/cart.py:1-2', '--why', 'different reason', '--evidence', 'no callers found in reviewed build'], /differs/);
  f.ok('dead-code', 'src/cart.py:2-4', '--why', 'candidate for retention review', '--evidence', 'legacy path');
  r = f.json('report').progress;
  assert.equal(r.deadCode.lines, 3); assert.equal(r.deadCode.denominator, 3); assert.equal(r.deadCode.percent, 100);
  assert.equal(f.json('report', '--source', 'src/cart.py:1').progress.deadCode.denominator, 3);
  assert.equal(r.mapping.manual.lines, 2, 'dead-code marks do not change mapping');
  const id = r.deadCode.marks[0].id;
  f.ok('undead-code', id); assert.equal(f.json('report').progress.deadCode.marks.length, 1);
  catalog.ranges.push({ ...catalog.ranges[0], start: 2, end: 2, spanSha256: hash(data[1]) });
  f.put(catalogPath, JSON.stringify(catalog));
  r = f.json('report').progress;
  assert.equal(r.categorization.lines, 0); assert.match(r.categorization.issues.join(' '), /overlapping/);
  f.put('src/cart.py', cartSource + '# changed\n');
  r = f.json('report').progress;
  assert.equal(r.categorization.lines, 0); assert.match(r.categorization.issues.join(' '), /Stale/);
  assert.equal(r.deadCode.lines, 0); assert.equal(r.deadCode.invalid.length, 1);
  assert.equal(f.check(1).invalidDeadCode.length, 1);
  f.put(catalogPath, '{bad'); assert.equal(f.json('report').progress.categorization.status, 'invalid');
  f.editMap(map => { map.deadCode.push({ id: 'broken', why: 'bad' }); });
  assert.equal(f.check(1).invalidDeadCode.length, 2);
  f.fail(['dead-code', 'src/cart.py:1', '--why', 'review', '--evidence', 'inspection'], /invalid dead-code/);
});

test('progress journey: empty included scope has no percentage', t => {
  const f = project(t); f.ok('ignore', 'src/', '--why', 'fixture scope');
  const p = f.json('report').progress;
  assert.equal(p.mapping.manual.percent, null); assert.equal(p.mapping.withTestWitness.percent, null);
  assert.equal(p.deadCode.percent, null); assert.equal(p.categorization.percent, null);
  assert.match(f.ok('report'), /N\/A/);
});

test('progress journey: human output identifies catalog issues and dead-code review status', t => {
  const f = project(t);
  f.ok('dead-code', 'src/cart.py:1', '--why', 'candidate', '--evidence', 'reviewed references');
  let human = f.ok('report');
  assert.match(human, /CATEGORIZATION: missing; 0 \/ 3 included lines \(N\/A\)/);
  assert.match(human, /DECLARED DEAD CODE: 1 \/ 3 whole included lines \(33\.33%\)/);
  assert.match(human, /Why: candidate; evidence: reviewed references/);
  assert.match(human, /not deleted or excluded from mapping/);
  assert.match(human, /not measured execution or proof of test success/);
  f.put('docs/testing/code-feature-catalog.json', '{bad');
  f.put('src/cart.py', cartSource.replace('sum(items)', 'sum(items) + 1'));
  human = f.ok('report');
  assert.match(human, /CATEGORIZATION: invalid/);
  assert.match(human, /CATALOG ISSUE:/);
  assert.match(human, /INVALID DEAD CODE .*stale/);
  assert.match(human, /DECLARED DEAD CODE: 0 \/ 3 whole included lines \(0\.00%\)/);
});
