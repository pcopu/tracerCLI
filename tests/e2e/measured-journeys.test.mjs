import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../../bin/tracer.mjs', import.meta.url));
const dataPath = 'docs/testing/code-e2e-measurements.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const source = 'first\nsecond\nthird\nfourth\n';
function project(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tracer-measured-journey-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const put = (path, bytes) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); };
  const jsonFile = (path, value) => put(path, `${JSON.stringify(value, null, 2)}\n`);
  const run = (args, status = 0) => {
    const result = spawnSync(process.execPath, [cli, '--root', root, ...args], { cwd: root, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, TRACER_NO_UPDATE: '1', HOME: root, CODEX_HOME: join(root, '.codex') } });
    assert.ifError(result.error); assert.equal(result.status, status, `${JSON.stringify(args)}\n${result.stdout}\n${result.stderr}`); return result;
  };
  const json = (...args) => JSON.parse(run([...args, '--json']).stdout);
  put('src/app.py', source);
  jsonFile('sources.json', { files: [{ path: 'src/app.py', sha256: sha(source) }] });
  const record = rows => `TN:interval\nSF:/capture/src/app.py\nFN:1,ignored_name\nLF:999\nLH:888\n${rows}\nend_of_record\n`;
  put('before.lcov', record('DA:1,1\nDA:2,0\nDA:3,9'));
  put('after.lcov', record('DA:1,3\nDA:2,0\nDA:3,10'));
  const hash = path => sha(readFileSync(join(root, path)));
  const tools = [{ name: 'example-cov', version: '1.0', sha256: sha('tool'), hashTiming: 'capture' }];
  const sourceManifestSha256 = hash('sources.json');
  const manifest = { version: 1, runId: 'synthetic-run-1', actions: ['app select --index 1', 'app select --index 0'],
    counterMode: 'cumulative', counterReset: false, sourceManifestSha256, probeSha256: sha('probe'), tools,
    limitations: ['Polling overlaps this synthetic interval.'],
    before: { sha256: hash('before.lcov'), runId: 'synthetic-run-1', buildSha256: sha('app'), sourceManifestSha256, toolchainSha256: sha(JSON.stringify(tools)) },
    after: { sha256: hash('after.lcov'), runId: 'synthetic-run-1', buildSha256: sha('app'), sourceManifestSha256, toolchainSha256: sha(JSON.stringify(tools)) } };
  const save = () => jsonFile('manifest.json', manifest); save();
  const args = ['measure', 'import', '--before', 'before.lcov', '--after', 'after.lcov', '--manifest', 'manifest.json', '--sources', 'sources.json', '--strip-prefix', '/capture/'];
  const refresh = () => { manifest.before.sha256 = hash('before.lcov'); manifest.after.sha256 = hash('after.lcov'); save(); };
  const absent = () => assert.equal(existsSync(join(root, 'docs')), false, 'invalid input must not create dataset directories');
  return { root, put, jsonFile, run, json, record, hash, manifest, save, args, refresh, absent };
}

test('measured journey: import a pinned interval, inspect both navigation directions, preserve manual counts and reimport idempotently', t => {
  const f = project(t);
  const before = f.json('report');
  assert.deepEqual(f.json('measure', 'report').intervals, []); f.absent();
  const result = f.json(...f.args); assert.equal(result.changed, true);
  const bytes = readFileSync(join(f.root, dataPath));
  assert.equal(f.json(...f.args).changed, false); assert.deepEqual(readFileSync(join(f.root, dataPath)), bytes);
  const report = f.json('measure', 'report'); assert.equal(report.kind, 'lcov-intervals');
  assert.match(report.notice, /not caused by each action/); assert.match(report.notice, /not a build attestation/);
  const interval = report.intervals[0], file = interval.files[0];
  assert.deepEqual(interval.manifest.actions, f.manifest.actions); assert.equal(interval.manifest.probeSha256, sha('probe'));
  assert.deepEqual(interval.totals, { files: 1, staleFiles: 0, instrumentedLines: 3, currentInstrumentedLines: 3, historicalIncreasedLines: 2, observedLines: 2 });
  assert.deepEqual(file.observedRanges, [[1, 1], [3, 3]]); assert.deepEqual(file.unincreasedRanges, [[2, 2]]);
  assert.deepEqual(file.counters, [{ line: 1, before: 1, after: 3, delta: 2 }, { line: 2, before: 0, after: 0, delta: 0 }, { line: 3, before: 9, after: 10, delta: 1 }]);
  assert.equal(f.json('measure', 'report', '--source', 'src/app.py:2').intervals[0].totals.observedLines, 0);
  assert.equal(f.json('measure', 'report', '--action', f.manifest.actions[0]).intervals[0].manifest.actions.length, 2);
  assert.equal(f.json('measure', 'report', '--sequence', JSON.stringify(f.manifest.actions)).intervals.length, 1);
  assert.equal(f.json('measure', 'report', '--sequence', JSON.stringify([...f.manifest.actions].reverse())).intervals.length, 0);
  assert.deepEqual(f.json('measure', 'check').invalid, []);
  assert.deepEqual(f.json('report').totals, before.totals, 'measurement must not change manual counts');
  f.run(['check', '--require-minimum'], 1);
  assert.equal(existsSync(join(f.root, 'docs/testing/code-e2e-links.json')), false);
});

test('measured journey: zero counters remain unobserved, missing tool hash stays explicit, duplicate pair cannot be relabeled', t => {
  const f = project(t); f.put('after.lcov', readFileSync(join(f.root, 'before.lcov')));
  f.manifest.tools[0] = { name: 'example-cov', version: '1.0', sha256: null, hashTiming: 'unavailable' };
  f.manifest.before.toolchainSha256 = f.manifest.after.toolchainSha256 = sha(JSON.stringify(f.manifest.tools)); f.refresh();
  f.json(...f.args); assert.equal(f.json('measure', 'report').intervals[0].totals.observedLines, 0);
  const bytes = readFileSync(join(f.root, dataPath));
  f.manifest.actions = ['different action']; f.save();
  assert.match(f.run(f.args, 1).stderr, /conflicting provenance/); assert.deepEqual(readFileSync(join(f.root, dataPath)), bytes);
});

test('measured journey: changing or deleting source marks history stale and excludes it from current observations', t => {
  const f = project(t); f.json(...f.args); const bytes = readFileSync(join(f.root, dataPath));
  f.put('src/app.py', `${source}changed\n`);
  const report = f.json('measure', 'report').intervals[0];
  assert.equal(report.totals.staleFiles, 1); assert.equal(report.totals.observedLines, 0);
  assert.deepEqual(report.files[0].observedRanges, []); assert.deepEqual(report.files[0].historicalIncreasedRanges, [[1, 1], [3, 3]]);
  assert.equal(JSON.parse(f.run(['measure', 'check', '--json'], 1).stdout).invalid.length, 1);
  rmSync(join(f.root, 'src/app.py')); assert.equal(f.json('measure', 'report').intervals[0].totals.observedLines, 0);
  assert.deepEqual(readFileSync(join(f.root, dataPath)), bytes, 'read-only stale checks never repair evidence');
});

