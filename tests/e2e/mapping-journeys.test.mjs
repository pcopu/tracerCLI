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
  assert.deepEqual(empty.totals, { files: 1, lines: 4, linked: 0, withStep: 0, unlinked: 4, belowMinimum: 4 });
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
  assert.match(f.ok('report', '--source', 'src/cart.py:1-2'), /Add an item, then assert the total\./);
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
  assert.equal(f.json('report', '--sequence', JSON.stringify(actions)).totals.linked, 3);
  assert.equal(f.json('report', '--sequence', JSON.stringify(actions.slice(0, 2))).totals.linked, 0);
  assert.equal(f.json('report', '--sequence', JSON.stringify([...actions].reverse())).totals.linked, 0);
  assert.equal(f.json('report', '--action', 'key').totals.linked, 3);
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
  assert.equal(f.check(1, '--require-minimum', '--minimum-traces', '3').belowMinimum, 4);
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
  assert.equal(initial.totals.lines, 11);
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
  assert.equal(JSON.parse(inferred.stdout).totals.lines, 4);

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
