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

// All application interactions use the shipped CLI. Filesystem edits prepare
// synthetic repositories or corrupt fixtures deliberately; no Tracer API is imported.
const cli = fileURLToPath(new URL('../../bin/tracer.mjs', import.meta.url));
const mapPath = 'docs/testing/code-e2e-links.json';
const measuredPath = 'docs/testing/code-e2e-measurements.json';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const zeroTotals = { files: 0, lines: 0, linked: 0, withStep: 0, unlinked: 0,
  belowMinimum: 0, physicalLines: 0, blankLines: 0, commentLines: 0 };

function tree(root, prefix = '') {
  const result = {};
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const path = prefix ? `${prefix}/${name}` : name, absolute = join(root, path), info = lstatSync(absolute);
    if (info.isSymbolicLink()) result[path] = { symlink: readlinkSync(absolute) };
    else if (info.isDirectory()) { result[path] = { directory: true }; Object.assign(result, tree(root, path)); }
    else if (info.isFile()) result[path] = { bytes: readFileSync(absolute).toString('base64') };
    else result[path] = { mode: info.mode };
  }
  return result;
}

function project(t, files = { 'src/main.py': 'first\nsecond\n' }) {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'tracer-ignore-journey-')));
  const root = join(sandbox, 'repo'), home = join(sandbox, 'home');
  mkdirSync(root); mkdirSync(home);
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), TRACER_NO_UPDATE: '1' };
  execFileSync('git', ['init', '-q'], { cwd: root, env });
  const put = (path, bytes) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); };
  const read = path => readFileSync(join(root, path));
  put('docs/witness.spec', 'open\nassert result\n');
  for (const [path, bytes] of Object.entries(files)) put(path, bytes);
  const run = (args, status = 0) => {
    const result = spawnSync(process.execPath, [cli, '--root', root, ...args], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error); assert.equal(result.signal, null);
    assert.equal(result.status, status, `${JSON.stringify(args)}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    return result;
  };
  const ok = (...args) => run(args).stdout;
  const json = (...args) => JSON.parse(ok(...args, '--json'));
  const check = (status = 0, ...args) => JSON.parse(run(['check', ...args, '--json'], status).stdout);
  const bytes = () => read(mapPath);
  const map = () => JSON.parse(bytes());
  const edit = change => { const data = map(); change(data); put(mapPath, `${JSON.stringify(data)}\n`); };
  const link = (source, actions = ['app inspect'], step = 'docs/witness.spec:1-2') => ok('link', source,
    ...actions.flatMap(action => ['--action', action]), ...(step ? ['--step', step] : []), '--why', 'Inspect and assert the synthetic result.');
  const ignore = (path, why = 'Keep this reviewed support code outside the manual mapping minimum.') => ok('ignore', path, '--why', why);
  return { root, sandbox, put, read, run, ok, json, check, bytes, map, edit, link, ignore };
}

test('ignore journey: preserve v1 evidence and metadata, repeat byte-idempotently, and require explicit reason changes', t => {
  const source = '\uFEFF// café\r\n\r\nconst value = 42;\r\n';
  const f = project(t, { 'src/main.js': source });
  const untouched = tree(f.root), empty = f.json('report');
  assert.deepEqual(empty.ignoredSources, []); assert.deepEqual(empty.ignoredFiles, []);
  assert.deepEqual(empty.ignoredTotals, zeroTotals); assert.deepEqual(tree(f.root), untouched);
  f.link('src/main.js:1-3', ['app inspect', 'app inspect']);
  f.ok('comment', 'src/main.js:1');
  f.edit(data => { data.unrelated = { history: ['synthetic original evidence', 17] }; });
  const original = f.map(), before = f.json('report'), witness = f.read('docs/witness.spec');
  assert.equal(Object.hasOwn(original, 'ignoredSources'), false, 'older v1 maps need no new required field');
  f.ignore('src/main.js', 'Reviewed support source.');
  assert.equal(f.map().version, 1);
  assert.deepEqual(f.map().ignoredSources, [{ path: 'src/main.js', why: 'Reviewed support source.' }]);
  assert.deepEqual(f.map().links, original.links); assert.deepEqual(f.map().commentExclusions, original.commentExclusions);
  assert.deepEqual(f.map().unrelated, original.unrelated);
  const saved = f.bytes();
  f.ignore('src/main.js', 'Reviewed support source.'); assert.deepEqual(f.bytes(), saved);
  assert.match(f.run(['ignore', 'src/main.js', '--why', 'A different reason.'], 1).stderr, /unignore|review/i);
  assert.deepEqual(f.bytes(), saved, 'a changed explanation cannot silently overwrite the earlier decision');
  const ignored = f.json('report');
  assert.deepEqual(ignored.totals, zeroTotals); assert.deepEqual(ignored.ignoredTotals, before.totals);
  assert.deepEqual(ignored.ignoredFiles[0].links, before.files[0].links);
  assert.deepEqual(ignored.ignoredFiles[0].traceCounts, before.files[0].traceCounts);
  assert.deepEqual(ignored.ignoredFiles[0].comments, before.files[0].comments);
  f.ok('unignore', 'src/main.js'); f.ignore('src/main.js', 'A different reason.');
  assert.equal(f.map().ignoredSources[0].why, 'A different reason.');
  f.ok('unignore', 'src/main.js');
  const restored = f.json('report');
  assert.deepEqual(restored.totals, before.totals); assert.deepEqual(restored.files, before.files);
  assert.deepEqual(restored.ignoredTotals, zeroTotals); assert.deepEqual(restored.ignoredSources, []);
  assert.deepEqual(f.map().links, original.links); assert.deepEqual(f.map().commentExclusions, original.commentExclusions);
  assert.deepEqual(f.map().unrelated, original.unrelated);
  assert.deepEqual(f.read('src/main.js'), Buffer.from(source)); assert.deepEqual(f.read('docs/witness.spec'), witness);
});

test('ignore journey: exact directory boundaries, overlapping rules and exact unignore restore each original count', t => {
  const f = project(t, { 'src/main.py': 'main\n', 'tests/a.js': 'one\n\nthree\n',
    'tests/nested/b.js': 'nested\n', 'tests-extra/c.js': 'sibling\n', 'tests.py': 'same prefix\n' });
  f.link('tests/a.js:1-3'); f.link('tests/nested/b.js:1');
  const before = f.json('report'), originalLinks = f.map().links;
  f.ignore('tests'); f.ignore('tests/a.js', 'Keep the individual reviewed rule when the directory is restored.');
  assert.deepEqual(f.map().ignoredSources.map(rule => rule.path).sort(), ['tests/', 'tests/a.js']);
  const saved = f.bytes(); f.ignore('tests/'); assert.deepEqual(f.bytes(), saved);
  const report = f.json('report');
  assert.deepEqual(report.files.map(file => file.path), ['src/main.py', 'tests-extra/c.js', 'tests.py']);
  assert.deepEqual(report.ignoredFiles.map(file => file.path), ['tests/a.js', 'tests/nested/b.js']);
  assert.equal(report.ignoredTotals.files, 2); assert.equal(report.ignoredTotals.lines, 3);
  assert.equal(report.ignoredTotals.blankLines, 1); assert.equal(report.ignoredTotals.linked, 3);
  assert.equal(report.totals.lines + report.ignoredTotals.lines, before.totals.lines, 'overlapping rules never count a file twice');
  assert.equal(report.ignoredSources.find(rule => rule.path === 'tests/').matchedFiles, 2);
  assert.equal(report.ignoredSources.find(rule => rule.path === 'tests/a.js').matchedFiles, 1);
  assert.deepEqual(report.ignoredFiles.find(file => file.path === 'tests/a.js').ignoredBy, ['tests/', 'tests/a.js']);
  const check = f.check();
  assert.deepEqual(check.ignoredSources, report.ignoredSources);
  assert.deepEqual(check.ignoredFiles, ['tests/a.js', 'tests/nested/b.js']);
  f.run(['unignore', 'tests'], 1); assert.deepEqual(f.bytes(), saved, 'unignore requires the exact saved trailing slash');
  f.ok('unignore', 'tests/');
  const oneLeft = f.json('report');
  assert.deepEqual(oneLeft.ignoredFiles.map(file => file.path), ['tests/a.js']);
  assert.ok(oneLeft.files.some(file => file.path === 'tests/nested/b.js'));
  f.ok('unignore', 'tests/a.js');
  assert.deepEqual(f.json('report').totals, before.totals); assert.deepEqual(f.json('report').files, before.files);
  assert.deepEqual(f.map().links, originalLinks);
});

test('ignore journey: source, action, sequence and ignored-witness navigation keep selected-scope links intact', t => {
  const f = project(t, { 'src/main.py': 'first\nsecond\n', 'tests/assertions.js': 'open\nassert result\n\n' });
  const actions = ['app open', 'app inspect', 'app inspect'];
  f.link('src/main.py:1-2', actions, 'tests/assertions.js:2');
  f.link('tests/assertions.js:1-3', actions, 'tests/assertions.js:2');
  f.ignore('tests');
  assert.equal(f.check().valid, 2, 'an ignored source remains a valid current witness');
  const whole = f.json('report'), saved = f.bytes();
  for (const selector of [['--action', 'app inspect'], ['--sequence', JSON.stringify(actions)], ['--step', 'tests/assertions.js:2']]) {
    const report = f.json('report', ...selector);
    assert.deepEqual(report.files.map(file => file.path), ['src/main.py']);
    assert.deepEqual(report.ignoredFiles.map(file => file.path), ['tests/assertions.js']);
    assert.deepEqual(report.totals, whole.totals); assert.deepEqual(report.ignoredTotals, whole.ignoredTotals);
    assert.equal(report.files[0].links[0].step.path, 'tests/assertions.js');
    assert.deepEqual(report.ignoredSources, whole.ignoredSources, 'rule inventory is global even for filtered reports');
  }
  const selected = f.json('report', '--source', 'tests/assertions.js:2');
  assert.deepEqual(selected.files, []); assert.deepEqual(selected.totals, zeroTotals);
  assert.equal(selected.ignoredTotals.files, 1); assert.equal(selected.ignoredTotals.lines, 1);
  assert.equal(selected.ignoredTotals.linked, 1); assert.equal(selected.ignoredTotals.withStep, 1);
  assert.deepEqual(selected.ignoredFiles[0].traceCounts, [{ start: 2, end: 2, count: 1, withStepCount: 1 }]);
  assert.equal(selected.ignoredFiles[0].links[0].source.start, 1, 'selection must retain original physical link ranges');
  const blank = f.json('report', '--source', 'tests/assertions.js:3');
  assert.equal(blank.ignoredTotals.lines, 0); assert.equal(blank.ignoredTotals.blankLines, 1);
  assert.equal(blank.ignoredFiles[0].links.length, 1); assert.equal(blank.ignoredFiles[0].traceCounts[0].count, 1);
  const includedOnly = f.json('report', '--source', 'src/main.py:1');
  assert.deepEqual(includedOnly.ignoredTotals, zeroTotals); assert.deepEqual(includedOnly.ignoredFiles, []);
  assert.deepEqual(includedOnly.ignoredSources, whole.ignoredSources);
  const human = f.ok('report', '--source', 'tests/assertions.js:2');
  assert.match(human, /ignored/i); assert.match(human, /tests\/assertions\.js/); assert.match(human, /manual/i);
  assert.deepEqual(f.bytes(), saved, 'all navigation is read-only');
  f.put('tests/assertions.js', 'open\nassert different result\n\n');
  const stale = f.check(1);
  assert.equal(stale.valid, 0); assert.equal(stale.invalid.length, 2);
  assert.ok(stale.invalid.every(row => row.errors.some(error => /step snippet is stale/.test(error))));
  assert.equal(f.json('report', '--source', 'src/main.py:1').invalid.length, 2);
  assert.deepEqual(f.bytes(), saved);
});

test('ignore journey: filtered reports and minimum gates still inspect globally stale and malformed ignored evidence', t => {
  const f = project(t, { 'src/main.py': 'main\n', 'support/other.js': '// reviewed header\nconst value = 1;\n' });
  f.link('src/main.py:1', ['app main']); f.link('support/other.js:2', ['app support']);
  f.ok('comment', 'support/other.js:1'); f.ignore('support');
  assert.equal(f.check(0, '--require-minimum').belowMinimum, 0);
  f.put('support/other.js', '// reviewed header\nconst value = 2;\n');
  f.edit(data => {
    const support = data.links.find(link => link.source.path === 'support/other.js');
    data.links.push({ ...structuredClone(support), id: 'malformed-ignored-link', actions: [''] });
    data.commentExclusions.push({ id: 'malformed-ignored-comment', source: { path: 'support/other.js', start: 0, end: 1 } });
  });
  const saved = f.bytes(), originalSource = f.read('support/other.js');
  for (const selector of [['--source', 'src/main.py:1'], ['--action', 'app main'],
    ['--sequence', '["app main"]'], ['--step', 'docs/witness.spec:2']]) {
    const report = f.json('report', ...selector);
    assert.equal(report.totals.belowMinimum, 0); assert.equal(report.totals.linked, 1);
    assert.equal(report.invalid.length, 2); assert.equal(report.invalidComments.length, 2);
    assert.ok(report.invalid.some(row => row.link.id === 'malformed-ignored-link'));
    assert.ok(report.invalid.some(row => row.errors.some(error => /source snippet is stale/.test(error))));
    assert.ok(report.invalidComments.some(row => row.comment.id === 'malformed-ignored-comment'));
    const human = f.ok('report', ...selector);
    assert.match(human, /INVALID LINK malformed-ignored-link/); assert.match(human, /INVALID COMMENT malformed-ignored-comment/);
  }
  const check = f.check(1, '--require-minimum');
  assert.equal(check.belowMinimum, 0, 'the included minimum passes, but global integrity still fails');
  assert.equal(check.invalid.length, 2); assert.equal(check.invalidComments.length, 2);
  assert.match(f.run(['check', '--require-minimum'], 1).stdout, /ignored/i);
  assert.deepEqual(f.bytes(), saved); assert.deepEqual(f.read('support/other.js'), originalSource);
  f.put('support/other.js', Buffer.from([0xff]));
  f.run(['report', '--source', 'src/main.py:1', '--json'], 1);
  f.run(['check', '--json'], 1);
  assert.deepEqual(f.bytes(), saved, 'ignored inventory is still read, so invalid text cannot be silently hidden');
});

test('ignore journey: reject unsafe paths, symlinks, nonregular targets and invalid CLI reasons without writes', t => {
  const f = project(t); f.link('src/main.py:1-2');
  f.put('src/literal*.js', 'literal\n'); f.put('src/literal?.js', 'literal\n');
  f.put('src/literal[1].js', 'literal\n');
  symlinkSync(join(f.root, 'src/main.py'), join(f.root, 'src/alias.py'));
  symlinkSync(join(f.root, 'src'), join(f.root, 'alias-dir'));
  writeFileSync(join(f.sandbox, 'outside.py'), 'outside\n');
  symlinkSync(join(f.sandbox, 'outside.py'), join(f.root, 'src/outside.py'));
  const invalidPaths = ['', '.', './', '/', '..', '../outside.py', 'src/../src/main.py', './src/main.py',
    'src//main.py', 'src/main.py/', 'src/main.py:1', '\\src\\main.py', 'C:/src/main.py', '.git', '.git/config',
    'missing.py', 'src/*.py', 'src/literal*.js', 'src/literal?.js', 'src/literal[1].js',
    'src/alias.py', 'alias-dir', 'alias-dir/main.py', 'src/outside.py', 'src/main.py\n'];
  if (process.platform !== 'win32') {
    execFileSync('mkfifo', [join(f.root, 'named-pipe')]); invalidPaths.push('named-pipe');
  }
  const before = tree(f.root), outside = readFileSync(join(f.sandbox, 'outside.py'));
  for (const path of invalidPaths) {
    f.run(['ignore', path, '--why', 'Reviewed reason.'], 1); assert.deepEqual(tree(f.root), before, path);
  }
  for (const why of ['', ' ', '\t', 'first\nsecond', 'first\rsecond', 'first\tsecond', 'reason\x7f']) {
    f.run(['ignore', 'src/main.py', '--why', why], 1); assert.deepEqual(tree(f.root), before);
  }
  for (const args of [['ignore'], ['ignore', 'src/main.py'], ['ignore', '--why', 'reason'],
    ['ignore', 'src/main.py', '--why', 'reason', '--why', 'again'], ['ignore', 'src/main.py', '--unknown'],
    ['unignore'], ['unignore', 'src/main.py', '--why', 'reason'], ['unignore', 'not-saved.py']]) {
    f.run(args, 1); assert.deepEqual(tree(f.root), before);
  }
  assert.deepEqual(readFileSync(join(f.sandbox, 'outside.py')), outside);
});

test('ignore journey: preserve unmatched saved rules, remove missing targets exactly and reject malformed sidecars', t => {
  const f = project(t); f.put('notes.txt', 'ordinary non-source text\n'); f.put('retired/old.js', 'old\n');
  f.ignore('notes.txt', 'Non-source review note.'); f.ignore('retired', 'Retired helper scope.');
  rmSync(join(f.root, 'retired'), { recursive: true });
  const unmatched = f.json('report'), saved = f.bytes();
  assert.equal(unmatched.ignoredSources.length, 2);
  assert.ok(unmatched.ignoredSources.every(rule => rule.matchedFiles === 0));
  assert.deepEqual(unmatched.ignoredFiles, []); assert.deepEqual(unmatched.ignoredTotals, zeroTotals);
  assert.equal(f.check().invalid.length, 0, 'a removed target leaves an explicit unmatched scope rule, not stale link evidence');
  const extended = f.json('--include-ext', '.txt', 'report');
  assert.equal(extended.ignoredSources.find(rule => rule.path === 'notes.txt').matchedFiles, 1);
  assert.deepEqual(extended.ignoredFiles.map(file => file.path), ['notes.txt']);
  f.put('retired/new.js', 'new support source\n');
  assert.deepEqual(f.json('report').ignoredFiles.map(file => file.path), ['retired/new.js']);
  assert.deepEqual(f.bytes(), saved, 'new matching files do not rewrite a saved directory rule');
  rmSync(join(f.root, 'retired'), { recursive: true });
  f.run(['unignore', 'retired'], 1); f.run(['unignore', 'unknown/'], 1); assert.deepEqual(f.bytes(), saved);
  f.ok('unignore', 'retired/'); f.ok('unignore', 'notes.txt');
  assert.deepEqual(f.json('report').ignoredSources, []);
  const clean = f.bytes(), malformedRules = [null, {}, 'invalid',
    [null], [42], [[]], [{}], [{ path: 'src/main.py' }], [{ path: 'src/main.py', why: '' }],
    [{ path: 'src/main.py', why: 'multi\nline' }], [{ path: '../outside.py', why: 'unsafe' }],
    [{ path: '.git/', why: 'unsafe' }], [{ path: 'src/*.py', why: 'glob' }],
    [{ path: 'src/main.py', why: 'first' }, { path: 'src/main.py', why: 'second' }]];
  for (const ignoredSources of malformedRules) {
    f.put(mapPath, clean); f.edit(data => { data.ignoredSources = ignoredSources; });
    const malformed = f.bytes();
    f.run(['report', '--json'], 1); f.run(['check', '--json'], 1);
    f.run(['ignore', 'src/main.py', '--why', 'Do not silently repair.'], 1);
    f.run(['unignore', 'src/main.py'], 1);
    assert.deepEqual(f.bytes(), malformed, 'invalid metadata must not be silently discarded or normalized');
  }
  f.put(mapPath, clean);
  assert.equal(f.json('report').totals.lines, 2);
});

test('ignore journey: an empty included scope stays honest while explicit app tests still execute and fail normally', t => {
  const f = project(t, { 'src/calc.mjs': 'export const total = values => values.reduce((sum, value) => sum + value, 0);\n' });
  f.put('tests/runner.mjs', `import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { total } from '../src/calc.mjs';
const args = process.argv.slice(2);
assert.equal(args[0], 'test');
appendFileSync('test-runs.txt', JSON.stringify(args) + '\\n');
assert.equal(total([1, 2]), args.includes('--fail') ? 4 : 3);
assert.equal(total([]), 0);
console.log('Synthetic application assertions passed.');
`);
  f.ok('init', '--app-json', JSON.stringify([process.execPath, 'tests/runner.mjs']));
  const config = f.read('tracer.json'), source = f.read('src/calc.mjs'), runner = f.read('tests/runner.mjs');
  f.ignore('src'); f.ignore('tests');
  assert.equal(existsSync(join(f.root, 'test-runs.txt')), false, 'scope changes never execute app commands');
  const report = f.json('report');
  assert.deepEqual(report.totals, zeroTotals); assert.deepEqual(report.files, []);
  assert.equal(report.ignoredTotals.files, 2); assert.ok(report.ignoredTotals.belowMinimum > 0);
  const minimum = f.check(0, '--require-minimum', '--minimum-traces', '2');
  assert.equal(minimum.belowMinimum, 0); assert.deepEqual(minimum.ignoredTotals, report.ignoredTotals);
  const human = f.ok('report');
  assert.match(human, /0 files; 0 nonblank lines/); assert.match(human, /ignored/i);
  assert.match(human, /not observed execution|not.*execution evidence/i);
  assert.equal(existsSync(join(f.root, 'test-runs.txt')), false, 'reports and minimum gates are not app tests');
  assert.match(f.ok('app', '--', 'test'), /Synthetic application assertions passed/);
  assert.match(f.run(['app', '--', 'test', '--fail'], 1).stderr, /AssertionError/);
  assert.deepEqual(f.read('test-runs.txt').toString().trim().split('\n').map(line => JSON.parse(line)), [['test'], ['test', '--fail']]);
  assert.deepEqual(f.read('tracer.json'), config); assert.deepEqual(f.read('src/calc.mjs'), source); assert.deepEqual(f.read('tests/runner.mjs'), runner);
  f.ok('unignore', 'src/');
  const restored = f.check(1, '--require-minimum');
  assert.equal(restored.belowMinimum, 1, 'restoring unmapped app code restores the manual minimum failure');
  assert.equal(f.json('report').totals.lines, 1); assert.equal(f.json('report').ignoredTotals.files, 1);
});

test('ignore journey: LCOV intervals, current observations and stale measured history remain independent of manual scope', t => {
  const source = 'first\nsecond\n', f = project(t, { 'src/main.py': source });
  const jsonFile = (path, value) => f.put(path, `${JSON.stringify(value, null, 2)}\n`);
  jsonFile('sources.json', { files: [{ path: 'src/main.py', sha256: sha256(source) }] });
  f.put('before.lcov', 'SF:/capture/src/main.py\nDA:1,1\nDA:2,0\nend_of_record\n');
  f.put('after.lcov', 'SF:/capture/src/main.py\nDA:1,3\nDA:2,0\nend_of_record\n');
  const tools = [{ name: 'synthetic-cov', version: '1.0', sha256: sha256('tool'), hashTiming: 'capture' }];
  const sourceManifestSha256 = sha256(f.read('sources.json'));
  const identity = { runId: 'synthetic-ignore-run', buildSha256: sha256('build'), sourceManifestSha256, toolchainSha256: sha256(JSON.stringify(tools)) };
  jsonFile('manifest.json', { version: 1, runId: identity.runId, actions: ['app inspect'], counterMode: 'cumulative',
    counterReset: false, sourceManifestSha256, probeSha256: sha256('probe'), tools, limitations: ['Synthetic interval fixture.'],
    before: { ...identity, sha256: sha256(f.read('before.lcov')) }, after: { ...identity, sha256: sha256(f.read('after.lcov')) } });
  const importArgs = ['measure', 'import', '--before', 'before.lcov', '--after', 'after.lcov', '--manifest', 'manifest.json', '--sources', 'sources.json', '--strip-prefix', '/capture/'];
  assert.equal(f.json(...importArgs).changed, true);
  const measured = f.json('measure', 'report'), dataset = f.read(measuredPath);
  assert.equal(measured.intervals[0].totals.observedLines, 1);
  f.link('src/main.py:1-2'); const links = f.map().links;
  f.ignore('src', 'Manual mapping scope only.');
  assert.deepEqual(f.json('report').totals, zeroTotals);
  assert.deepEqual(f.json('measure', 'report'), measured);
  assert.equal(f.json('measure', 'report', '--source', 'src/main.py:1').intervals[0].totals.observedLines, 1);
  assert.equal(f.json(...importArgs).changed, false); assert.deepEqual(f.read(measuredPath), dataset);
  f.ok('unignore', 'src/'); assert.deepEqual(f.json('measure', 'report'), measured);
  assert.deepEqual(f.map().links, links); assert.deepEqual(f.read(measuredPath), dataset);
  f.ignore('src'); f.put('src/main.py', 'changed\nsecond\n');
  const stale = JSON.parse(f.run(['measure', 'check', '--json'], 1).stdout);
  assert.equal(stale.invalid.length, 1); assert.equal(stale.invalid[0].path, 'src/main.py');
  const history = f.json('measure', 'report').intervals[0];
  assert.equal(history.totals.observedLines, 0); assert.equal(history.totals.historicalIncreasedLines, 1);
  assert.deepEqual(f.read(measuredPath), dataset, 'manual scope changes and staleness never rewrite measured history');
});