test('measured journey: reject incompatible provenance and input hashes before writing anything', t => {
  const f = project(t), initial = structuredClone(f.manifest);
  const changes = [
    value => { value.version = 2; }, value => { value.counterReset = true; }, value => { value.counterMode = 'reset'; },
    value => { value.after.runId = 'other-run'; }, value => { value.after.buildSha256 = sha('other'); },
    value => { value.after.toolchainSha256 = sha('other'); }, value => { value.after.sourceManifestSha256 = sha('other'); },
    value => { value.before.sha256 = sha('not the file'); }, value => { value.sourceManifestSha256 = sha('other'); },
    value => { value.probeSha256 = null; }, value => { value.tools[0].hashTiming = 'guessed'; },
    value => { value.actions = []; }, value => { value.extra = 'unknown'; },
  ];
  for (const edit of changes) { const data = structuredClone(initial); edit(data); f.jsonFile('manifest.json', data); f.run(f.args, 1); f.absent(); }
});

test('measured journey: reject malformed, duplicate, reset and mismatched LCOV records atomically', t => {
  const f = project(t), original = readFileSync(join(f.root, 'after.lcov')), invalid = [
    f.record('DA:1,0\nDA:2,0\nDA:3,10'), f.record('DA:1,3\nDA:2,0'),
    f.record('DA:1,3\nDA:2,0\nDA:3,10\nDA:4,1'), f.record('DA:1,3\nDA:1,3\nDA:2,0\nDA:3,10'),
    f.record('DA:1,-1\nDA:2,0\nDA:3,10'), f.record('DA:1,1.5\nDA:2,0\nDA:3,10'),
    f.record('DA:1,9007199254740992\nDA:2,0\nDA:3,10'), f.record('DA:1,3,abc\nDA:2,0\nDA:3,10'),
    `${original}${original}`, String(original).replace('end_of_record\n', ''),
    String(original).replace('/capture/src/app.py', '/wrong/src/app.py'),
    String(original).replace('/capture/src/app.py', '/capture/../outside.py'),
  ];
  for (const value of invalid) { f.put('after.lcov', value); f.refresh(); f.run(f.args, 1); f.absent(); }
});

test('measured journey: missing capture hashes, stale source, out-of-range lines and symlinks fail without side effects', t => {
  const f = project(t);
  f.put('src/app.py', 'changed\n'); f.run(f.args, 1); f.absent(); f.put('src/app.py', source);
  f.put('before.lcov', f.record('DA:5,0')); f.put('after.lcov', f.record('DA:5,1')); f.refresh(); f.run(f.args, 1); f.absent();
  f.put('before.lcov', f.record('DA:1,0')); f.put('after.lcov', f.record('DA:1,1')); f.refresh();
  const sourceManifest = readFileSync(join(f.root, 'sources.json'));
  f.jsonFile('sources.json', { files: [] });
  f.manifest.sourceManifestSha256 = f.manifest.before.sourceManifestSha256 = f.manifest.after.sourceManifestSha256 = f.hash('sources.json'); f.save();
  assert.match(f.run(f.args, 1).stderr, /No capture-time/); f.absent();
  f.put('sources.json', sourceManifest); f.manifest.sourceManifestSha256 = f.manifest.before.sourceManifestSha256 = f.manifest.after.sourceManifestSha256 = f.hash('sources.json'); f.save();
  f.put('copy.py', source); rmSync(join(f.root, 'src/app.py')); symlinkSync(join(f.root, 'copy.py'), join(f.root, 'src/app.py'));
  f.run(f.args, 1); f.absent(); rmSync(join(f.root, 'src/app.py')); f.put('src/app.py', source);
  mkdirSync(join(f.root, 'outside')); symlinkSync(join(f.root, 'outside'), join(f.root, 'docs'));
  f.run(f.args, 1); assert.equal(existsSync(join(f.root, 'outside/testing')), false);
});

test('measured journey: corrupt evidence is rejected, read commands never execute configured app, argument mistakes never create state', t => {
  const f = project(t); f.jsonFile('tracer.json', { version: 1, app: [process.execPath, '-e', "require('fs').writeFileSync('executed','bad')"] });
  f.run(['measure', 'import', '--before', 'before.lcov'], 1); f.absent();
  f.run(['measure', 'report', '--source', 'src/app.py', '--action', 'anything'], 1); f.absent();
  f.json(...f.args); f.json('measure', 'report'); f.json('measure', 'check'); assert.equal(existsSync(join(f.root, 'executed')), false);
  const data = JSON.parse(readFileSync(join(f.root, dataPath))); data.intervals[0].files[0].rows[0][2]++;
  f.jsonFile(dataPath, data); assert.match(f.run(['measure', 'report'], 1).stderr, /digest mismatch/);
  assert.match(f.run(f.args, 1).stderr, /digest mismatch/);
});


test('measured journey: explicit historical import preserves pinned hashes without crediting changed current source', t => {
  const f = project(t); f.put('src/app.py', `${source}changed after capture\n`);
  f.run(f.args, 1); f.absent();
  f.json(...f.args, '--allow-stale');
  const report = f.json('measure', 'report').intervals[0];
  assert.equal(report.files[0].sourceSha256, sha(source));
  assert.equal(report.totals.observedLines, 0); assert.equal(report.totals.staleFiles, 1);
  assert.deepEqual(report.files[0].historicalIncreasedRanges, [[1, 1], [3, 3]]);
  f.run(['measure', 'check'], 1);
});


test('measured journey: keep overlapping intervals separate and preserve the dataset when an exclusive lock exists', t => {
  const f = project(t);
  f.put('before.lcov', f.record('DA:1,1,YWJj+/==\nDA:2,0\nDA:3,9'));
  f.put('after.lcov', f.record('DA:1,3,YWJj+/==\nDA:2,0\nDA:3,10')); f.refresh(); f.json(...f.args);
  const bytes = readFileSync(join(f.root, dataPath));
  f.put('after.lcov', f.record('DA:1,5,YWJj+/==\nDA:2,1\nDA:3,10')); f.refresh();
  f.put(`${dataPath}.lock`, 'owned-by-another-writer\n');
  assert.match(f.run(f.args, 1).stderr, /Another writer or stale lock/);
  assert.deepEqual(readFileSync(join(f.root, dataPath)), bytes);
  rmSync(join(f.root, `${dataPath}.lock`)); f.json(...f.args);
  const report = f.json('measure', 'report');
  assert.equal(report.intervals.length, 2);
  assert.deepEqual(report.intervals.map(interval => interval.totals.observedLines), [2, 3]);
  assert.equal(report.totals, undefined, 'overlapping intervals have no summed observation count');
});


test('measured journey: reserved evidence and work files never become manual sources or witnesses under custom extensions/maps', t => {
  const f = project(t);
  const settings = ['--include-ext', '.json', '--map', 'custom-links.json'];
  const before = f.json(...settings, 'report');
  const gateBefore = JSON.parse(f.run([...settings, 'check', '--require-minimum', '--json'], 1).stdout);
  f.json(...f.args);
  f.put(`${dataPath}.pending.json`, '{}\n');
  const after = f.json(...settings, 'report');
  assert.deepEqual(after.totals, before.totals);
  const gateAfter = JSON.parse(f.run([...settings, 'check', '--require-minimum', '--json'], 1).stdout);
  assert.equal(gateAfter.belowMinimum, gateBefore.belowMinimum);
  assert.equal(after.files.some(file => file.path.startsWith(dataPath)), false);
  for (const artifact of [dataPath, `${dataPath}.pending.json`]) {
    f.run([...settings, 'link', `${artifact}:1`, '--action', 'read evidence', '--why', 'Must not count the measurement artifact.'], 1);
    f.run([...settings, 'link', 'src/app.py:1', '--action', 'app select', '--step', `${artifact}:1`, '--why', 'Must not treat measurements as a test witness.'], 1);
  }
  assert.equal(existsSync(join(f.root, 'custom-links.json')), false);
});


test('measured journey: reject contradictory LCOV test scopes/source versions and malformed metadata placement', t => {
  const f = project(t), original = readFileSync(join(f.root, 'after.lcov'), 'utf8');
  const invalid = [
    original.replace('TN:interval', 'TN:different-test'),
    original.replace('SF:/capture/src/app.py', 'SF:/capture/src/app.py\nVER:other-version'),
    original.replace('TN:interval', 'TN:interval\nTN:duplicate'),
    original.replace('DA:1,3', 'TN:misplaced\nDA:1,3'),
    original.replace('DA:2,0', 'VER:late-version\nDA:2,0'),
    original.replace('SF:/capture/src/app.py', 'SF:/capture/src/app.py\nVER:a\nVER:a'),
    `${original}TN:orphan\n`,
  ];
  for (const value of invalid) { f.put('after.lcov', value); f.refresh(); f.run(f.args, 1); f.absent(); }
  f.put('before.lcov', f.record('DA:1,1\nDA:2,0\nDA:3,9').replace('SF:/capture/src/app.py', 'SF:/capture/src/app.py\nVER:matching-version'));
  f.put('after.lcov', original.replace('SF:/capture/src/app.py', 'SF:/capture/src/app.py\nVER:matching-version')); f.refresh();
  f.json(...f.args); assert.equal(f.json('measure', 'report').intervals[0].totals.observedLines, 2);
});

for (const legacy of [false, true]) {
  test(`measured journey: retain byte-identical independent runs alongside ${legacy ? 'legacy' : 'current'} evidence without relabeling`, t => {
    const f = project(t), firstManifest = structuredClone(f.manifest);
    const manual = f.json('report').totals;
    f.json(...f.args);
    const dataset = JSON.parse(readFileSync(join(f.root, dataPath)));
    if (legacy) {
      // Reproduce the version-1 identity and payload emitted before run-scoped IDs.
      const interval = dataset.intervals[0];
      interval.id = sha(JSON.stringify([f.manifest.before.sha256, f.manifest.after.sha256, f.manifest.before.buildSha256]));
      const { payloadSha256, ...payload } = interval;
      interval.payloadSha256 = sha(JSON.stringify(payload));
      f.jsonFile(dataPath, dataset);
    }
    const firstInterval = dataset.intervals[0], original = readFileSync(join(f.root, dataPath));
    const repeat = f.json(...f.args);
    assert.equal(repeat.changed, false); assert.equal(repeat.id, firstInterval.id);
    assert.deepEqual(readFileSync(join(f.root, dataPath)), original, 'exact reimport preserves existing identity and bytes');
    f.manifest.runId = f.manifest.before.runId = f.manifest.after.runId = 'synthetic-run-2'; f.save();
    const second = f.json(...f.args);
    assert.equal(second.changed, true); assert.notEqual(second.id, firstInterval.id);
    assert.equal(f.json(...f.args).changed, false);
    const afterRepeat = readFileSync(join(f.root, dataPath)), stored = JSON.parse(afterRepeat);
    assert.deepEqual(stored.intervals[0], firstInterval, 'adding a run never rewrites historical evidence');
    const secondManifest = structuredClone(f.manifest);
    for (const manifest of [firstManifest, secondManifest]) {
      f.jsonFile('manifest.json', manifest);
      const reimport = f.json(...f.args);
      assert.equal(reimport.changed, false);
      assert.equal(reimport.id, manifest.runId === firstManifest.runId ? firstInterval.id : second.id);
      for (const edit of [
        value => { value.actions = ['different action']; },
        value => { value.probeSha256 = sha('different probe'); },
        value => {
          value.tools[0].version = 'different version';
          value.before.toolchainSha256 = value.after.toolchainSha256 = sha(JSON.stringify(value.tools));
        },
      ]) {
        const changed = structuredClone(manifest); edit(changed); f.jsonFile('manifest.json', changed);
        assert.match(f.run(f.args, 1).stderr, /conflicting provenance or labels/);
      }
      f.put('manifest.json', JSON.stringify(manifest));
      assert.match(f.run(f.args, 1).stderr, /conflicting provenance or labels/, 'original manifest byte hash stays pinned');
    }
    assert.deepEqual(readFileSync(join(f.root, dataPath)), afterRepeat, 'reimports and rejected relabels leave both runs intact');
    const report = f.json('measure', 'report', '--sequence', JSON.stringify(firstManifest.actions));
    assert.deepEqual(report.intervals.map(interval => interval.manifest.runId), ['synthetic-run-1', 'synthetic-run-2']);
    assert.deepEqual(report.intervals.map(interval => interval.totals.observedLines), [2, 2]);
    assert.equal(report.totals, undefined, 'independent intervals do not create a summed observation count');
    assert.deepEqual(f.json('measure', 'check').invalid, []);
    assert.deepEqual(f.json('report').totals, manual, 'repeat measurements never change manual counts');
    // A mixed legacy/current encoding must not disguise a duplicate occurrence.
    const duplicate = structuredClone(firstInterval);
    const contentId = sha(JSON.stringify([firstManifest.before.sha256, firstManifest.after.sha256, firstManifest.before.buildSha256]));
    duplicate.id = legacy ? sha(JSON.stringify([contentId, firstManifest.runId])) : contentId;
    const { payloadSha256, ...payload } = duplicate;
    duplicate.payloadSha256 = sha(JSON.stringify(payload));
    stored.intervals.push(duplicate); f.jsonFile(dataPath, stored);
    const corrupt = readFileSync(join(f.root, dataPath));
    assert.match(f.run(['measure', 'report'], 1).stderr, /Duplicate measured interval identity/);
    f.jsonFile('manifest.json', secondManifest);
    assert.match(f.run(f.args, 1).stderr, /Duplicate measured interval identity/);
    assert.deepEqual(readFileSync(join(f.root, dataPath)), corrupt);
  });
}

test('measured journey: blank exclusion changes only manual totals, never captured LCOV counters', t => {
  const f = project(t), current = '# counted comment\n \t\nx = 1\n\n';
  f.put('src/app.py', current);
  f.jsonFile('sources.json', { files: [{ path: 'src/app.py', sha256: sha(current) }] });
  f.manifest.sourceManifestSha256 = f.manifest.before.sourceManifestSha256 = f.manifest.after.sourceManifestSha256 = f.hash('sources.json');
  f.put('after.lcov', f.record('DA:1,3\nDA:2,2\nDA:3,10')); f.refresh();
  const manual = f.json('report').totals;
  assert.equal(manual.physicalLines, 4); assert.equal(manual.blankLines, 2); assert.equal(manual.lines, 2);
  f.json(...f.args);
  const before = readFileSync(join(f.root, dataPath)), measured = f.json('measure', 'report').intervals[0];
  assert.equal(measured.totals.instrumentedLines, 3); assert.equal(measured.totals.observedLines, 3);
  assert.deepEqual(measured.files[0].counters[1], { line: 2, before: 0, after: 2, delta: 2 });
  assert.deepEqual(measured.files[0].observedRanges, [[1, 3]], 'supplied instrumented blank/comment lines are not reclassified');
  assert.equal(f.json(...f.args).changed, false); assert.deepEqual(readFileSync(join(f.root, dataPath)), before);
  assert.deepEqual(f.json('report').totals, manual); assert.deepEqual(f.json('measure', 'check').invalid, []);
});

test('measured journey: reject unsafe external input files before creating evidence and recover with the original inputs', t => {
  const f = project(t), withBefore = path => f.args.map((arg, index) => index === 3 ? path : arg);
  const reject = (path, message) => { assert.match(f.run(withBefore(path), 1).stderr, message); f.absent(); };
  reject(' ', /Provide an input file path/);
  mkdirSync(join(f.root, 'input-directory'));
  reject('input-directory', /regular unsymlinked files/);
  symlinkSync(join(f.root, 'before.lcov'), join(f.root, 'input-link.lcov'));
  reject('input-link.lcov', /regular unsymlinked files/);
  mkdirSync(join(f.root, 'capture-inputs')); f.put('capture-inputs/before.lcov', readFileSync(join(f.root, 'before.lcov')));
  symlinkSync(join(f.root, 'capture-inputs'), join(f.root, 'input-alias'));
  reject('input-alias/before.lcov', /regular unsymlinked files/);
  f.put('invalid-input.lcov', Buffer.from([0xff]));
  reject('invalid-input.lcov', /encoded data.*valid|valid.*UTF-8/i);
  f.put('invalid-input.lcov', 'SF:src/app.py\nDA:1,0\0\nend_of_record\n');
  reject('invalid-input.lcov', /UTF-8 text without NUL/);
  f.put('invalid-input.lcov', Buffer.alloc(64 * 1024 * 1024 + 1, 32));
  reject('invalid-input.lcov', /no larger than 64 MiB/);
  assert.equal(f.json(...f.args).changed, true);
  assert.equal(f.json('measure', 'report').intervals[0].totals.observedLines, 2);
  assert.deepEqual(f.json('measure', 'check').invalid, []);
});

test('measured journey: validate explicit prefixes and accept repository-relative LCOV without a prefix', t => {
  const f = project(t);
  for (const prefix of [' ', '/capture', '/capture\\/', '/capture/../', '/capture/./']) {
    const args = [...f.args.slice(0, -1), prefix];
    assert.match(f.run(args, 1).stderr, /--strip-prefix must be an exact path prefix/); f.absent();
  }
  for (const path of ['before.lcov', 'after.lcov']) {
    f.put(path, readFileSync(join(f.root, path), 'utf8').replace('/capture/src/app.py', 'src/app.py'));
  }
  f.refresh();
  const args = f.args.slice(0, -2), imported = f.json(...args);
  assert.equal(imported.changed, true);
  const bytes = readFileSync(join(f.root, dataPath)), stored = JSON.parse(bytes);
  assert.equal(stored.intervals[0].stripPrefix, '');
  assert.equal(stored.intervals[0].files[0].path, 'src/app.py');
  assert.equal(f.json(...args).changed, false);
  assert.deepEqual(readFileSync(join(f.root, dataPath)), bytes);
  assert.equal(f.json('measure', 'report').intervals[0].totals.observedLines, 2);
});

test('measured journey: report attribution and instrumentation limits without creating or rewriting evidence', t => {
  const f = project(t), notice = 'LCOV COUNTER DELTAS: observed during the whole recorded interval, not caused by each action. Supplied provenance is not a build attestation or proof of correctness. Manual links and their minimums are separate.';
  const limitations = [
    'Background activity, transport and snapshot work may overlap the interval.',
    'Snapshots may not be globally atomic; nonnegative deltas alone cannot prove consistency.',
    'Only supplied instrumented line records are represented; absent lines are unknown.',
    'A counter increase does not establish test assertions, branch coverage or causal attribution.',
    'Only DA line counters are used; function, branch, LF and LH exporter summaries are not denominators.',
  ];
  const empty = f.json('measure', 'report');
  assert.deepEqual(empty, { kind: 'lcov-intervals', notice, limitations, intervals: [] }); f.absent();
  const imported = f.json(...f.args); assert.equal(imported.notice, notice);
  const bytes = readFileSync(join(f.root, dataPath)), stored = JSON.parse(bytes);
  assert.equal(stored.kind, 'lcov-intervals'); assert.equal(stored.intervals.length, 1);
  const report = f.json('measure', 'report');
  assert.equal(report.notice, notice); assert.deepEqual(report.limitations, limitations);
  assert.equal(report.intervals[0].totals.instrumentedLines, 3, 'LCOV LF/LH summaries do not replace the supplied DA denominator');
  assert.equal(f.json('measure', 'check').notice, notice);
  assert.deepEqual(readFileSync(join(f.root, dataPath)), bytes);
  assert.equal(existsSync(join(f.root, 'docs/testing/code-e2e-links.json')), false);
});

test('measured journey: human output distinguishes import, replay, current, zero-delta and stale intervals', t => {
  const f = project(t), notice = f.json('measure', 'report').notice;
  assert.equal(f.run(['measure', 'check']).stdout, `${notice}\n0 interval(s); 0 stale source file(s).\n`); f.absent();
  const imported = f.run(f.args).stdout, stored = JSON.parse(readFileSync(join(f.root, dataPath)));
  const id = stored.intervals[0].id, actions = JSON.stringify(f.manifest.actions);
  assert.equal(imported, `${notice}\nImported interval: ${id}\n`);
  const bytes = readFileSync(join(f.root, dataPath));
  assert.equal(f.run(f.args).stdout, `${notice}\nAlready imported interval: ${id}\n`);
  const heading = `${notice}\nINTERVAL ${id} run synthetic-run-1: ${actions}\n`;
  assert.equal(f.run(['measure', 'report']).stdout, `${heading}  src/app.py: 2/3 instrumented lines increased; current\n    Observed: 1, 3\n`);
  assert.equal(f.run(['measure', 'report', '--source', 'src/app.py:2']).stdout,
    `${heading}  src/app.py: 0/1 instrumented lines increased; current\n    Observed: none\n`);
  assert.equal(f.run(['measure', 'check']).stdout, `${notice}\n1 interval(s); 0 stale source file(s).\n`);
  assert.deepEqual(readFileSync(join(f.root, dataPath)), bytes);
  f.put('after.lcov', f.record('DA:1,3\nDA:2,1\nDA:3,10')); f.refresh();
  f.run(f.args);
  const current = readFileSync(join(f.root, dataPath)), both = JSON.parse(current);
  const second = both.intervals[1].id;
  assert.match(f.run(['measure', 'report']).stdout,
    new RegExp(`INTERVAL ${second} run synthetic-run-1: [^\\n]+\\n  src/app\\.py: 3/3 instrumented lines increased; current\\n    Observed: 1-3\\n$`));
  f.put('src/app.py', `${source}changed after import\n`);
  const stale = f.run(['measure', 'report']).stdout;
  assert.equal((stale.match(/0\/3 instrumented lines increased; stale\n    Observed: none/g) ?? []).length, 2);
  const diagnostic = 'Source bytes are stale against the pinned capture manifest.';
  assert.equal(f.run(['measure', 'check'], 1).stdout,
    `${notice}\n2 interval(s); 2 stale source file(s).\nSTALE src/app.py: ${diagnostic}\nSTALE src/app.py: ${diagnostic}\n`);
  assert.deepEqual(readFileSync(join(f.root, dataPath)), current, 'human reads and failing checks retain both historical intervals');
});

test('measured journey: reject invalid command selectors without state and preserve evidence on empty lookups', t => {
  const f = project(t), invalid = [
    [['measure'], /Use measure import, report, check or union/],
    [['measure', 'unknown'], /Use measure import, report, check or union/],
    [['measure', 'report', '--unknown'], /Unknown or duplicate measure report option/],
    [['measure', 'report', '--json', '--json'], /Unknown or duplicate measure report option/],
    [['measure', 'import', '--before'], /--before requires a value/],
    [['measure', 'import', '--before', 'before.lcov'], /requires --before, --after, --manifest and --sources/],
    [[...f.args, '--before', 'before.lcov'], /Unknown or duplicate measure import option/],
    [['measure', 'check', '--source', 'src/app.py'], /Unknown or duplicate measure check option/],
    [['measure', 'report', '--source', 'src/app.py', '--action', 'app inspect'], /accepts one selector/],
    [['measure', 'report', '--sequence', 'not-json'], /JSON/],
    [['measure', 'report', '--sequence', '[]'], /at least one ordered CLI action/],
    [['measure', 'report', '--action', ' '], /nonempty single-line description/],
    [['measure', 'report', '--source', '../outside.py'], /Expected a repository-relative path/],
  ];
  for (const [args, message] of invalid) { assert.match(f.run(args, 1).stderr, message); f.absent(); }
  f.json(...f.args);
  const bytes = readFileSync(join(f.root, dataPath));
  for (const selector of [['--source', 'src/missing.py'], ['--source', 'src/app.py:4'],
    ['--action', 'unrecorded action'], ['--sequence', '["unrecorded action"]']]) {
    assert.deepEqual(f.json('measure', 'report', ...selector).intervals, []);
  }
  for (const [args, message] of invalid) assert.match(f.run(args, 1).stderr, message);
  assert.deepEqual(readFileSync(join(f.root, dataPath)), bytes, 'failed commands and empty lookups never alter existing captured evidence');
  assert.deepEqual(f.json('measure', 'check').invalid, []);
});

test('measured journey: reject incomplete or unsupported LCOV framing and the record limit before persistence', t => {
  const f = project(t), invalid = [
    ['', /complete nonempty source records/],
    ['DA:1,0\n', /DA appears outside a source record/],
    ['VER:version\n', /misplaced LCOV VER/],
    ['end_of_record\n', /Empty or unmatched LCOV source record/],
    ['SF:/capture/src/app.py\nend_of_record\n', /Empty or unmatched LCOV source record/],
    ['SF:/capture/src/app.py\nSF:/capture/other.py\n', /missing end_of_record/],
    ['SF:/capture/src/app.py\nDA:1,0\nUNKNOWN:payload\nend_of_record\n', /Unsupported or malformed LCOV record/],
    ['SF:/capture/.git/config\nDA:1,0\nend_of_record\n', /unsafe LCOV source path/],
    [`SF:/capture/${dataPath}\nDA:1,0\nend_of_record\n`, /unsafe LCOV source path/],
  ];
  for (const [input, message] of invalid) {
    f.put('after.lcov', input); f.refresh(); assert.match(f.run(f.args, 1).stderr, message); f.absent();
  }
  const rows = Array.from({ length: 500001 }, (_, index) => `DA:${index + 1},0`).join('\n');
  f.put('after.lcov', `SF:/capture/src/app.py\n${rows}\nend_of_record\n`); f.refresh();
  assert.match(f.run(f.args, 1).stderr, /500,000 line-record limit/); f.absent();
  f.put('after.lcov', f.record('DA:1,3\nDA:2,0\nDA:3,10')); f.refresh();
  assert.equal(f.json(...f.args).changed, true);
  assert.equal(f.json('measure', 'report').intervals[0].totals.observedLines, 2);
});

test('measured journey: compact new writes preserve payloads and leave legacy pretty bytes intact until another interval is imported', t => {
  const f = project(t);
  f.json(...f.args);
  const initialBytes = readFileSync(join(f.root, dataPath), 'utf8'), initial = JSON.parse(initialBytes);
  assert.equal(initialBytes, `${JSON.stringify(initial)}\n`, 'measurement storage omits indentation but keeps a final newline');
  assert.ok(Buffer.byteLength(initialBytes) < Buffer.byteLength(`${JSON.stringify(initial, null, 2)}\n`));
  const initialReport = f.json('measure', 'report');
  f.jsonFile(dataPath, initial);
  const prettyBytes = readFileSync(join(f.root, dataPath));
  assert.deepEqual(f.json('measure', 'report'), initialReport);
  assert.deepEqual(f.json('measure', 'check').invalid, []);
  assert.equal(f.json(...f.args).changed, false);
  assert.deepEqual(readFileSync(join(f.root, dataPath)), prettyBytes, 'read commands and exact reimport never reformat legacy evidence');

  f.put('after.lcov', f.record('DA:1,5\nDA:2,1\nDA:3,10')); f.refresh();
  const inputs = ['before.lcov', 'after.lcov', 'manifest.json', 'sources.json'].map(path => [path, f.hash(path)]);
  assert.equal(f.json(...f.args).changed, true);
  const compactBytes = readFileSync(join(f.root, dataPath), 'utf8'), stored = JSON.parse(compactBytes);
  assert.equal(compactBytes, `${JSON.stringify(stored)}\n`);
  assert.equal(stored.intervals.length, 2);
  assert.deepEqual(stored.intervals[0], initial.intervals[0], 'compaction preserves every original identity, provenance field and counter triple');
  assert.deepEqual(stored.intervals[1].files[0].rows, [[1, 1, 5], [2, 0, 1], [3, 9, 10]]);
  for (const interval of stored.intervals) {
    const { payloadSha256, ...payload } = interval;
    assert.equal(payloadSha256, sha(JSON.stringify(payload)), 'stored payload hashes still bind the exact original payload encoding');
  }
  assert.equal(f.json(...f.args).changed, false);
  assert.equal(readFileSync(join(f.root, dataPath), 'utf8'), compactBytes);
  assert.deepEqual(f.json('measure', 'check').invalid, []);
  assert.deepEqual(inputs.map(([path]) => [path, f.hash(path)]), inputs, 'imports never rewrite raw capture inputs');

  f.json('config', '--minimum-traces', '2');
  const manualBytes = readFileSync(join(f.root, 'docs/testing/code-e2e-links.json'), 'utf8');
  assert.equal(manualBytes, `${JSON.stringify(JSON.parse(manualBytes), null, 2)}\n`, 'manual sidecars retain their existing readable format');
});

test('measured journey: the exact UTF-8 output cap includes the final newline and rejects growth without changing evidence', t => {
  const f = project(t), limit = 64 * 1024 * 1024;
  f.json(...f.args);
  const original = readFileSync(join(f.root, dataPath));
  f.manifest.runId = f.manifest.before.runId = f.manifest.after.runId = 'synthetic-run-2';
  f.manifest.limitations = ['é']; f.save(); f.json(...f.args);
  const baselineSize = readFileSync(join(f.root, dataPath)).length;
  // Derive the output envelope from real CLI imports, then restore the smaller fixture.
  // Hash fields have fixed widths; only this synthetic limitation's UTF-8 bytes grow.
  f.put(dataPath, original);
  f.manifest.limitations[0] += 'x'.repeat(limit + 1 - baselineSize); f.save();
  assert.ok(readFileSync(join(f.root, 'manifest.json')).length < limit, 'input remains below the independent input cap');
  const inputs = ['before.lcov', 'after.lcov', 'manifest.json', 'sources.json'].map(path => [path, f.hash(path)]);
  assert.match(f.run(f.args, 1).stderr, /Measurement dataset exceeds 64 MiB/);
  assert.deepEqual(readFileSync(join(f.root, dataPath)), original, 'failed output growth preserves the complete existing dataset');
  assert.deepEqual(inputs.map(([path]) => [path, f.hash(path)]), inputs, 'failed import preserves every raw capture input');
  assert.equal(existsSync(join(f.root, `${dataPath}.lock`)), false, 'failed output guard releases its exclusive lock');

  f.manifest.limitations[0] = f.manifest.limitations[0].slice(0, -1); f.save();
  assert.equal(f.json(...f.args).changed, true, 'one byte less fits the exact output limit');
  const accepted = readFileSync(join(f.root, dataPath));
  assert.equal(accepted.length, limit);
  assert.equal(accepted.at(-1), 10, 'the accepted limit includes the final newline');
  assert.deepEqual(JSON.parse(accepted).intervals[0], JSON.parse(original).intervals[0]);
  const checked = f.json('measure', 'check');
  assert.equal(checked.intervals, 2); assert.deepEqual(checked.invalid, [], 'a maximum-size dataset remains readable and valid');
});

test('measured union journey: overlap and duplicate IDs preserve one denominator, explicit outcomes and marginal novelty', t => {
  const a = project(t), b = project(t);
  a.json(...a.args);
  b.manifest.runId = b.manifest.before.runId = b.manifest.after.runId = 'second-journey';
  b.put('after.lcov', b.record('DA:1,1\nDA:2,1\nDA:3,9')); b.refresh(); b.json(...b.args);
  const first = JSON.parse(readFileSync(join(a.root, dataPath))).intervals[0];
  const second = JSON.parse(readFileSync(join(b.root, dataPath))).intervals[0];
  a.jsonFile('first-evidence.json', { status: 'passed', synthetic: true });
  a.jsonFile('second-evidence.json', { status: 'failed', synthetic: true });
  a.jsonFile('outcomes.json', { version: 1, intervals: [
    { id: first.id, journey: 'first', status: 'passed', evidence: { path: 'first-evidence.json', sha256: a.hash('first-evidence.json') } },
    { id: second.id, journey: 'second', status: 'failed', evidence: { path: 'second-evidence.json', sha256: a.hash('second-evidence.json') } },
  ] });
  const args = ['measure', 'union', '--input-root', a.root, '--input-root', b.root, '--input-root', a.root, '--outcomes', 'outcomes.json', '--json'];
  const before = [readFileSync(join(a.root, dataPath)), readFileSync(join(b.root, dataPath))];
  const response = a.run(args); assert.equal(response.stderr, ''); const union = JSON.parse(response.stdout);
  assert.equal(union.intervals.unique, 2); assert.equal(union.intervals.duplicates, 1);
  assert.deepEqual(union.intervals.outcomes, { passed: 1, failed: 1, unknown: 0 });
  assert.equal(union.allObserved.instrumentedLines, 3); assert.equal(union.allObserved.observedLines, 3);
  assert.equal(union.passedOnlyKnown.observedLines, 2); assert.equal(union.passedOnlyKnown.gapLines, 1);
  assert.deepEqual(union.files[0].allObserved.observedRanges, [[1, 3]]);
  assert.deepEqual(union.files[0].passedOnlyKnown.gapRanges, [[2, 2]]);
  assert.deepEqual(union.journeys.map(row => [row.journey, row.allObserved.marginalLines, row.passedOnlyKnown.marginalLines]), [['first', 2, 2], ['second', 1, 0]]);
  assert.equal(union.outcomes.kind, 'producer-declared');
  assert.deepEqual([readFileSync(join(a.root, dataPath)), readFileSync(join(b.root, dataPath))], before);
  assert.equal(existsSync(join(a.root, dataPath + '.lock')), false);
  const unknown = a.json('measure', 'union', '--input-root', a.root);
  assert.equal(unknown.intervals.outcomes.unknown, 1); assert.equal(unknown.passedOnlyKnown.observedLines, 0);
});

test('measured union journey: reject incompatible scope, conflicting duplicate IDs, stale sources and unbound outcomes', t => {
  const a = project(t), b = project(t); a.json(...a.args);
  b.manifest.runId = b.manifest.before.runId = b.manifest.after.runId = 'other-run'; b.save(); b.json(...b.args);
  const args = ['measure', 'union', '--input-root', a.root, '--input-root', b.root, '--json'];
  const original = readFileSync(join(b.root, dataPath));
  const change = edit => {
    const data = JSON.parse(original); edit(data.intervals[0]);
    const { payloadSha256, ...payload } = data.intervals[0]; data.intervals[0].payloadSha256 = sha(JSON.stringify(payload));
    b.jsonFile(dataPath, data);
  };
  change(interval => { interval.manifest.probeSha256 = sha('different-probe'); });
  assert.match(a.run(args, 1).stderr, /Incompatible measurement scope/);
  change(interval => { interval.files[0].rows.pop(); });
  assert.match(a.run(args, 1).stderr, /Incompatible measurement scope/);
  // Rebuild a valid same-ID record with conflicting metadata, retaining its run identity.
  const duplicate = JSON.parse(readFileSync(join(a.root, dataPath)));
  duplicate.intervals[0].manifest.limitations.push('A differing supplied limitation.');
  const { payloadSha256, ...payload } = duplicate.intervals[0]; duplicate.intervals[0].payloadSha256 = sha(JSON.stringify(payload));
  b.jsonFile(dataPath, duplicate);
  assert.match(a.run(args, 1).stderr, /Conflicting duplicate interval/);
  const changedSource = 'altered\nsecond\nthird\nfourth\n';
  b.put('src/app.py', changedSource); change(interval => { interval.files[0].sha256 = sha(changedSource); });
  assert.match(a.run(args, 1).stderr, /Incompatible measurement scope/);
  b.put(dataPath, original); b.put('src/app.py', 'changed\n');
  assert.match(a.run(args, 1).stderr, /stale|outside the source/i);
  const id = JSON.parse(readFileSync(join(a.root, dataPath))).intervals[0].id;
  a.jsonFile('evidence.json', { status: 'passed' });
  a.jsonFile('bad-outcomes.json', { version: 1, intervals: [{ id, journey: 'example', status: 'passed', evidence: { path: 'evidence.json', sha256: sha('wrong') } }] });
  assert.match(a.run(['measure', 'union', '--input-root', a.root, '--outcomes', 'bad-outcomes.json', '--json'], 1).stderr, /evidence.*digest/i);
  a.jsonFile('bad-outcomes.json', { version: 1, intervals: [{ id: sha('unknown-id'), journey: 'example', status: 'passed', evidence: { path: 'evidence.json', sha256: a.hash('evidence.json') } }] });
  assert.match(a.run(['measure', 'union', '--input-root', a.root, '--outcomes', 'bad-outcomes.json', '--json'], 1).stderr, /unknown or duplicate/);
  a.run(['measure', 'union'], 1);
  a.run(['measure', 'union', '--input-root', a.root, '--outcomes', 'bad-outcomes.json', '--outcomes', 'bad-outcomes.json'], 1);
});

test('measured union journey: explicit source-lines mode retains distinct producer identities across matching line universes', t => {
  const a = project(t), b = project(t); a.json(...a.args);
  b.manifest.runId = b.manifest.before.runId = b.manifest.after.runId = 'new-build';
  b.manifest.before.buildSha256 = b.manifest.after.buildSha256 = sha('second-build');
  b.manifest.probeSha256 = sha('second-probe'); b.save(); b.json(...b.args);
  const args = ['measure', 'union', '--input-root', a.root, '--input-root', b.root];
  assert.match(a.run([...args, '--json'], 1).stderr, /Incompatible measurement scope/);
  const response = a.run([...args, '--scope', 'source-lines', '--json']);
  assert.equal(response.stderr, ''); const result = JSON.parse(response.stdout);
  assert.equal(result.scope.mode, 'source-lines');
  assert.equal(result.provenanceGroups.length, 2);
  assert.deepEqual(result.provenanceGroups.map(group => group.buildSha256), [a.manifest.before.buildSha256, b.manifest.before.buildSha256]);
  assert.equal(result.allObserved.instrumentedLines, 3);
  assert.equal(result.allObserved.observedLines, 2);
  const original = JSON.parse(readFileSync(join(b.root, dataPath)));
  const baseline = structuredClone(original);
  original.intervals[0].files[0].rows.pop();
  const { payloadSha256, ...payload } = original.intervals[0]; original.intervals[0].payloadSha256 = sha(JSON.stringify(payload));
  b.jsonFile(dataPath, original);
  assert.match(a.run([...args, '--scope', 'source-lines', '--json'], 1).stderr, /Incompatible measurement scope/);
  const changedSource = 'altered\nsecond\nthird\nfourth\n'; b.put('src/app.py', changedSource);
  baseline.intervals[0].files[0].sha256 = sha(changedSource);
  const { payloadSha256: previousHash, ...changedPayload } = baseline.intervals[0];
  baseline.intervals[0].payloadSha256 = sha(JSON.stringify(changedPayload)); b.jsonFile(dataPath, baseline);
  assert.match(a.run([...args, '--scope', 'source-lines', '--json'], 1).stderr, /Incompatible measurement scope/);
  a.run([...args, '--scope', 'unknown', '--json'], 1);
});

test('measured union journey: legacy and run-scoped IDs for one capture deduplicate with preserved aliases and bound outcomes', t => {
  const a = project(t), b = project(t); a.json(...a.args);
  const current = JSON.parse(readFileSync(join(a.root, dataPath))), modern = current.intervals[0].id;
  const legacy = sha(JSON.stringify([current.intervals[0].manifest.before.sha256, current.intervals[0].manifest.after.sha256, current.intervals[0].manifest.before.buildSha256]));
  current.intervals[0].id = legacy;
  const { payloadSha256, ...payload } = current.intervals[0]; current.intervals[0].payloadSha256 = sha(JSON.stringify(payload)); b.jsonFile(dataPath, current);
  a.jsonFile('evidence.json', { synthetic: true, status: 'passed' });
  const evidence = { path: 'evidence.json', sha256: a.hash('evidence.json') };
  a.jsonFile('outcomes.json', { version: 1, intervals: [{ id: legacy, journey: 'one-capture', status: 'passed', evidence }] });
  const args = ['measure', 'union', '--input-root', a.root, '--input-root', b.root, '--outcomes', 'outcomes.json'];
  const result = a.json(...args);
  assert.equal(result.intervals.unique, 1); assert.equal(result.intervals.duplicates, 1);
  assert.deepEqual(result.intervals.aliases, [{ id: modern, storedIds: [modern, legacy] }]);
  assert.equal(result.passedOnlyKnown.observedLines, 2);
  assert.deepEqual(result.journeys[0].intervalIds, [modern]);
  a.jsonFile('outcomes.json', { version: 1, intervals: [{ id: legacy, journey: 'one-capture', status: 'passed', evidence }, { id: modern, journey: 'one-capture', status: 'passed', evidence }] });
  const agreement = a.json(...args);
  assert.equal(agreement.intervals.outcomes.passed, 1);
  assert.equal(agreement.outcomes.declarations.length, 2);
  a.jsonFile('outcomes.json', { version: 1, intervals: [{ id: legacy, journey: 'one-capture', status: 'passed', evidence }, { id: modern, journey: 'one-capture', status: 'failed', evidence }] });
  assert.match(a.run([...args, '--json'], 1).stderr, /Conflicting.*outcome/);
});

test('measured where journey: reusable capture set answers current source ranges with exact observed scenarios and unknown instrumentation', t => {
  const a = project(t), b = project(t); a.json(...a.args);
  b.manifest.runId = b.manifest.before.runId = b.manifest.after.runId = 'second-capture';
  b.put('after.lcov', b.record('DA:1,1\nDA:2,1\nDA:3,9')); b.refresh(); b.json(...b.args);
  const first = JSON.parse(readFileSync(join(a.root, dataPath))).intervals[0];
  a.jsonFile('evidence.json', { synthetic: true, status: 'passed' });
  a.jsonFile('outcomes.json', { version: 1, intervals: [{ id: first.id, journey: 'first-route', status: 'passed', evidence: { path: 'evidence.json', sha256: a.hash('evidence.json') } }] });
  a.jsonFile('captures.json', { version: 1, inputRoots: ['.', b.root], outcomes: 'outcomes.json', scope: 'source-lines' });
  a.run(['init', '--app-json', JSON.stringify([process.execPath, '-e', "require('node:fs').writeFileSync('LOOKUP_APP_RAN', 'bad')"])]);
  const captureHash = a.hash('captures.json'), before = readFileSync(join(a.root, dataPath));
  const response = a.run(['measure', 'where', '--capture-set', 'captures.json', '--source', 'src/app.py:1-4', '--json']);
  assert.equal(response.stderr, ''); const result = JSON.parse(response.stdout);
  assert.equal(result.captureSet.sha256, captureHash);
  assert.equal(result.source.sha256, sha(source));
  assert.deepEqual(result.observedRanges, [[1, 3]]);
  assert.deepEqual(result.unobservedInstrumentedRanges, []);
  assert.deepEqual(result.unknownRanges, [[4, 4]]);
  assert.deepEqual(result.passedOnlyKnown.observedRanges, [[1, 1], [3, 3]]);
  assert.deepEqual(result.hits.map(hit => [hit.journey, hit.outcome, hit.observedRanges]), [['first-route', 'passed', [[1, 1], [3, 3]]], [null, 'unknown', [[2, 2]]]]);
  assert.deepEqual(result.hits[0].actions, a.manifest.actions);
  assert.deepEqual(result.journeys.map(row => [row.journey, row.outcome, row.intervals]), [['first-route', 'passed', 1], [null, 'unknown', 1]]);
  const second = JSON.parse(readFileSync(join(b.root, dataPath))).intervals[0];
  const evidence = { path: 'evidence.json', sha256: a.hash('evidence.json') };
  a.jsonFile('outcomes.json', { version: 1, intervals: [first, second].map(interval => ({ id: interval.id, journey: 'shared-route', status: 'passed', evidence })) });
  const grouped = a.json('measure', 'where', '--capture-set', 'captures.json', '--source', 'src/app.py');
  assert.deepEqual(grouped.journeys, [{ journey: 'shared-route', outcome: 'passed', intervals: 2, observedRanges: [[1, 3]] }]);
  const human = a.run(['measure', 'where', '--capture-set', 'captures.json', '--source', 'src/app.py']).stdout;
  assert.match(human, /shared-route passed: 1-3 \(2 interval\(s\)\)/);
  assert.equal(human.includes(first.id), false);
  assert.equal(result.families.length, 1);
  const clipped = a.json('measure', 'where', '--capture-set', 'captures.json', '--source', 'src/app.py:2-4');
  assert.deepEqual(clipped.observedRanges, [[2, 3]]);
  assert.deepEqual(a.json('measure', 'union', '--capture-set', 'captures.json').allObserved.observedLines, 3);
  assert.deepEqual(readFileSync(join(a.root, dataPath)), before);
  assert.equal(a.hash('captures.json'), captureHash);
  assert.equal(existsSync(join(a.root, dataPath + '.lock')), false);
  assert.equal(existsSync(join(a.root, 'LOOKUP_APP_RAN')), false);
});

test('measured where journey: current edits and stale snapshots remain historical while missing data stays unknown', t => {
  const snapshot = project(t), current = project(t); snapshot.json(...snapshot.args);
  snapshot.jsonFile('captures.json', { version: 1, inputRoots: ['.'] });
  current.put('src/app.py', 'changed\nsecond\nthird\nfourth\n');
  const args = ['measure', 'where', '--capture-set', join(snapshot.root, 'captures.json'), '--source', 'src/app.py'];
  const stale = current.json(...args);
  assert.deepEqual(stale.observedRanges, []);
  assert.deepEqual(stale.unobservedInstrumentedRanges, []);
  assert.deepEqual(stale.unknownRanges, [[1, 4]]);
  assert.equal(stale.historical.length, 1);
  assert.equal(stale.historical[0].sourceSha256, sha(source));
  assert.deepEqual(stale.historical[0].observedRanges, [[1, 1], [3, 3]]);
  const narrow = current.json('measure', 'where', '--capture-set', join(snapshot.root, 'captures.json'), '--source', 'src/app.py:2');
  assert.deepEqual(narrow.historical[0].observedRanges, []);
  assert.deepEqual(narrow.historical[0].instrumentedRanges, [[2, 2]]);
  assert.equal(narrow.historical[0].coordinateSpace, 'captured-source');
  const noData = current.json('measure', 'where', '--source', 'src/app.py:2-4');
  assert.deepEqual(noData.unknownRanges, [[2, 4]]); assert.equal(noData.status, 'unknown');
  snapshot.put('src/app.py', 'changed\nsecond\nthird\nfourth\n');
  const invalidSnapshot = current.json(...args);
  assert.deepEqual(invalidSnapshot.observedRanges, []);
  assert.match(invalidSnapshot.historical[0].reason, /snapshot|stale/i);
  current.run(['measure', 'where', '--source', 'src/app.py:1-99'], 1);
  current.run(['measure', 'where', '--capture-set', join(snapshot.root, 'missing.json'), '--source', 'src/app.py'], 1);
  snapshot.jsonFile('bad-captures.json', { version: 1, inputRoots: ['.'], unknown: true });
  current.run(['measure', 'where', '--capture-set', join(snapshot.root, 'bad-captures.json'), '--source', 'src/app.py'], 1);
  current.run(['measure', 'union', '--capture-set', join(snapshot.root, 'captures.json'), '--input-root', snapshot.root], 1);
});

test('measured where journey: independent scope families stay separate while current physical presence is classified', t => {
  const a = project(t), b = project(t); a.json(...a.args);
  b.manifest.runId = b.manifest.before.runId = b.manifest.after.runId = 'different-universe';
  b.manifest.probeSha256 = sha('different-probe');
  b.put('before.lcov', b.record('DA:1,1\nDA:2,0\nDA:3,9\nDA:4,0'));
  b.put('after.lcov', b.record('DA:1,1\nDA:2,0\nDA:3,9\nDA:4,1')); b.refresh(); b.json(...b.args);
  a.jsonFile('captures.json', { version: 1, inputRoots: ['.', b.root], scope: 'source-lines' });
  const result = a.json('measure', 'where', '--capture-set', 'captures.json', '--source', 'src/app.py');
  assert.equal(result.families.length, 2);
  assert.deepEqual(result.families.map(family => family.source.instrumentedRanges), [[[1, 3]], [[1, 4]]]);
  assert.deepEqual(result.observedRanges, [[1, 1], [3, 4]]);
  assert.deepEqual(result.unobservedInstrumentedRanges, [[2, 2]]);
  assert.deepEqual(result.unknownRanges, []);
  assert.match(a.run(['measure', 'union', '--capture-set', 'captures.json', '--json'], 1).stderr, /Incompatible measurement scope/);
  a.jsonFile('evidence.json', { synthetic: true });
  const id = JSON.parse(readFileSync(join(a.root, dataPath))).intervals[0].id;
  const evidence = { path: 'evidence.json', sha256: a.hash('evidence.json') };
  a.jsonFile('outcomes.json', { version: 1, intervals: [{ id, journey: 'first', status: 'passed', evidence }, { id, journey: 'first', status: 'failed', evidence }] });
  a.jsonFile('captures.json', { version: 1, inputRoots: ['.'], outcomes: 'outcomes.json' });
  assert.match(a.run(['measure', 'where', '--capture-set', 'captures.json', '--source', 'src/app.py', '--json'], 1).stderr, /duplicate/i);
  a.jsonFile('outcomes.json', { version: 1, intervals: [{ id, journey: 'first', status: 'passed', evidence }] });
  a.put('evidence.json', 'changed evidence\n');
  assert.match(a.run(['measure', 'where', '--capture-set', 'captures.json', '--source', 'src/app.py', '--json'], 1).stderr, /evidence digest mismatch/i);
  symlinkSync(join(a.root, 'captures.json'), join(a.root, 'capture-alias.json'));
  a.run(['measure', 'where', '--capture-set', 'capture-alias.json', '--source', 'src/app.py'], 1);
});

test('measured where journey: unrelated stale files do not gate requested-source lookup or relax full union integrity', t => {
  const f = project(t); f.put('src/other.py', 'other\n');
  f.jsonFile('sources.json', { files: [{ path: 'src/app.py', sha256: sha(source) }, { path: 'src/other.py', sha256: sha('other\n') }] });
  f.manifest.sourceManifestSha256 = f.manifest.before.sourceManifestSha256 = f.manifest.after.sourceManifestSha256 = f.hash('sources.json');
  f.put('before.lcov', f.record('DA:1,1\nDA:2,0\nDA:3,9') + 'SF:/capture/src/other.py\nDA:1,0\nend_of_record\n');
  f.put('after.lcov', f.record('DA:1,3\nDA:2,0\nDA:3,10') + 'SF:/capture/src/other.py\nDA:1,1\nend_of_record\n');
  f.refresh(); f.json(...f.args); f.put('src/other.py', 'changed\n');
  f.jsonFile('captures.json', { version: 1, inputRoots: ['.'] });
  const result = f.json('measure', 'where', '--capture-set', 'captures.json', '--source', 'src/app.py');
  assert.deepEqual(result.observedRanges, [[1, 1], [3, 3]]);
  assert.deepEqual(result.unobservedInstrumentedRanges, [[2, 2]]);
  assert.deepEqual(result.unknownRanges, [[4, 4]]);
  assert.match(result.validationScope, /Other snapshot files are outside/);
  assert.match(f.run(['measure', 'union', '--capture-set', 'captures.json', '--json'], 1).stderr, /stale/i);
});
