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

test('measured gaps journey: preserve the strict denominator and distinguish failed observations from unknown outcomes', t => {
  const f = project(t);
  const hits = ['DA:1,2\nDA:2,0\nDA:3,9', 'DA:1,1\nDA:2,1\nDA:3,9', 'DA:1,1\nDA:2,0\nDA:3,10'];
  const ids = hits.map((rows, index) => {
    f.manifest.runId = f.manifest.before.runId = f.manifest.after.runId = `gap-run-${index}`;
    f.put('after.lcov', f.record(rows)); f.refresh(); return f.json(...f.args).id;
  });
  f.jsonFile('evidence.json', { synthetic: true });
  const evidence = { path: 'evidence.json', sha256: f.hash('evidence.json') };
  const intervals = [
    { id: ids[0], status: 'passed', journey: 'passing journey', evidence },
    { id: ids[1], status: 'failed', journey: 'failing journey', evidence },
  ];
  f.jsonFile('outcomes.json', { version: 1, intervals });
  f.jsonFile('captures.json', { version: 1, inputRoots: ['.', '.'], outcomes: 'outcomes.json' });
  const args = ['measure', 'gaps', '--capture-set', 'captures.json', '--reference-root', '.'];
  const before = f.hash(dataPath), result = f.json(...args), union = f.json('measure', 'union', '--capture-set', 'captures.json');
  assert.deepEqual(result.allObserved, union.allObserved);
  assert.deepEqual(result.passedOnlyKnown, union.passedOnlyKnown);
  assert.deepEqual(result.intervals.outcomes, { passed: 1, failed: 1, unknown: 1 });
  assert.equal(result.intervals.duplicates, 3);
  assert.deepEqual(result.files[0].failedOnlyRanges, [[2, 2]]);
  assert.deepEqual(result.files[0].unknownOutcomeRanges, [[3, 3]]);
  assert.deepEqual(result.files[0].unknownInstrumentationRanges, [[4, 4]]);
  assert.deepEqual(result.files[0].unobservedInstrumentedRanges, []);
  assert.match(f.run(args).stdout, /src\/app.py.*2 passing gaps/);
  f.jsonFile('outcomes.json', { version: 1, intervals: [...intervals, { ...intervals[0], status: 'failed' }] });
  assert.match(f.run(args, 1).stderr, /duplicate/i);
  assert.equal(f.hash(dataPath), before);
  assert.equal(existsSync(join(f.root, `${dataPath}.lock`)), false);
});

test('measured gaps journey: historical observations earn credit only with matching source and line universe', t => {
  const ref = project(t), old = project(t), changed = project(t), universe = project(t);
  const prep = (f, runId) => {
    f.manifest.runId = f.manifest.before.runId = f.manifest.after.runId = runId;
    f.manifest.before.buildSha256 = f.manifest.after.buildSha256 = sha(runId);
    f.refresh(); return f.json(...f.args).id;
  };
  ref.put('after.lcov', ref.record('DA:1,2\nDA:2,0\nDA:3,9'));
  old.put('after.lcov', old.record('DA:1,1\nDA:2,1\nDA:3,9'));
  universe.put('before.lcov', universe.record('DA:1,1\nDA:3,9'));
  universe.put('after.lcov', universe.record('DA:1,1\nDA:3,10'));
  changed.put('src/app.py', 'prior\nsecond\nthird\nfourth\n');
  changed.jsonFile('sources.json', { files: [{ path: 'src/app.py', sha256: changed.hash('src/app.py') }] });
  changed.manifest.sourceManifestSha256 = changed.manifest.before.sourceManifestSha256 = changed.manifest.after.sourceManifestSha256 = changed.hash('sources.json');
  changed.put('after.lcov', changed.record('DA:1,1\nDA:2,0\nDA:3,10'));
  const fixtures = [old, universe, changed, ref];
  ref.jsonFile('evidence.json', { status: 'passed', synthetic: true });
  ref.jsonFile('outcomes.json', { version: 1, intervals: fixtures.map((f, i) => ({
    id: prep(f, `build-${i}`), journey: `journey-${i}`, status: 'passed', evidence: { path: 'evidence.json', sha256: ref.hash('evidence.json') },
  })) });
  ref.jsonFile('captures.json', { version: 1, inputRoots: fixtures.map(f => f.root), outcomes: 'outcomes.json' });
  const args = ['measure', 'gaps', '--capture-set', 'captures.json', '--reference-root', '.'];
  const result = ref.json(...args);
  assert.equal(result.reference.buildSha256, ref.manifest.before.buildSha256);
  assert.equal(result.provenanceGroups.length, 4);
  assert.deepEqual(result.files[0].referencePassingObservedRanges, [[1, 1]]);
  assert.deepEqual(result.files[0].reusedPassingObservedRanges, [[2, 2]]);
  assert.deepEqual(result.files[0].unobservedInstrumentedRanges, [[3, 3]]);
  assert.deepEqual(result.files[0].incompatibleEvidence.map(item => item.reason).sort(), ['source-mismatch', 'universe-mismatch']);
  old.put('src/app.py', 'stale snapshot\n');
  const stale = ref.json(...args);
  assert.equal(stale.passedOnlyKnown.observedLines, 1);
  assert.ok(stale.files[0].incompatibleEvidence.some(item => item.reason === 'snapshot-invalid'));
});

test('measured gaps journey: stale or missing current files remain in the ranked reference denominator', t => {
  const ref = project(t), current = project(t), outsider = project(t);
  ref.put('src/other.py', 'ready\nsteady\n');
  ref.jsonFile('sources.json', { files: ['src/app.py', 'src/other.py'].map(path => ({ path, sha256: ref.hash(path) })) });
  ref.manifest.sourceManifestSha256 = ref.manifest.before.sourceManifestSha256 = ref.manifest.after.sourceManifestSha256 = ref.hash('sources.json');
  ref.put('before.lcov', ref.record('DA:1,1\nDA:2,0\nDA:3,9') + 'SF:/capture/src/other.py\nDA:1,0\nDA:2,0\nend_of_record\n');
  ref.put('after.lcov', ref.record('DA:1,3\nDA:2,0\nDA:3,10') + 'SF:/capture/src/other.py\nDA:1,1\nDA:2,0\nend_of_record\n');
  ref.refresh(); const id = ref.json(...ref.args).id;
  ref.jsonFile('outcome-evidence.json', { status: 'passed', synthetic: true });
  ref.jsonFile('outcomes.json', { version: 1, intervals: [{ id, status: 'passed', journey: 'example', evidence: { path: 'outcome-evidence.json', sha256: ref.hash('outcome-evidence.json') } }] });
  ref.jsonFile('captures.json', { version: 1, inputRoots: ['.'], outcomes: 'outcomes.json' });
  const args = ['measure', 'gaps', '--capture-set', join(ref.root, 'captures.json'), '--reference-root', ref.root];
  const missing = current.json(...args);
  assert.equal(missing.passedOnlyKnown.instrumentedLines, 5);
  assert.equal(missing.passedOnlyKnown.observedLines, 2);
  assert.deepEqual(missing.files.map(({ path, status }) => [path, status]), [['src/other.py', 'unavailable-current-source'], ['src/app.py', 'current']]);
  assert.deepEqual(missing.files[0].unavailableReferenceRanges, [[1, 2]]);
  assert.deepEqual(missing.files[0].unobservedInstrumentedRanges, []);
  current.put('src/other.py', 'changed\n');
  const stale = current.json(...args);
  assert.equal(stale.files[0].status, 'stale-current-source');
  assert.deepEqual(stale.files[0].unknownInstrumentationRanges, [[1, 1]]);
  assert.match(current.run([...args.slice(0, -1), outsider.root], 1).stderr, /reference root.*capture set/i);
  ref.put('src/other.py', 'stale reference\n');
  assert.match(current.run(args, 1).stderr, /reference.*stale/i);
});

test('measured gaps journey: compare passing gains and losses even when the old set lacks the new reference', t => {
  const older = project(t), latest = project(t);
  for (const f of [older, latest]) {
    const previous = f === older, extra = previous ? 'older bytes\n' : 'current bytes\n';
    f.put('src/extra.py', extra);
    f.jsonFile('sources.json', { files: [{ path: 'src/app.py', sha256: sha(source) }, { path: 'src/extra.py', sha256: sha(extra) }] });
    f.manifest.sourceManifestSha256 = f.manifest.before.sourceManifestSha256 = f.manifest.after.sourceManifestSha256 = f.hash('sources.json');
    f.manifest.before.buildSha256 = f.manifest.after.buildSha256 = sha(extra);
    f.put('before.lcov', f.record('DA:1,0\nDA:2,0\nDA:3,0') + 'SF:/capture/src/extra.py\nDA:1,0\nend_of_record\n');
    f.put('after.lcov', f.record(previous ? 'DA:1,1\nDA:2,0\nDA:3,1' : 'DA:1,0\nDA:2,1\nDA:3,1') + 'SF:/capture/src/extra.py\nDA:1,1\nend_of_record\n');
    f.refresh(); const id = f.json(...f.args).id;
    f.jsonFile('evidence.json', { status: 'passed', synthetic: true });
    f.jsonFile('outcomes.json', { version: 1, intervals: [{ id, journey: 'example journey', status: 'passed', evidence: { path: 'evidence.json', sha256: f.hash('evidence.json') } }] });
    f.jsonFile('captures.json', { version: 1, inputRoots: ['.'], outcomes: 'outcomes.json' });
  }
  const args = ['measure', 'gaps', '--reference-root', '.', '--capture-set', 'captures.json', '--baseline-capture-set', join(older.root, 'captures.json')];
  const before = [older, latest].map(f => f.hash(dataPath));
  const result = latest.json(...args);
  assert.equal(result.passedOnlyKnown.observedLines, 3);
  assert.equal(result.comparison.baseline.captureSet.sha256, older.hash('captures.json'));
  assert.equal(result.comparison.gainedLines, 1);
  assert.equal(result.comparison.lostLines, 1);
  assert.equal(result.comparison.passingLinesWithoutComparableBaseline, 1);
  assert.deepEqual(result.comparison.files.map(file => [file.path, file.gainedRanges, file.lostRanges, file.passingRangesWithoutComparableBaseline]), [
    ['src/app.py', [[2, 2]], [[1, 1]], []], ['src/extra.py', [], [], [[1, 1]]],
  ]);
  assert.match(latest.run(args).stdout, /1 passing line\(s\) gained.*1 lost.*1 without comparable baseline/);
  assert.deepEqual([older, latest].map(f => f.hash(dataPath)), before);
});

test('measured gaps journey: distinguish a smaller rebuilt reference from passing gains', t => {
  const old = project(t), f = project(t), path = 'src/app.py';
  function capture(project, name) {
    const { id } = project.json(...project.args);
    project.jsonFile('receipt.json', {});
    project.jsonFile('outcomes.json', { version: 1, intervals: [{ id, journey: name, status: 'passed',
      evidence: { path: 'receipt.json', sha256: project.hash('receipt.json') } }] });
    project.jsonFile('captures.json', { version: 1, inputRoots: ['.'], outcomes: 'outcomes.json' });
  }
  capture(old, 'old editor');
  const trimmed = source.replace('second\n', '');
  f.put(path, trimmed);
  f.jsonFile('sources.json', { files: [{ path, sha256: f.hash(path) }] });
  f.manifest.sourceManifestSha256 = f.manifest.before.sourceManifestSha256 = f.manifest.after.sourceManifestSha256 = f.hash('sources.json');
  f.manifest.before.buildSha256 = f.manifest.after.buildSha256 = sha('trimmed build');
  f.put('before.lcov', f.record('DA:1,0\nDA:2,0'));
  f.put('after.lcov', f.record('DA:1,1\nDA:2,1'));
  f.refresh();
  capture(f, 'new editor');
  const args = ['measure', 'gaps', '--capture-set', 'captures.json', '--reference-root', '.', '--baseline-capture-set', join(old.root, 'captures.json')];
  const result = f.json(...args, '--baseline-reference-root', old.root);
  assert.equal(result.comparison.gainedLines, 0);
  assert.equal(result.comparison.lostLines, 0);
  assert.equal(result.comparison.passingLinesWithoutComparableBaseline, 2);
  const delta = result.comparison.referenceChange;
  assert.equal(delta.before.root, old.root);
  assert.equal(delta.before.instrumentedLines, 3);
  assert.equal(delta.after.instrumentedLines, 2);
  assert.equal(delta.instrumentedLinesDelta, -1);
  assert.deepEqual(delta.changedFiles, [{ path, change: 'source-changed', beforeInstrumentedLines: 3, afterInstrumentedLines: 2 }]);
  assert.match(f.run([...args, '--baseline-reference-root', f.root], 1).stderr, /reference root.*capture set/i);
});

test('measured gaps journey: reject conflicting evidence declarations for the same occurrence across comparison sets', t => {
  const f = project(t), id = f.json(...f.args).id;
  f.jsonFile('evidence.json', { synthetic: true });
  const evidence = { path: 'evidence.json', sha256: f.hash('evidence.json') };
  for (const status of ['passed', 'failed']) {
    f.jsonFile(`${status}-outcomes.json`, { version: 1, intervals: [{ id, journey: 'same journey', status, evidence }] });
    f.jsonFile(`${status}-captures.json`, { version: 1, inputRoots: ['.'], outcomes: `${status}-outcomes.json` });
  }
  const args = ['measure', 'gaps', '--reference-root', '.', '--capture-set', 'passed-captures.json', '--baseline-capture-set', 'failed-captures.json'];
  assert.match(f.run(args, 1).stderr, /conflicting.*outcome.*comparison/i);
  f.jsonFile('unknown-captures.json', { version: 1, inputRoots: ['.'] });
  const updatedOutcome = f.json(...args.slice(0, -1), 'unknown-captures.json');
  assert.equal(updatedOutcome.comparison.baseline.origins[0].sha256, updatedOutcome.origins[0].sha256);
  assert.equal(updatedOutcome.comparison.baseline.intervals.outcomes.unknown, 1);
  assert.equal(updatedOutcome.comparison.gainedLines, 2, 'known-passing evidence can grow with the same recorded interval');
});

test('measured gaps journey: compare an ordered series using the same verified evidence as separate reports', t => {
  const first = project(t), added = project(t);
  const firstID = first.json(...first.args).id;
  added.manifest.runId = added.manifest.before.runId = added.manifest.after.runId = 'synthetic-run-2';
  added.put('after.lcov', added.record('DA:1,1\nDA:2,1\nDA:3,9'));
  added.refresh();
  const addedID = added.json(...added.args).id;
  first.put('observed.json', 'Completed synthetic journeys\n');
  const evidence = { path: '../observed.json', sha256: first.hash('observed.json') };
  const passed = (id, journey) => ({ id, journey, status: 'passed', evidence });
  first.jsonFile('stages/first-outcomes.json', { version: 1, intervals: [passed(firstID, 'original')] });
  first.jsonFile('stages/both-outcomes.json', { version: 1, intervals: [passed(firstID, 'original'), passed(addedID, 'follow-up')] });
  first.jsonFile('stages/baseline.json', { version: 1, inputRoots: ['..'] });
  first.jsonFile('stages/first.json', { version: 1, inputRoots: ['..', added.root], outcomes: 'first-outcomes.json' });
  first.jsonFile('stages/both.json', { version: 1, inputRoots: ['..', added.root, added.root], outcomes: 'both-outcomes.json' });
  first.jsonFile('stages/series.json', { version: 1, captureSets: ['baseline.json', 'first.json', 'both.json'] });

  const common = ['measure', 'gaps', '--reference-root', '.'];
  const series = [...common, '--series', 'stages/series.json'];
  const separate = stage => first.json(...common, '--capture-set', `stages/${stage[1]}.json`, '--baseline-capture-set', `stages/${stage[0]}.json`);
  const stages = [['baseline', 'first'], ['first', 'both']];
  const result = first.json(...series);
  assert.equal(result.kind, 'lcov-reference-gap-series');
  assert.equal(result.series.sha256, first.hash('stages/series.json'));
  assert.deepEqual(result.reports, stages.map(separate));
  assert.deepEqual(result.reports.map(item => item.comparison.gainedLines), [2, 1]);
  assert.equal(result.reports[1].intervals.duplicates, 1);
  assert.match(first.run(series).stdout, /first\.json.*2 passing line\(s\) gained/);
  assert.match(first.run([...series, '--capture-set', 'stages/first.json'], 1).stderr, /series.*cannot be combined/i);
  first.jsonFile('stages/too-many.json', { version: 1, captureSets: Array(33).fill('first.json') });
  assert.match(first.run([...common, '--series', 'stages/too-many.json'], 1).stderr, /2-32 capture sets/i);

  added.put('src/app.py', 'Different snapshot bytes\n');
  const stale = first.json(...series);
  assert.deepEqual(stale.reports, stages.map(separate));
  assert.equal(stale.reports[1].comparison.gainedLines, 0, 'A subsequent command must validate changed source bytes');
  const wrongDigest = { ...passed(addedID, 'follow-up'), evidence: { ...evidence, sha256: sha('Incorrect digest') } };
  first.jsonFile('stages/both-outcomes.json', { version: 1, intervals: [passed(firstID, 'original'), wrongDigest] });
  const refused = first.run([...series, '--json'], 1);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /outcome evidence digest mismatch/i);
});

test('coverage worklist ranks actual passing gaps, groups exact selectors and preserves unresolved work', t => {
  const f = project(t);
  f.put('before.lcov', f.record('DA:1,0\nDA:2,0\nDA:3,0\nDA:4,0'));
  f.put('after.lcov', f.record('DA:1,1\nDA:2,0\nDA:3,0\nDA:4,0'));
  f.refresh();
  const { id } = f.json(...f.args);
  f.jsonFile('evidence.json', { status: 'passed' });
  f.jsonFile('outcomes.json', { version: 1, intervals: [{ id, journey: 'seed', status: 'passed', evidence: { path: 'evidence.json', sha256: f.hash('evidence.json') } }] });
  f.jsonFile('captures.json', { version: 1, inputRoots: ['.'], outcomes: 'outcomes.json' });
  f.put('tests/a.mjs', '// First reuse of the actual selector.\n');
  f.put('tests/b.mjs', '// Second reuse of the same actual selector.\n');
  const scenario = (id, paths, actionIds, extra = {}) => ({ id, title: id, featureId: 'project',
    state: paths.length ? 'existing' : 'unwritten', existingPaths: paths, actionIds,
    entryPoint: { path: 'src/app.py', symbol: 'run' }, plannedActions: ['Open'], expectedOutcomes: ['Visible'], ...extra });
  const association = (rangeId, start, end, scenarioIds) => ({ rangeId, featureId: 'project',
    source: { path: 'src/app.py', start, end }, scenarioIds, status: 'model-proposed-unreviewed',
    rationale: 'Synthetic current source', confidence: 'high', uncertainty: '', proposedAssertions: ['Visible'] });
  f.jsonFile('draft.json', { schemaVersion: 1, kind: 'proposed-scenario-association-map', status: 'model-proposed-unreviewed',
    scenarios: [scenario('first', ['tests/a.mjs'], ['open']), scenario('second', ['tests/b.mjs'], ['open']),
      scenario('extend', [], ['open']), scenario('new-route', [], ['drag']),
      scenario('restricted', ['tests/a.mjs'], ['open'], { restriction: 'Missing approved device' })],
    associations: [association('primary', 1, 2, ['first', 'second', 'new-route', 'restricted']), association('variant', 3, 3, ['extend'])] });
  f.jsonFile('proposal.json', f.json('proposal', 'prepare', '--file', 'draft.json'));
  const selector = ['test', 'workspace', '--name', 'with spaces'];
  f.jsonFile('routes.json', { version: 1, actions: [{ id: 'open' }], routes: [
    { id: 'workspace', paths: ['tests/a.mjs'], argv: selector },
    { id: 'alias', paths: ['tests/b.mjs'], argv: selector },
    { id: 'device-only', paths: ['tests/a.mjs'], argv: ['test', 'device-only'], restriction: 'Requires a paired device' },
  ] });
  f.run(['init', '--app-json', JSON.stringify([process.execPath, '-e', "require('node:fs').writeFileSync('WORKLIST_EXECUTED_APP', 'bad')"])]);
  const args = ['proposal', 'worklist', '--file', 'proposal.json', '--routes', 'routes.json', '--capture-set', 'captures.json', '--reference-root', '.'];
  const report = f.json(...args);
  assert.equal(report.kind, 'provisional-coverage-worklist');
  assert.deepEqual(report.coverage.passedOnlyKnown, { files: 1, instrumentedLines: 4, observedLines: 1, gapLines: 3, percent: 25 });
  assert.deepEqual(report.routes.map(row => [row.argv, row.planIds, row.gapLines]), [[selector, ['first', 'second'], 1]]);
  const ready = report.queues['action-and-scenario'].items.find(row => row.planId === 'first');
  assert.deepEqual(ready.routeIds, ['workspace', 'alias']);
  assert.deepEqual(ready.restrictedRoutes, [{ routeIds: ['device-only'], restrictions: ['Requires a paired device'] }]);
  assert.deepEqual(report.queues['needs-cli-action'].items.map(row => [row.planId, row.missingActionIds]), [['new-route', ['drag']]]);
  assert.deepEqual(report.queues['needs-scenario'].items.map(row => [row.planId, row.gapLines]), [['extend', 1]]);
  assert.deepEqual(report.queues.blocked.items.map(row => row.restrictions), [['Missing approved device']]);
  assert.deepEqual(report.unassigned, { files: 1, gapLines: 1, items: [{ path: 'src/app.py', gapLines: 1, gapRanges: [[4, 4]] }] });
  assert.equal(report.assignedGapLines, 2, 'Shared lines count once across plan and selector aliases');
  assert.equal(existsSync(join(f.root, 'WORKLIST_EXECUTED_APP')), false);
  assert.deepEqual(f.json(...args), report);
  const stale = project(t);
  for (const path of ['proposal.json', 'routes.json', 'tests/a.mjs', 'tests/b.mjs']) stale.put(path, readFileSync(join(f.root, path)));
  stale.put('src/app.py', source + 'Changed current source.\n');
  const historical = stale.json(...args.slice(0, -4), '--capture-set', join(f.root, 'captures.json'), '--reference-root', f.root);
  assert.equal(historical.assignedGapLines, 0);
  assert.equal(historical.unavailable.gapLines, 4);
  assert.equal(historical.unassigned.gapLines, 0);
  assert.deepEqual(historical.routes, []);
});

test('batched source lookup shares evidence reads while preserving each standalone result', t => {
  const first = project(t), second = project(t);
  first.json(...first.args);
  second.manifest.runId = second.manifest.before.runId = second.manifest.after.runId = 'other-run';
  second.put('after.lcov', second.record('DA:1,1\nDA:2,2\nDA:3,9'));
  second.refresh();
  second.json(...second.args);
  second.put('src/app.py', source + 'Historical snapshot drift.\n');
  first.put('src/uninstrumented.py', 'An uninstrumented file.\n');
  first.jsonFile('captures.json', { version: 1, inputRoots: ['.', second.root], scope: 'source-lines' });
  const selectors = ['src/app.py:2', 'src/uninstrumented.py', 'src/app.py:1-3'];
  const base = ['measure', 'where', '--capture-set', 'captures.json'];
  const expected = selectors.map(selector => first.json(...base, '--source', selector));
  assert.equal(expected[0].historical.length, 1);
  assert.equal(expected[1].status, 'unknown');
  const batch = first.json(...base, ...selectors.flatMap(selector => ['--source', selector]));
  assert.equal(batch.kind, 'measured-source-lookup-batch');
  assert.deepEqual(batch.reports, expected);
  assert.match(first.run([...base, ...selectors.flatMap(selector => ['--source', selector])]).stdout, /src\/uninstrumented.py:1-1: unknown/);
  const bad = first.run([...base, '--source', selectors[0], '--source', 'src/app.py:999', '--json'], 1);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /outside the current file/);
});

test('direct coverage worklist reuses current witnessed links without preparing a proposal', t => {
  const f = project(t);
  f.put('before.lcov', f.record('DA:1,0\nDA:2,0\nDA:3,0\nDA:4,0'));
  f.put('after.lcov', f.record('DA:1,1\nDA:2,0\nDA:3,0\nDA:4,0'));
  f.refresh();
  const { id } = f.json(...f.args);
  f.jsonFile('evidence.json', { status: 'passed' });
  f.jsonFile('outcomes.json', { version: 1, intervals: [{ id, journey: 'seed', status: 'passed', evidence: { path: 'evidence.json', sha256: f.hash('evidence.json') } }] });
  f.jsonFile('captures.json', { version: 1, inputRoots: ['.'], outcomes: 'outcomes.json' });
  for (const path of ['tests/single.mjs', 'tests/grouped.mjs', 'tests/stale.mjs']) f.put(path, '// Saved fixture\n');
  const link = (line, step) => f.run(['link', `src/app.py:${line}`, '--action', 'Open through CLI', ...step, '--why', 'Checks the visible result']);
  link(2, ['--step', 'tests/single.mjs:1']);
  link(2, []);
  link(3, ['--step', 'tests/grouped.mjs:1']);
  link(4, ['--step', 'tests/stale.mjs:1']);
  f.put('tests/stale.mjs', '// Changed fixture\n');
  const selector = ['test', 'open', '--label', 'with spaces'];
  f.jsonFile('routes.json', { version: 1, routes: [
    { id: 'primary', argv: selector, paths: ['tests/single.mjs'] },
    { id: 'alias', argv: selector, paths: ['tests/single.mjs'] },
    { id: 'default', argv: ['test', 'grouped'], paths: ['tests/grouped.mjs'] },
    { id: 'private-device', argv: ['test', 'grouped', '--device'], paths: ['tests/grouped.mjs'], restriction: 'Needs paired device' },
    { id: 'stale', argv: ['test', 'stale'], paths: ['tests/stale.mjs'] },
  ] });
  const mapHash = f.hash('docs/testing/code-e2e-links.json');
  f.run(['init', '--app-json', JSON.stringify([process.execPath, '-e', "require('node:fs').writeFileSync('DIRECT_WORKLIST_RAN_APP', 'bad')"])]);
  const report = f.json('worklist', '--routes', 'routes.json', '--capture-set', 'captures.json', '--reference-root', '.');
  assert.equal(report.kind, 'source-coverage-worklist');
  assert.equal(report.coverage.passedOnlyKnown.gapLines, 3);
  assert.deepEqual(report.routes.map(row => [row.routeIds, row.argv, row.gapLines]), [[['primary', 'alias'], selector, 1]]);
  assert.deepEqual(report.selectorReview.items.map(row => [row.witnessPath, row.candidates.map(candidate => candidate.restrictions), row.gapLines]),
    [['tests/grouped.mjs', [[], ['Needs paired device']], 1]]);
  assert.equal(report.linkedGapLines, 2);
  assert.equal(report.links.staleOrInvalid, 1);
  assert.equal(report.links.actionOnly, 1);
  assert.deepEqual(report.unassigned.items[0].gapRanges, [[4, 4]]);
  f.put('src/unmeasured.py', 'Available source without measurement.\n');
  const scoped = f.json('worklist', '--routes', 'routes.json', '--capture-set', 'captures.json', '--reference-root', '.',
    '--source', 'src/app.py:2-3', '--source', 'src/app.py:2', '--source', 'src/unmeasured.py');
  assert.deepEqual(scoped.coverage, report.coverage);
  assert.deepEqual(scoped.sourceFocus, {
    sources: [{ path: 'src/app.py', start: 2, end: 3 }, { path: 'src/app.py', start: 2, end: 2 }, { path: 'src/unmeasured.py' }],
    instrumentedLines: 2, observedPassingLines: 0, gapLines: 2, unknown: [{ path: 'src/unmeasured.py' }],
  });
  assert.deepEqual(scoped.routes.map(row => row.argv), [selector]);
  assert.equal(scoped.selectorReview.count, 1);
  assert.equal(scoped.unassigned.gapLines, 0);
  assert.equal(f.hash('docs/testing/code-e2e-links.json'), mapHash);
  assert.equal(existsSync(join(f.root, 'DIRECT_WORKLIST_RAN_APP')), false);
});

test('worklist finds discovered actions and the exact existing scenarios that recorded them', t => {
  const f = project(t);
  const interval = (run, action, line) => {
    f.manifest.runId = f.manifest.before.runId = f.manifest.after.runId = run;
    f.manifest.actions = [action, action];
    f.put('before.lcov', f.record('DA:1,0\nDA:2,0\nDA:3,0\nDA:4,0'));
    f.put('after.lcov', f.record([1, 2, 3, 4].map(n => `DA:${n},${Number(n === line)}`).join('\n')));
    f.refresh();
    return f.json(...f.args).id;
  };
  const ids = [interval('run-in-source', 'scriv open', 1), interval('run-elsewhere', 'scriv open', 4),
    interval('run-failed', 'scriv open', 2), interval('run-lookalike', 'scriv open-recent', 3),
    interval('run-restricted', 'scriv open', 1)];
  const path = 'tests/e2e/journeys/workspace.mjs', restricted = 'tests/e2e/journeys/device.mjs';
  f.put(path, '// Grouped workspace fixture\n'); f.put(restricted, '// Device fixture\n');
  f.jsonFile('routes.json', { schemaVersion: 1, kind: 'native-cli-scenario-catalog',
    selection: { mode: 'all', availableScenarioCount: 2, selectedScenarioCount: 2 },
    scenarios: [{ id: 'journeys/workspace', path, groups: ['open', 'close', 'empty', 'recent'] },
      { id: 'journeys/device', path: restricted, restriction: { status: 'blocked', reason: 'test-device', detail: 'Needs paired device' } }] });
  f.jsonFile('capabilities.json', { protocol: 1, driver: 'UIKit controls', commands: ['open', 'save', 'open-recent'], semanticMenuActionScopes: ['panel'] });
  f.jsonFile('evidence.json', {});
  const labels = [path + '#open', path + '#close', path + '#empty', path + '#recent', restricted];
  f.jsonFile('outcomes.json', { version: 1, intervals: ids.map((id, i) => ({ id, journey: labels[i],
    status: i === 2 ? 'failed' : 'passed', evidence: { path: 'evidence.json', sha256: f.hash('evidence.json') } })) });
  f.jsonFile('captures.json', { version: 1, inputRoots: ['.'], outcomes: 'outcomes.json' });
  const args = ['worklist', '--routes', 'routes.json', '--capture-set', 'captures.json', '--reference-root', '.', '--source', 'src/app.py:1-2'];
  const withCapabilities = [...args, '--capabilities', 'capabilities.json'];
  const baseline = f.json(...withCapabilities);
  const actionArgs = [...withCapabilities, '--action'];
  const { actionReview, ...report } = f.json(...actionArgs, 'open');
  assert.deepEqual(report, baseline, 'Action planning leaves every other queue and coverage total unchanged');
  assert.equal(report.sourceFocus.gapLines, 1, 'An actual failed run earns no passing credit');
  assert.deepEqual([actionReview.id, actionReview.measurementAction, actionReview.next, actionReview.routeCount],
    ['open', 'scriv open', 'extend-scenario', 2]);
  assert.deepEqual(actionReview.routes.map(row => [row.argv.at(-1), row.observedLines, row.example]), [
    ['open', 1, { journey: labels[0], intervalId: ids[0] }],
    ['close', 0, { journey: labels[1], intervalId: ids[1] }],
  ]);
  assert.deepEqual(actionReview.routes[0].sources, [{ path: 'src/app.py', observedRanges: [[1, 1]] }]);
  assert.deepEqual(actionReview.restrictedRoutes.items.map(row => row.restrictions), [['test-device (Needs paired device)']]);
  assert.equal(f.json(...actionArgs, 'open-recent').actionReview.next, 'review-scenario');
  assert.equal(f.json(...actionArgs, 'save').actionReview.next, 'find-or-add-scenario');
  assert.equal(f.json(...actionArgs, 'delete').actionReview.next, 'review-cli-action');
  assert.equal(f.json(...actionArgs, 'panel').actionReview.next, 'review-cli-action');
  assert.equal(f.json(...args.slice(0, -2), '--source', 'src/app.py:1', '--capabilities', 'capabilities.json', '--action', 'open')
    .actionReview.next, 'no-passing-gaps');
  assert.match(f.run([...args, '--action', 'open'], 1).stderr, /requires discovered actions/);
  f.jsonFile('routes.json', { version: 1, actions: [{ id: 'scriv open', restriction: 'Requires explicit consent' }],
    routes: [{ id: 'open', paths: [path], argv: ['test', 'open'], journeys: [labels[0]] }] });
  const blocked = f.json(...args, '--action', 'scriv open').actionReview;
  assert.equal(blocked.next, 'blocked');
  assert.deepEqual(blocked.routes, []);
  assert.deepEqual(blocked.restrictedRoutes.items[0].restrictions, ['Requires explicit consent']);
  assert.match(f.run([...args.slice(0, -2), '--capabilities', 'capabilities.json', '--action', 'open'], 1).stderr, /--action requires --source/);
});

test('worklist maps a discovered Scriv menu scope by its exact recorded label', t => {
  const f = project(t), path = 'tests/e2e/journeys/menu.mjs';
  f.put(path, '// Synthetic discovered fixture.\n');
  f.jsonFile('routes.json', { schemaVersion: 1, kind: 'native-cli-scenario-catalog',
    selection: { mode: 'all', availableScenarioCount: 1, selectedScenarioCount: 1 },
    scenarios: [{ id: 'journeys/menu', path, groups: ['scene', 'other', 'legacy'] }] });
  f.jsonFile('capabilities.json', { protocol: 1, driver: 'UIKit controls', commands: ['menu-action'],
    semanticMenuActionScopes: ['script-scenes', 'script-entries', 'audio-anchor'] });
  const action = 'scriv menu-action', label = 'scriv menu-action --scope script-scenes';
  const declarations = [];
  for (const [group, actionLabel] of [['scene', label], ['other', 'scriv menu-action --scope script-entries'], ['legacy', null]]) {
    f.manifest.runId = f.manifest.before.runId = f.manifest.after.runId = group;
    f.manifest.actions = [action, action];
    if (actionLabel) f.manifest.actionLabels = [actionLabel]; else delete f.manifest.actionLabels;
    f.save();
    const { id } = f.json(...f.args);
    declarations.push({ id, journey: path + '#' + group, status: 'passed' });
  }
  f.jsonFile('evidence.json', {});
  const evidence = { path: 'evidence.json', sha256: f.hash('evidence.json') };
  f.jsonFile('outcomes.json', { version: 1, intervals: declarations.map(row => ({ ...row, evidence })) });
  f.jsonFile('captures.json', { version: 1, inputRoots: ['.'], outcomes: 'outcomes.json' });
  const args = ['worklist', '--routes', 'routes.json', '--capabilities', 'capabilities.json',
    '--capture-set', 'captures.json', '--reference-root', '.', '--source', 'src/app.py', '--action'];
  const { actionReview, coverage } = f.json(...args, 'script-scenes');
  assert.equal(actionReview.next, 'extend-scenario');
  assert.equal(actionReview.measurementAction, label);
  assert.deepEqual(actionReview.routes.map(row => row.argv.at(-1)), ['scene']);
  assert.deepEqual(f.json(...args, 'menu-action').actionReview.routes.map(row => row.argv.at(-1)).sort(), ['legacy', 'other', 'scene']);
  assert.equal(f.json(...args, 'audio-anchor').actionReview.next, 'find-or-add-scenario');
  assert.deepEqual(f.json(...args, 'menu-action').coverage, coverage);
  const selected = f.json('measure', 'report', '--action', label).intervals;
  assert.deepEqual(selected.map(row => row.manifest.actions), [[action, action]]);
  assert.equal(f.json('measure', 'report', '--sequence', JSON.stringify([action, action])).intervals.length, 3);
  f.manifest.actionLabels = [label, label];
  f.save();
  assert.match(f.run(f.args, 1).stderr, /unique action labels/);
});

test('worklist matches an exact completed Scriv control target without falling back to generic activation', t => {
  const f = project(t);
  const fingerprint = identifier => `scriv activate --target-sha256 ${sha(identifier)}`;
  const routes = ['captured', 'other', 'legacy', 'window', 'mismatched-window', 'failed'].map(name => ({ id: `journeys/${name}`, path: `tests/e2e/journeys/${name}.mjs` }));
  f.jsonFile('receipt.json', {});
  const intervals = routes.map(({ path }, i) => {
    f.put(path, '// Real scenario selector witness.\n');
    const runId = `control-target-${i}`;
    f.manifest.runId = f.manifest.before.runId = f.manifest.after.runId = runId;
    f.manifest.actions = ['scriv snapshot', 'scriv activate'];
    if (i < 2) f.manifest.actionLabels = [fingerprint(['workspace-open', 'workspace-open-recent'][i])];
    else if (i === 3 || i === 4) {
      f.manifest.actionLabels = [
        fingerprint(i === 3 ? 'workspace-open' : 'workspace-open-recent'),
        `scriv activate --window-target-sha256 ${sha('workspace-open')}`,
      ];
    } else if (i === 5) {
      f.manifest.actionLabels = [fingerprint('wandering-control')];
    } else {
      f.manifest.actions.push('scriv menu-action', 'scriv import-json');
      f.manifest.actionLabels = ['scriv menu-action --scope script-entries', 'scriv menu-action --scope unpublished-scope'];
    }
    f.refresh();
    return { id: f.json(...f.args).id, journey: path, status: i === 5 ? 'failed' : 'passed',
      evidence: { path: 'receipt.json', sha256: f.hash('receipt.json') } };
  });
  f.jsonFile('discovery.json', { schemaVersion: 1, kind: 'native-cli-scenario-catalog',
    selection: { mode: 'all', availableScenarioCount: routes.length, selectedScenarioCount: routes.length }, scenarios: routes });
  f.jsonFile('capabilities.json', { protocol: 1, driver: 'UIKit controls', commands: ['snapshot', 'activate', 'menu-action', 'import-json'],
    semanticMenuActionScopes: ['script-entries'], semanticApplicationCommands: ['import-json'] });
  f.jsonFile('outcomes.json', { version: 1, intervals });
  f.jsonFile('captures.json', { version: 1, inputRoots: ['.'], outcomes: 'outcomes.json' });
  const args = ['worklist', '--routes', 'discovery.json', '--capabilities', 'capabilities.json',
    '--capture-set', 'captures.json', '--reference-root', '.', '--source', 'src/app.py', '--action'];
  const automatic = f.json(...args.slice(0, -1));
  const [window, imported, menu, other] = automatic.recordedActions.items;
  assert.equal(automatic.recordedActions.count, 4, 'Only passing exact targets and discovered semantic actions are suggested');
  assert.equal(window.evidence, 'dispatch-window');
  assert.deepEqual(window.actionArgs, ['--action', 'activate', '--target-sha256', sha('workspace-open')]);
  assert.deepEqual(window.routes.map(row => row.routeIds), [['journeys/window']]);
  assert.equal(imported.evidence, 'session');
  assert.deepEqual(imported.actionArgs, ['--action', 'import-json']);
  assert.equal(menu.evidence, 'session');
  assert.deepEqual(menu.actionArgs, ['--action', 'script-entries']);
  assert.deepEqual(menu.routes.map(row => row.routeIds), [['journeys/legacy']]);
  assert.equal(other.evidence, 'session', 'A different target’s window marker cannot upgrade an activation');
  assert.deepEqual(other.actionArgs, ['--action', 'activate', '--target-sha256', sha('workspace-open-recent')]);
  const focused = f.json(...args.slice(0, -3), '--source', 'src/app.py:2');
  const [lead] = focused.recordedActions.items;
  assert.equal(focused.sourceFocus.observedPassingLines, 0);
  assert.equal(focused.recordedActions.count, 1, 'Only a bounded matching control can nominate a gap with no hits itself');
  assert.deepEqual(lead.actionArgs, window.actionArgs);
  assert.equal(lead.observedLines, 0);
  assert.deepEqual(lead.dispatchBatch.argv, ['test', '--case', 'journeys/window']);
  assert.equal(lead.dispatchBatch.candidateGapLines, 1);
  assert.deepEqual(lead.dispatchBatch.cases[0].sources, [{ path: 'src/app.py', gapLines: 1, gapRanges: [[2, 2]] }]);
  assert.deepEqual(lead.dispatchBatch.cases[0].examples, [{
    path: 'src/app.py', range: [2, 2], observedAround: [1, 3],
    intervalId: intervals[3].id, journey: routes[3].path, actionIds: ['snapshot', 'activate'],
  }]);
  assert.deepEqual(f.json(...args.slice(0, -1), ...window.actionArgs).actionReview.dispatchWindows.items, window.routes);
  assert.match(f.run([...args, 'activate', '--target-sha256', 'wrong'], 1).stderr, /64 lowercase hexadecimal/);
  assert.match(f.run([...args, 'activate', '--target', 'workspace-open', '--target-sha256', sha('workspace-open')], 1).stderr, /one of/);
  const broad = f.json(...args, 'activate').actionReview;
  assert.equal(broad.routeCount, 5);
  const exact = f.json(...args, 'activate', '--target', 'workspace-open').actionReview;
  assert.equal(exact.target, 'workspace-open');
  assert.equal(exact.measurementAction, fingerprint('workspace-open'));
  assert.deepEqual(exact.routes.map(route => route.routeIds), [['journeys/captured'], ['journeys/window']]);
  assert.deepEqual(exact.dispatchWindows.items.map(route => route.routeIds), [['journeys/window']]);
  assert.deepEqual(exact.dispatchWindows.items[0].sources,
    exact.routes.find(route => route.routeIds.includes('journeys/window')).sources);
  assert.equal(broad.dispatchWindows, undefined);
  assert.deepEqual(exact.dispatchBatch.argv, ['test', '--case', 'journeys/window']);
  assert.deepEqual(exact.dispatchBatch, window.dispatchBatch);
  const global = f.json(...args.slice(0, -3));
  assert.equal(global.recordedActions.count, 1, 'Discovery nominates exact passing windows without a preselected source');
  const [globalLead] = global.recordedActions.items;
  assert.deepEqual(globalLead.actionArgs, window.actionArgs);
  assert.deepEqual(globalLead.dispatchBatch, window.dispatchBatch);
  assert.deepEqual(global.coverage, automatic.coverage);
  assert.deepEqual(exact.extensionCandidates.items.map(route => route.routeIds), [['journeys/captured']]);
  const different = f.json(...args, 'activate', '--target', 'workspace-open-recent').actionReview;
  assert.equal(different.dispatchWindows.count, 0);
  assert.deepEqual(different.dispatchBatch.argv, []);
  const functions = { version: 1, kind: 'llvm-function-map', buildSha256: f.manifest.before.buildSha256,
    sourceManifestSha256: f.manifest.sourceManifestSha256,
    files: [{ path: 'src/app.py', sha256: f.hash('src/app.py'), ranges: [[1, 1], [2, 3]] }] };
  f.jsonFile('functions.json', functions);
  const edge = f.json(...args.slice(0, -1), '--function-map', 'functions.json', ...window.actionArgs).actionReview.dispatchBatch;
  assert.equal(edge.candidateGapLines, 1);
  assert.equal(edge.cases[0].examples[0].observedAnchor, 3);
  functions.files[0].ranges = [[1, 4], [1, 2], [3, 3]];
  f.jsonFile('functions.json', functions);
  const declaration = f.json(...args.slice(0, -1), '--function-map', 'functions.json', ...window.actionArgs);
  assert.deepEqual(declaration.actionReview.dispatchBatch.argv, [], 'A containing function can account for the closure declaration count');
  assert.ok(declaration.functionReview.entryPoints.items.some(row => row.start === 1 && row.end === 2
    && row.gapRanges[0][0] === 2), 'The nested callback body still needs its own entry point');
  functions.files[0].ranges = [[1, 1], [2, 2], [3, 3]];
  f.jsonFile('functions.json', functions);
  assert.deepEqual(f.json(...args.slice(0, -1), '--function-map', 'functions.json', ...window.actionArgs)
    .actionReview.dispatchBatch.argv, [], 'Do not cross compiler function boundaries in a dispatch window');
  assert.equal(f.json(...args, 'activate', '--target', 'workspace').actionReview.routeCount, 0);
  assert.match(f.run([...args, 'snapshot', '--target', 'workspace-open'], 1).stderr, /--target requires.*activate/);
  assert.match(f.run([...args, 'activate', '--target', '0.1.2'], 1).stderr, /stable control identifier/);
});

test('worklist matches an unobserved helper to a passing caller inside an exact control window', t => {
  const f = project(t), caller = 'src/app.py', helper = 'src/helper.py';
  f.put(helper, 'def recover():\n    restore()\n');
  const files = [caller, helper].map(path => ({ path, sha256: f.hash(path) }));
  f.jsonFile('sources.json', { files });
  f.manifest.sourceManifestSha256 = f.manifest.before.sourceManifestSha256 =
    f.manifest.after.sourceManifestSha256 = f.hash('sources.json');
  const path = 'tests/e2e/journeys/workspace.mjs', scenario = 'journeys/workspace';
  const target = sha('workspace-open'), other = sha('workspace-retry');
  f.put(path, '// Open and recover a workspace through its real controls.\n');
  f.jsonFile('receipt.json', {});
  f.put('before.lcov', f.record('DA:1,0\nDA:2,0\nDA:3,0') +
    f.record('DA:1,0\nDA:2,0').replace(caller, helper));
  const capture = (runId, rows, actionLabels, status = 'passed') => {
    f.manifest.runId = f.manifest.before.runId = f.manifest.after.runId = runId;
    f.manifest.actions = ['scriv activate'];
    f.manifest.actionLabels = actionLabels;
    f.put('after.lcov', f.record(rows) + f.record('DA:1,0\nDA:2,0').replace(caller, helper));
    f.refresh();
    return { id: f.json(...f.args).id, journey: `${path}#recover`, status,
      evidence: { path: 'receipt.json', sha256: f.hash('receipt.json') } };
  };
  const anchor = 'DA:1,0\nDA:2,1\nDA:3,0';
  const matching = [`scriv activate --target-sha256 ${target}`, `scriv activate --window-target-sha256 ${target}`];
  const intervals = [
    capture('ordinary-session', anchor, [matching[0]]),
    capture('exact-window', anchor, matching),
    capture('mismatched-window', anchor, [matching[0], `scriv activate --window-target-sha256 ${other}`]),
    capture('declaration-only', 'DA:1,1\nDA:2,0\nDA:3,0',
      [`scriv activate --target-sha256 ${other}`, `scriv activate --window-target-sha256 ${other}`]),
    capture('failed-window', anchor, [`scriv activate --target-sha256 ${other}`, `scriv activate --window-target-sha256 ${other}`], 'failed'),
  ];
  f.jsonFile('discovery.json', { schemaVersion: 1, kind: 'native-cli-scenario-catalog',
    selection: { mode: 'all', availableScenarioCount: 1, selectedScenarioCount: 1 },
    scenarios: [{ id: scenario, path, groups: ['recover'] }] });
  f.jsonFile('capabilities.json', { protocol: 1, driver: 'UIKit controls', commands: ['activate'] });
  f.jsonFile('outcomes.json', { version: 1, intervals });
  f.jsonFile('captures.json', { version: 1, inputRoots: ['.'], outcomes: 'outcomes.json' });
  f.jsonFile('functions.json', { version: 1, kind: 'llvm-function-map', buildSha256: f.manifest.before.buildSha256,
    sourceManifestSha256: f.manifest.sourceManifestSha256,
    files: [{ ...files[0], ranges: [[1, 4], [1, 3]] }, { ...files[1], ranges: [[1, 2]] }],
    calls: [{ caller: { path: caller, line: 3 }, callee: { path: helper, start: 1, end: 2 } }] });
  const args = ['worklist', '--routes', 'discovery.json', '--capabilities', 'capabilities.json',
    '--capture-set', 'captures.json', '--reference-root', '.', '--function-map', 'functions.json',
    '--source', helper, '--action', 'activate'];
  const result = f.json(...args, '--target-sha256', target);
  assert.equal(result.sourceFocus.observedPassingLines, 0);
  assert.equal(result.actionReview.next, 'extend-scenario');
  const batch = result.actionReview.dispatchBatch;
  assert.deepEqual(batch.argv, ['test', '--case', `${scenario}#recover`]);
  assert.equal(batch.candidateGapLines, 2);
  assert.deepEqual(batch.cases[0].examples, [{
    path: helper, range: [1, 2], functionRange: [1, 2],
    caller: { path: caller, line: 3, functionRange: [1, 3] }, observedAnchor: 2,
    intervalId: intervals[1].id, journey: `${path}#recover`, actionIds: ['activate'],
  }]);
  assert.deepEqual(result.recordedActions.items[0].dispatchBatch, batch);
  assert.deepEqual(f.json(...args, '--target-sha256', other).actionReview.dispatchBatch.argv, []);
  const global = f.json(...args.slice(0, -4));
  const globalMatch = global.recordedActions.items.find(row => row.targetSha256 === target);
  assert.ok(globalMatch.dispatchBatch.cases[0].sources.some(source => source.path === helper));
  assert.deepEqual(global.coverage, result.coverage);
});

test('direct worklist finds scenario extension leads from one passing interval around the same gap', t => {
  const f = project(t);
  f.put('src/app.py', source + 'fifth\nsixth\nseventh\n');
  f.jsonFile('sources.json', { files: [{ path: 'src/app.py', sha256: f.hash('src/app.py') }] });
  f.manifest.sourceManifestSha256 = f.manifest.before.sourceManifestSha256 = f.manifest.after.sourceManifestSha256 = f.hash('sources.json');
  const capture = (runId, journey, values, status = 'passed') => {
    f.manifest.runId = f.manifest.before.runId = f.manifest.after.runId = runId;
    f.put('before.lcov', f.record(values.map((_, i) => `DA:${i + 1},0`).join('\n')));
    f.put('after.lcov', f.record(values.map((value, i) => `DA:${i + 1},${value}`).join('\n')));
    f.refresh();
    const { id } = f.json(...f.args);
    const path = `${status}.json`;
    f.jsonFile(path, { status });
    return { id, journey, status, evidence: { path, sha256: f.hash(path) } };
  };
  const intervals = [capture('near', 'same-interval', [1, 0, 1, 0, 0, 0, 0]),
    capture('left', 'split-intervals', [1, 0, 0, 0, 0, 0, 0]), capture('right', 'split-intervals', [0, 0, 1, 0, 0, 0, 0]),
    capture('failed-near', 'failed-interval', [1, 0, 1, 0, 0, 0, 0], 'failed'),
    capture('shared-near', 'second-matching-interval', [1, 0, 1, 0, 0, 0, 0])];
  f.jsonFile('outcomes.json', { version: 1, intervals });
  f.jsonFile('captures.json', { version: 1, inputRoots: ['.'], outcomes: 'outcomes.json' });
  f.put('tests/cases.mjs', '// Both scenarios share one file.\n');
  const route = (id, journey, argv = ['test', '--group', id]) => ({ id, journeys: [journey], argv, paths: ['tests/cases.mjs'] });
  f.jsonFile('routes.json', { version: 1, routes: [route('extend', 'same-interval'), route('split', 'split-intervals'), route('failed', 'failed-interval')] });
  const args = ['worklist', '--routes', 'routes.json', '--capture-set', 'captures.json', '--reference-root', '.'];
  const report = f.json(...args);
  assert.equal(report.coverage.passedOnlyKnown.gapLines, 5);
  assert.equal(report.linkedGapLines, 0);
  assert.equal(report.unassigned.gapLines, 5, 'A neighboring observation does not assign a range or cover it');
  assert.equal(report.extensionCandidates.gapLines, 1);
  assert.deepEqual(report.extensionCandidates.items, [{ routeIds: ['extend'], argv: ['test', '--group', 'extend'],
    restrictions: [], gapLines: 1, exclusiveGapLines: 1, marginalGapLines: 1, sources: [{ path: 'src/app.py', gapLines: 1, gapRanges: [[2, 2]] }],
    examples: [{ path: 'src/app.py', range: [2, 2], observedAround: [1, 3], intervalId: intervals[0].id, journey: 'same-interval' }] }]);
  const routes = [route('extend', 'same-interval'), route('restricted-alias', 'same-interval', ['test', '--group', 'extend'])];
  routes[1].restriction = 'Requires an authorized device';
  f.jsonFile('routes.json', { version: 1, routes });
  const blocked = f.json(...args).extensionCandidates;
  assert.deepEqual(blocked.items, []);
  assert.deepEqual(blocked.restricted.items[0].restrictions, ['Requires an authorized device']);
  assert.equal(blocked.restricted.gapLines, 1);
  routes.push(route('also-extend', 'second-matching-interval'));
  f.jsonFile('routes.json', { version: 1, routes });
  const shared = f.json(...args).extensionCandidates;
  assert.equal(shared.gapLines, 1);
  assert.equal(shared.exclusiveGapLines, 1, 'A restricted alternative cannot compete with an eligible scenario');
  assert.deepEqual(shared.items.map(row => [row.routeIds, row.exclusiveGapLines]), [[['also-extend'], 1]]);
  routes.push(route('other', 'same-interval'));
  f.jsonFile('routes.json', { version: 1, routes });
  assert.match(f.run([...args, '--json'], 1).stderr, /Ambiguous.*journey/i);

  const crowded = [capture('broad', 'broad', [1, 0, 1, 0, 1, 0, 0]),
    capture('duplicate', 'duplicate', [1, 0, 1, 0, 1, 0, 0]), capture('distinct', 'distinct', [0, 0, 0, 0, 1, 0, 1])];
  f.jsonFile('outcomes.json', { version: 1, intervals: crowded });
  f.jsonFile('routes.json', { version: 1, routes: [route('broad', 'broad'), route('duplicate', 'duplicate'), route('distinct', 'distinct')] });
  const batch = f.json(...args, '--limit', '2').extensionCandidates;
  assert.equal(batch.count, 3);
  assert.equal(batch.gapLines, 3);
  assert.deepEqual(batch.items.map(row => [row.routeIds[0], row.marginalGapLines]), [['broad', 2], ['distinct', 1]]);
  const focused = f.json(...args, '--source', 'src/app.py:4-4').extensionCandidates;
  assert.deepEqual(focused.items.map(row => [row.routeIds[0], row.marginalGapLines]), [['broad', 1]]);

  const mark = (range, why) => f.run(['dead-code', `src/app.py:${range}`, '--why', why, '--evidence', 'Reviewed production callers and target membership']);
  mark(1, 'Candidate with an observed execution');
  mark(4, 'Candidate with no registered caller');
  mark(6, 'Candidate with a current CLI witness');
  f.run(['link', 'src/app.py:6', '--step', 'tests/cases.mjs:1', '--action', 'Open through CLI', '--why', 'Checks a real result']);
  const review = f.json(...args);
  assert.equal(review.coverage.passedOnlyKnown.gapLines, 3);
  assert.equal(review.runtimeReview.gapLines, 2);
  assert.equal(review.runtimeReview.pendingGapLines, 1);
  assert.deepEqual(review.runtimeReview.items.map(row => [row.source.start, row.disposition]).sort((a, b) => a[0] - b[0]),
    [[1, 'observed-execution'], [4, 'review-removal'], [6, 'witness-conflict']]);
  assert.equal(review.extensionCandidates.gapLines, 1, 'Reviewed removal no longer competes for extensions');
  assert.equal(review.unassigned.gapLines, 2, 'Still in the measured worklist until a new reference removes it');
  const scopedReview = f.json(...args, '--source', 'src/app.py:4-4');
  assert.deepEqual(scopedReview.runtimeReview.items.map(row => row.source.start), [4]);
  assert.equal(scopedReview.sourceFocus.gapLines, 1);
  assert.equal(scopedReview.extensionCandidates.count, 0);
  const reference = project(t);
  reference.put('src/app.py', source + 'fifth\nsixth\nseventh\n');
  reference.put(dataPath, readFileSync(join(f.root, dataPath)));
  f.jsonFile('captures.json', { version: 1, inputRoots: [reference.root], outcomes: 'outcomes.json' });
  f.put('src/app.py', source + 'fifth\nsixth\nseventh\nchanged\n');
  const stale = f.json(...args.slice(0, -1), reference.root);
  assert.equal(stale.runtimeReview.invalid.count, 3);
  assert.equal(stale.runtimeReview.pendingGapLines, 0);
  assert.equal(stale.coverage.passedOnlyKnown.instrumentedLines, 7);
});

test('worklist reads native CLI discovery and matches exact capture group labels', t => {
  const f = project(t);
  const { id } = f.json(...f.args);
  f.jsonFile('evidence.json', { status: 'passed' });
  const path = 'tests/e2e/journeys/review.mjs', blocked = 'tests/e2e/_blocked.mjs';
  f.put(path, '// Native review journey\n');
  f.put(blocked, '// Blocked native journey\n');
  f.jsonFile('outcomes.json', { version: 1, intervals: [{ id, journey: path + '#alternate', status: 'passed',
    evidence: { path: 'evidence.json', sha256: f.hash('evidence.json') } }] });
  f.jsonFile('captures.json', { version: 1, inputRoots: ['.'], outcomes: 'outcomes.json' });
  const discovery = { schemaVersion: 1, kind: 'native-cli-scenario-catalog',
    selection: { mode: 'all', availableScenarioCount: 2, selectedScenarioCount: 2 }, scenarios: [
      { id: 'journeys/review', path, groups: ['default', 'alternate'] },
      { id: '_blocked', path: blocked, restriction: { status: 'blocked', reason: 'fixture-unavailable', detail: 'Requires a paired device.' } },
    ] };
  f.jsonFile('discovery.json', discovery);
  const args = ['worklist', '--routes', 'discovery.json', '--capture-set', 'captures.json', '--reference-root', '.'];
  const result = f.json(...args);
  assert.equal(result.routesSha256, f.hash('discovery.json'));
  assert.equal(result.extensionCandidates.count, 1);
  assert.deepEqual(result.extensionCandidates.items[0].argv, ['test', '--scenario', 'journeys/review', '--group', 'alternate']);
  assert.deepEqual(result.nativeBatches.session.argv, ['test', '--case', 'journeys/review#alternate']);
  assert.deepEqual(result.nativeBatches.session.cases.map(({ selector, marginalGapLines }) => [selector, marginalGapLines]),
    [['journeys/review#alternate', 1]]);
  assert.equal(result.extensionCandidates.items[0].examples[0].journey, path + '#alternate');
  f.run(['link', 'src/app.py:2', '--step', `${path}:1`, '--action', 'Review selected item', '--why', 'Checks the visible result']);
  const grouped = f.json(...args);
  const groupReview = grouped.selectorReview.items.find(row => row.witnessPath === path);
  assert.equal(groupReview.gapLines, 1);
  assert.equal(groupReview.candidates.length, 3);
  const selected = groupReview.candidates.find(row => row.argv.at(-1) === 'alternate');
  assert.deepEqual(selected.neighboringEvidence, { gapLines: 1, example: result.extensionCandidates.items[0].examples[0] });
  assert.equal(groupReview.candidates.filter(row => row.neighboringEvidence).length, 1);
  assert.equal(grouped.extensionCandidates.count, 0, 'The same gap remains assigned for selector review');
  assert.deepEqual(grouped.coverage, result.coverage);
  f.run(['link', 'src/app.py:2', '--step', `${blocked}:1`, '--action', 'Open the blocked control', '--why', 'Check the control']);
  const restricted = f.json(...args).selectorReview.items[0];
  assert.equal(restricted.witnessPath, blocked);
  assert.deepEqual(restricted.candidates[0].restrictions, ['fixture-unavailable (Requires a paired device.)']);
  const invalid = [
    doc => { doc.scenarios[0].groups.push('alternate'); },
    doc => { doc.scenarios[0].path = blocked; },
    doc => { doc.scenarios[1].groups = ['unsafe']; },
    doc => { doc.selection.selectedScenarioCount = 1; },
  ];
  for (const edit of invalid) {
    const input = structuredClone(discovery); edit(input); f.jsonFile('discovery.json', input);
    assert.equal(f.run([...args, '--json'], 1).stdout, '');
  }
});

test('worklist finds declared action cases directly and from measured source gaps', t => {
  const f = project(t), path = 'src/app.py', helper = 'src/lease.py';
  f.put(helper, 'def acquire():\n    return lease()\n');
  const files = [path, helper].map(path => ({ path, sha256: f.hash(path) }));
  f.jsonFile('sources.json', { files });
  f.manifest.sourceManifestSha256 = f.manifest.before.sourceManifestSha256 =
    f.manifest.after.sourceManifestSha256 = f.hash('sources.json');
  const unavailable = f.record('DA:1,0\nDA:2,0').replace(path, helper);
  f.manifest.actions = ['scriv key'];
  f.put('before.lcov', f.record('DA:1,0\nDA:2,0\nDA:3,0') + unavailable);
  f.put('after.lcov', f.record('DA:1,1\nDA:2,0\nDA:3,1') + unavailable);
  f.refresh();
  const { id } = f.json(...f.args);
  const journey = 'tests/e2e/journeys/editor.mjs';
  f.put(journey, '// Run the real native edit shortcut from named conditions.\n');
  const action = { id: 'edit-line', command: 'key',
    entryPoint: { path, start: 1, end: 4, sha256: f.hash(path) } };
  const scenario = { id: 'journeys/editor', path: journey, groups: ['available', 'locked'], groupActions: {
    available: [{ ...action, condition: 'lease-available' }],
    locked: [{ ...action, condition: 'lease-held-by-peer' }],
  } };
  const discovery = { schemaVersion: 1, kind: 'native-cli-scenario-catalog',
    selection: { mode: 'all', availableScenarioCount: 1, selectedScenarioCount: 1 }, scenarios: [scenario] };
  f.jsonFile('discovery.json', discovery);
  f.jsonFile('capabilities.json', { protocol: 1, driver: 'UIKit controls', commands: ['key'] });
  f.jsonFile('receipt.json', { status: 'passed' });
  f.jsonFile('outcomes.json', { version: 1, intervals: [{ id, journey: `${journey}#available`, status: 'passed',
    evidence: { path: 'receipt.json', sha256: f.hash('receipt.json') } }] });
  f.jsonFile('captures.json', { version: 1, inputRoots: ['.'], outcomes: 'outcomes.json' });
  f.jsonFile('functions.json', { version: 1, kind: 'llvm-function-map', buildSha256: f.manifest.before.buildSha256,
    sourceManifestSha256: f.manifest.sourceManifestSha256,
    files: [{ ...files[0], ranges: [[1, 4]] }, { ...files[1], ranges: [[1, 2]] }],
    calls: [{ caller: { path, line: 2 }, callee: { path: helper, start: 1, end: 2 } }] });
  const lookup = ['worklist', '--routes', 'discovery.json'];
  const args = [...lookup, '--capabilities', 'capabilities.json', '--capture-set', 'captures.json', '--reference-root', '.',
    '--function-map', 'functions.json'];
  const preview = f.json(...lookup, '--action', action.id);
  assert.deepEqual(preview.actionCases.items[0].cases.map(({ condition, argv }) => [condition, argv]), [
    ['lease-available', ['test', '--case', 'journeys/editor#available']],
    ['lease-held-by-peer', ['test', '--case', 'journeys/editor#locked']],
  ]);
  const measured = f.json(...args, '--action', action.id).actionCases.items[0];
  assert.equal(measured.command, 'key');
  assert.deepEqual(measured.cases.map(({ evidence }) => evidence.status), ['passed', 'unknown']);
  assert.equal(measured.cases[0].evidence.observedLines, 2);
  assert.equal(measured.cases[0].evidence.commandRecorded, true);
  for (const [source, kind] of [[`${path}:2`, 'entry-point'], [`${helper}:2`, 'compiler-call']]) {
    const report = f.json(...args, '--source', source);
    assert.equal(report.sourceFocus.gapLines, 1);
    assert.equal(report.actionCases.items[0].id, action.id);
    assert.equal(report.actionCases.items[0].match.kind, kind);
    assert.equal(report.actionCases.items[0].cases[0].evidence.observedLines, 0);
  }
  const newer = project(t);
  for (const file of [path, helper, 'sources.json', 'before.lcov']) newer.put(file, readFileSync(join(f.root, file)));
  Object.assign(newer.manifest, structuredClone(f.manifest), { runId: 'newer-probe-run', probeSha256: sha('newer-probe') });
  newer.manifest.before.runId = newer.manifest.after.runId = newer.manifest.runId;
  newer.put('after.lcov', newer.record('DA:1,0\nDA:2,1\nDA:3,0') + unavailable);
  newer.refresh();
  const locked = newer.json(...newer.args).id;
  const evidence = { path: 'receipt.json', sha256: f.hash('receipt.json') };
  f.jsonFile('outcomes.json', { version: 1, intervals: [
    { id, journey: `${journey}#available`, status: 'passed', evidence },
    { id: locked, journey: `${journey}#locked`, status: 'passed', evidence },
  ] });
  f.jsonFile('captures.json', { version: 1, inputRoots: ['.', newer.root], outcomes: 'outcomes.json' });
  const evidenceAfter = f.json(...args, '--action', action.id).actionCases.items[0].cases.map(row => row.evidence);
  assert.deepEqual(evidenceAfter.map(row => row.status), ['passed', 'passed']);
  assert.equal(evidenceAfter[1].observedLines, 1, 'A changed probe can still provide compatible case evidence for the signed build');
  action.entryPoint.sha256 = '0'.repeat(64);
  f.jsonFile('discovery.json', discovery);
  assert.deepEqual(f.json(...args, '--source', `${path}:2`).actionCases.items, []);
  assert.deepEqual(f.json(...args, '--source', `${helper}:2`).actionCases.items, []);
  scenario.groupActions.unknown = scenario.groupActions.locked;
  f.jsonFile('discovery.json', discovery);
  assert.match(f.run([...lookup, '--action', action.id], 1).stderr, /route catalog|group action/i);
});

test('worklist reuses a recorded CLI scenario at the end of a reached function', t => {
  const f = project(t), path = 'src/app.py';
  f.put(path, source + 'fifth\nsixth\nseventh\n');
  f.jsonFile('sources.json', { files: [{ path, sha256: f.hash(path) }] });
  f.manifest.sourceManifestSha256 = f.manifest.before.sourceManifestSha256 = f.manifest.after.sourceManifestSha256 = f.hash('sources.json');
  const capture = (runId, action, values, status) => {
    const journey = `tests/${runId}.mjs`;
    f.put(journey, '// Scenario checks the public control.\n');
    f.manifest.runId = f.manifest.before.runId = f.manifest.after.runId = runId;
    f.manifest.actions = [action];
    f.put('before.lcov', f.record(values.map((_, i) => `DA:${i + 1},0`).join('\n')));
    f.put('after.lcov', f.record(values.map((value, i) => `DA:${i + 1},${value}`).join('\n')));
    f.refresh();
    const { id } = f.json(...f.args);
    return { id, journey, status, evidence: { path: 'receipt.json', sha256: f.hash('receipt.json') } };
  };
  f.jsonFile('receipt.json', {});
  const intervals = [
    capture('edit', 'edit', [1, 1, 0, 0, 0, 0, 0], 'passed'),
    capture('also-edit', 'edit', [1, 1, 0, 0, 0, 0, 0], 'passed'),
    capture('neighbor-only', 'inspect', [0, 0, 0, 0, 1, 0, 0], 'failed'),
  ];
  f.jsonFile('outcomes.json', { version: 1, intervals });
  f.jsonFile('captures.json', { version: 1, inputRoots: ['.'], outcomes: 'outcomes.json' });
  f.jsonFile('routes.json', { version: 1, actions: [{ id: 'edit' }, { id: 'inspect' }], routes: intervals.map(({ journey }) => {
    const id = journey.slice(6, -4);
    return { id, argv: ['test', id], paths: [journey], journeys: [journey] };
  }) });
  const functions = { version: 1, kind: 'llvm-function-map', buildSha256: f.manifest.before.buildSha256,
    sourceManifestSha256: f.manifest.sourceManifestSha256, files: [{ path, sha256: f.hash(path), ranges: [[1, 4], [5, 7]] }] };
  f.jsonFile('functions.json', functions);
  const args = ['worklist', '--routes', 'routes.json', '--capture-set', 'captures.json', '--reference-root', '.', '--function-map', 'functions.json'];
  const report = f.json(...args);
  assert.equal(report.coverage.passedOnlyKnown.gapLines, 5);
  assert.equal(report.extensionCandidates.count, 0);
  assert.equal(report.functionReview.edgeCandidates.gapLines, 2);
  assert.equal(report.functionReview.edgeCandidates.count, 2);
  assert.equal(report.functionReview.edgeCandidates.items.length, 1, 'Do not schedule a duplicate selector');
  const [{ examples: [example], sources, marginalGapLines }] = report.functionReview.edgeCandidates.items;
  assert.equal(marginalGapLines, 2);
  assert.deepEqual(sources, [{ path, gapLines: 2, gapRanges: [[3, 4]] }]);
  assert.equal(example.observedAnchor, 2);
  assert.deepEqual(example.functionRange, [1, 4]);
  assert.deepEqual(example.actionIds, ['edit']);
  const shortlist = report.functionReview.scenarioExtensions;
  assert.equal(shortlist.count, 1);
  const [editFunction] = shortlist.items;
  assert.deepEqual([editFunction.path, editFunction.functionRange, editFunction.gapRanges], [path, [1, 4], [[3, 4]]]);
  assert.equal(editFunction.gapLines, 2);
  assert.equal(editFunction.cases.length, 1, 'Equivalent gap leads need one scenario to extend');
  assert.deepEqual(editFunction.cases[0].examples[0].actionIds, ['edit']);
  assert.deepEqual(f.json(...args, '--source', path + ':4').functionReview.scenarioExtensions.items[0].gapRanges, [[4, 4]]);
  assert.deepEqual(report.functionReview.entryPoints.items[0].gapRanges, [[5, 7]], 'Adjacent functions require their own evidence');
  assert.equal(f.json(...args, '--source', path + ':3', '--action', 'edit').actionReview.functionEdgeCandidates.gapLines, 1);
  assert.equal(f.json(...args, '--source', path, '--action', 'inspect').actionReview.functionEdgeCandidates.gapLines, 0);
  functions.files[0].ranges.push([3, 4]);
  f.jsonFile('functions.json', functions);
  assert.equal(f.json(...args).functionReview.edgeCandidates.gapLines, 0, 'Do not borrow an anchor from the enclosing function for an unentered closure');
  assert.deepEqual(f.json(...args).functionReview.scenarioExtensions.items, []);
});

test('worklist uses pinned function boundaries to distinguish a missing entry point from a scenario extension', t => {
  const f = project(t), path = 'src/app.py', journey = 'tests/editor.mjs';
  f.put(journey, '// An observed editing scenario.\n');
  f.jsonFile('routes.json', { version: 1, routes: [{ id: 'edit', argv: ['test', 'edit'], paths: [journey], journeys: [journey] }] });
  const { id } = f.json(...f.args);
  f.jsonFile('receipt.json', {});
  f.jsonFile('outcomes.json', { version: 1, intervals: [{ id, journey, status: 'passed',
    evidence: { path: 'receipt.json', sha256: f.hash('receipt.json') } }] });
  f.jsonFile('captures.json', { version: 1, inputRoots: ['.'], outcomes: 'outcomes.json' });
  const args = ['worklist', '--routes', 'routes.json', '--capture-set', 'captures.json', '--reference-root', '.'];
  const baseline = f.json(...args);
  assert.equal(baseline.extensionCandidates.gapLines, 1);
  const map = { version: 1, kind: 'llvm-function-map', buildSha256: f.manifest.before.buildSha256,
    sourceManifestSha256: f.manifest.sourceManifestSha256,
    files: [{ path, sha256: f.hash(path), ranges: [[1, 1], [2, 2], [3, 4]] }] };
  f.jsonFile('functions.json', map);
  const usingFunctions = [...args, '--function-map', 'functions.json'];
  const bounded = f.json(...usingFunctions);
  assert.deepEqual(bounded.coverage, baseline.coverage);
  assert.equal(bounded.extensionCandidates.gapLines, 0);
  assert.equal(bounded.functionReview.crossBoundaryGapLines, 1);
  assert.deepEqual(bounded.functionReview.entryPoints.items, [
    { path, start: 2, end: 2, gapLines: 1, gapRanges: [[2, 2]] },
  ]);
  assert.equal(f.json(...usingFunctions, '--source', 'src/app.py:3').functionReview.crossBoundaryGapLines, 0);
  map.files[0].ranges = [[1, 4], [2, 2]];
  f.jsonFile('functions.json', map);
  assert.equal(f.json(...usingFunctions).extensionCandidates.gapLines, 1);
  map.files[0].sha256 = '0'.repeat(64);
  f.jsonFile('functions.json', map);
  assert.match(f.run([...usingFunctions, '--json'], 1).stderr, /function map source/i);
  map.files[0].sha256 = f.hash(path);
  map.buildSha256 = '0'.repeat(64);
  f.jsonFile('functions.json', map);
  assert.match(f.run([...usingFunctions, '--json'], 1).stderr, /function map.*reference build/i);
});

test('worklist follows compiler calls from a passing CLI caller to a cold function', t => {
  const f = project(t), path = 'src/app.py', helper = 'src/recover.py';
  f.put(helper, 'def recover():\n    return fallback()\n');
  f.jsonFile('sources.json', { files: [path, helper].map(path => ({ path, sha256: f.hash(path) })) });
  f.manifest.sourceManifestSha256 = f.manifest.before.sourceManifestSha256 = f.manifest.after.sourceManifestSha256 = f.hash('sources.json');
  const helpers = f.record('DA:1,0\nDA:2,0').replace(path, helper);
  f.put('before.lcov', f.record('DA:1,0\nDA:2,0\nDA:3,0\nDA:4,0') + helpers);
  f.put('after.lcov', f.record('DA:1,1\nDA:2,0\nDA:3,0\nDA:4,1') + helpers);
  f.refresh();
  const { id } = f.json(...f.args);
  f.jsonFile('receipt.json', {});
  const outcome = { id, journey: 'tests/e2e/edit.mjs#recover', status: 'passed',
    evidence: { path: 'receipt.json', sha256: f.hash('receipt.json') } };
  const saveOutcomes = () => f.jsonFile('outcomes.json', { version: 1, intervals: [outcome] });
  saveOutcomes();
  f.jsonFile('captures.json', { version: 1, inputRoots: ['.'], outcomes: 'outcomes.json' });
  f.put('tests/e2e/edit.mjs', '// Scenario exercises edit and failed sync recovery.\n');
  f.jsonFile('discovery.json', { schemaVersion: 1, kind: 'native-cli-scenario-catalog',
    selection: { mode: 'all', availableScenarioCount: 1, selectedScenarioCount: 1 },
    scenarios: [{ id: 'edit', path: 'tests/e2e/edit.mjs', groups: ['recover'] }] });
  const exactCall = { caller: { path, line: 2 }, callee: { path: helper, start: 1, end: 2 } };
  const map = { version: 1, kind: 'llvm-function-map', buildSha256: f.manifest.before.buildSha256,
    sourceManifestSha256: f.manifest.sourceManifestSha256, files: [
      { path, sha256: f.hash(path), ranges: [[1, 2], [3, 3], [4, 4]] },
      { path: helper, sha256: f.hash(helper), ranges: [[1, 2]] },
    ], calls: [exactCall] };
  f.jsonFile('functions.json', map);
  const args = ['worklist', '--routes', 'discovery.json', '--capture-set', 'captures.json', '--reference-root', '.', '--function-map', 'functions.json'];
  const report = f.json(...args, '--source', helper);
  assert.equal(report.sourceFocus.gapLines, 2);
  assert.equal(report.coverage.passedOnlyKnown.observedLines, 2);
  assert.equal(report.functionReview.callers.session.gapLines, 2);
  const [candidate] = report.functionReview.callers.session.items;
  assert.deepEqual(candidate.argv, ['test', '--scenario', 'edit', '--group', 'recover']);
  assert.equal(candidate.examples[0].observedAnchor, 1);
  assert.deepEqual(candidate.examples[0].caller, { ...exactCall.caller, functionRange: [1, 2] });
  assert.deepEqual(report.nativeBatches.session.argv, ['test', '--case', 'edit#recover']);

  const originalRanges = map.files[0].ranges;
  map.files[0].ranges = [[1, 4], [1, 3]];
  f.jsonFile('functions.json', map);
  const registration = f.json(...args, '--source', helper);
  assert.equal(registration.functionReview.callers.session.gapLines, 0, 'A closure declaration does not observe its body');
  const [lead] = registration.functionReview.callers.declarations.session.items;
  assert.deepEqual(lead.argv, candidate.argv);
  assert.equal(lead.gapLines, 2);
  assert.equal(lead.examples[0].observedAnchor, 1);
  assert.deepEqual(lead.examples[0].caller.functionRange, [1, 3]);
  assert.deepEqual(registration.nativeBatches.session.argv, [], 'A declaration is a lead to inspect before scheduling a case');
  assert.deepEqual(registration.coverage, report.coverage);
  map.files[0].ranges = originalRanges;

  map.calls = [{ ...exactCall, caller: { path, line: 3 } }];
  f.jsonFile('functions.json', map);
  assert.equal(f.json(...args).functionReview.callers.session.gapLines, 0, 'Adjacent passing lines belong to other functions');
  map.calls = [{ ...exactCall, callee: { path: helper, start: 1, end: 1 } }];
  f.jsonFile('functions.json', map);
  assert.match(f.run(args, 1).stderr, /call.*function map/i);
  map.calls = [exactCall];
  f.jsonFile('functions.json', map);
  outcome.status = 'failed';
  saveOutcomes();
  assert.equal(f.json(...args).functionReview.callers.session.gapLines, 0);
});

test('native worklist separates launch evidence from recorded CLI actions and joins sparse instrumented gap lines', t => {
  const f = project(t);
  const scenario = id => ({ id: `journeys/${id}`, path: `tests/e2e/journeys/${id}.mjs` });
  const launch = scenario('unrelated-generation'), edit = scenario('editor'), failed = scenario('failed-edit');
  for (const route of [launch, edit, failed]) f.put(route.path, '// Scenario assertions.\n');
  f.jsonFile('discovery.json', { schemaVersion: 1, kind: 'native-cli-scenario-catalog',
    selection: { mode: 'all', availableScenarioCount: 3, selectedScenarioCount: 3 }, scenarios: [launch, edit, failed] });
  f.jsonFile('capabilities.json', { protocol: 1, driver: 'UIKit controls', commands: ['capabilities', 'menu-action', 'export-project'],
    semanticMenuActionScopes: ['script-entries'] });
  const code = Array.from({ length: 12 }, (_, i) => `line ${i + 1}\n`).join('');
  f.put('src/app.py', code);
  f.jsonFile('sources.json', { files: [{ path: 'src/app.py', sha256: sha(code) }] });
  f.manifest.sourceManifestSha256 = f.manifest.before.sourceManifestSha256 = f.manifest.after.sourceManifestSha256 = f.hash('sources.json');
  const lines = [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const capture = (journey, runId, actions, hits, { scopes = [], status = 'passed' } = {}) => {
    Object.assign(f.manifest, { runId, actions });
    if (scopes.length) f.manifest.actionLabels = scopes;
    else delete f.manifest.actionLabels;
    f.manifest.before.runId = f.manifest.after.runId = runId;
    f.put('before.lcov', f.record(lines.map(line => `DA:${line},0`).join('\n')));
    f.put('after.lcov', f.record(lines.map(line => `DA:${line},${Number(hits.includes(line))}`).join('\n')));
    f.refresh();
    const { id } = f.json(...f.args);
    const path = `${status}.json`;
    f.jsonFile(path, { status });
    return { id, journey: journey.path, status, evidence: { path, sha256: f.hash(path) } };
  };
  const startup = capture(launch, 'startup', ['launch isolated Scriv through the CLI', 'scriv capabilities'], [1, 5, 6, 8, 10, 12]);
  const action = capture(edit, 'action', ['scriv menu-action', 'scriv undocumented'], [1, 5, 10, 12],
    { scopes: ['scriv menu-action --scope script-entries'] });
  const failedAction = capture(failed, 'failed', ['scriv menu-action'], [6, 8], { status: 'failed' });
  f.jsonFile('outcomes.json', { version: 1, intervals: [startup, action, failedAction] });
  f.jsonFile('captures.json', { version: 1, inputRoots: ['.'], outcomes: 'outcomes.json' });
  const args = ['worklist', '--routes', 'discovery.json', '--capture-set', 'captures.json', '--reference-root', '.'];
  const report = f.json(...args);
  assert.equal(report.coverage.passedOnlyKnown.gapLines, 5);
  assert.deepEqual(report.extensionCandidates.items.map(({ routeIds, gapLines }) => [routeIds, gapLines]), [[[edit.id], 3]]);
  assert.deepEqual(report.extensionCandidates.items[0].sources[0].gapRanges, [[2, 2], [4, 4], [11, 11]]);
  assert.equal(report.startupCandidates.gapLines, 2);
  assert.deepEqual(report.nativeBatches.session.argv, ['test', '--case', edit.id]);
  assert.deepEqual(report.nativeBatches.startup.argv, ['test', '--coverage-startup', '--case', launch.id]);
  assert.equal(report.nativeBatches.session.candidateGapLines, 3);
  assert.equal(report.nativeBatches.startup.candidateGapLines, 2);
  assert.deepEqual(report.startupCandidates.items[0].sources[0].gapRanges, [[7, 7], [9, 9]]);
  assert.equal(report.startupCandidates.items[0].examples[0].intervalId, startup.id);
  assert.equal(report.unassigned.gapLines, 5, 'Planning does not give coverage credit');
  const actions = f.json(...args, '--capabilities', 'capabilities.json').extensionCandidates.items[0].examples;
  assert.deepEqual(actions[0].actionIds, ['menu-action', 'script-entries']);
  const actionArgs = [...args, '--source', 'src/app.py:2-11', '--capabilities', 'capabilities.json', '--action'];
  assert.equal(f.json(...actionArgs, 'script-entries').actionReview.extensionCandidates.gapLines, 3);
  const absentAction = f.json(...actionArgs, 'export-project').actionReview;
  assert.equal(absentAction.extensionCandidates.gapLines, 0);
  assert.deepEqual(absentAction.nativeBatch.argv, [], 'An empty shortlist cannot run the entire suite');
  const focused = f.json(...args, '--source', 'src/app.py:4');
  assert.equal(focused.extensionCandidates.gapLines, 1);
  assert.equal(focused.startupCandidates.gapLines, 0);
  for (const route of [edit, launch]) {
    f.run(['link', 'src/app.py:2', '--step', route.path + ':1', '--action', 'Use a discovered action',
      '--why', 'Check the outcome of the same source behavior']);
  }
  const overlap = f.json(...args).nativeBatches.session;
  assert.deepEqual(overlap.argv, ['test', '--case', edit.id], 'Combine witnessed and neighboring evidence before choosing cases');
  assert.equal(overlap.candidateGapLines, 3, 'The duplicate witness cannot add a case or duplicate a line');
});

test('focused worklist uses declared native group support witnesses beside uncovered lines', t => {
  const f = project(t);
  const { id } = f.json(...f.args);
  f.jsonFile('evidence.json', { status: 'passed' });
  f.jsonFile('outcomes.json', { version: 1, intervals: [{ id, journey: 'seed', status: 'passed',
    evidence: { path: 'evidence.json', sha256: f.hash('evidence.json') } }] });
  f.jsonFile('captures.json', { version: 1, inputRoots: ['.'], outcomes: 'outcomes.json' });
  const entry = 'tests/e2e/journeys/picture.mjs', unique = 'tests/e2e/journeys/support/follow.mjs';
  const shared = 'tests/e2e/journeys/support/shared.mjs';
  for (const path of [entry, unique, shared]) f.put(path, '// Reviewed fixture assertions.\n');
  const link = (line, file) => f.run(['link', `src/app.py:${line}`, '--step', `${file}:1`,
    '--action', 'Use the visible control', '--why', 'Verify captured fixture result']);
  link(1, unique);
  link(2, shared);
  const discovery = { schemaVersion: 1, kind: 'native-cli-scenario-catalog',
    selection: { mode: 'all', availableScenarioCount: 1, selectedScenarioCount: 1 },
    scenarios: [{ id: 'journeys/picture', path: entry, groups: ['follow', 'move'] }] };
  f.jsonFile('routes.json', discovery);
  const args = ['worklist', '--routes', 'routes.json', '--capture-set', 'captures.json', '--reference-root', '.',
    '--source', 'src/app.py:1-2'];
  const baseline = f.json(...args);
  assert.equal(baseline.links.witnessWithoutRoute, 2);
  const row = discovery.scenarios[0];
  row.groupWitnessPaths = { follow: [unique, shared], move: [shared] };
  f.jsonFile('routes.json', discovery);
  const report = f.json(...args);
  assert.deepEqual(report.coverage, baseline.coverage);
  assert.equal(report.links.witnessWithoutRoute, 0);
  assert.equal(report.focusedWitnessRoutes.count, 1);
  assert.deepEqual(report.focusedWitnessRoutes.items.map(({ argv, witnessPaths }) => ({ argv, witnessPaths })), [
    { argv: ['test', '--scenario', 'journeys/picture', '--group', 'follow'], witnessPaths: [unique] },
  ]);
  assert.deepEqual(report.routes, [], 'Covered witnesses gain no uncovered-line score');
  assert.deepEqual(report.selectorReview.items[0].candidates.map(candidate => candidate.argv.at(-1)), ['follow', 'move']);
  f.put(unique, '// Changed assertions need review.\n');
  assert.equal(f.json(...args).focusedWitnessRoutes.count, 0);
  const alias = 'tests/e2e/journeys/support/alias.mjs';
  symlinkSync(join(f.root, shared), join(f.root, alias));
  for (const bad of [{ unknown: [unique] }, { follow: [entry] }, { follow: [unique, unique] },
    { follow: ['tests/e2e/../outside.mjs'] }, { follow: [alias] }]) {
    row.groupWitnessPaths = bad;
    f.jsonFile('routes.json', discovery);
    assert.equal(f.run([...args, '--json'], 1).stdout, '');
  }
});

test('native batch builds a reusable capture set from a verified Scriv receipt', t => {
  const base = project(t), run = project(t);
  const { id: baselineID } = base.json(...base.args);
  base.jsonFile('passed.json', { status: 'passed' });
  base.jsonFile('outcomes.json', { version: 1, intervals: [{ id: baselineID, journey: 'baseline', status: 'passed',
    evidence: { path: 'passed.json', sha256: base.hash('passed.json') } }] });
  base.jsonFile('captures.json', { version: 1, inputRoots: ['.'], outcomes: 'outcomes.json', scope: 'source-lines' });
  const runID = '90e44128-7562-459d-87e1-c723990f9d04';
  run.manifest.runId = run.manifest.before.runId = run.manifest.after.runId = runID;
  run.put('after.lcov', run.record('DA:1,1\nDA:2,1\nDA:3,9'));
  run.refresh(); const imported = run.json(...run.args);
  const analysis = 'coverage/analysis/source';
  run.put(`${analysis}/src/app.py`, source);
  run.put(`${analysis}/${dataPath}`, readFileSync(join(run.root, dataPath)));
  execFileSync('git', ['init', '-q'], { cwd: join(run.root, analysis) });
  run.jsonFile(`coverage/sessions/${runID}/import.json`, imported);
  const scenario = 'tests/e2e/journeys/editor.mjs', group = 'reconnect';
  const receipt = { schemaVersion: 1, kind: 'actual-app-cli-scenarios', status: 'passed', sourceUnchanged: true, appUnchanged: true,
    startedAt: '2026-11-25T00:00:00.000Z', endedAt: '2026-11-25T00:00:07.000Z',
    app: { executableSHA256: run.manifest.before.buildSha256 }, selection: { group }, scenarios: [{ scenario, group, status: 'passed' }],
    coverage: { status: 'imported', imported: 1, sourceManifestSHA256: run.manifest.sourceManifestSha256, probeSHA256: run.manifest.probeSha256,
      analysis: { version: 1, kind: 'scriv-external-coverage-analysis', root: join(run.root, analysis),
        dataset: join(run.root, analysis, dataPath), sourceManifestSHA256: run.manifest.sourceManifestSha256, sourceUnchanged: true },
      intervals: [{ runID, scenario, group, scenarioStatus: 'passed', status: 'imported', imported: true }] } };
  run.jsonFile('evidence.json', receipt);
  const args = ['measure', 'batch', '--baseline-capture-set', 'captures.json', '--receipt', join(run.root, 'evidence.json'), '--reference-root', '.'];
  const out = join(run.root, 'accepted');
  const result = base.json(...args, '--output', out);
  assert.equal(result.kind, 'native-measurement-batch');
  assert.deepEqual(result.passedOnlyKnown, { files: 1, instrumentedLines: 3, observedLines: 3, gapLines: 0, percent: 100 });
  assert.equal(result.comparison.gainedLines, 1);
  assert.equal(result.comparison.lostLines, 0);
  assert.equal(result.receipts[0].elapsedSeconds, 7);
  const captures = join(out, 'captures.json');
  const quality = base.json('measure', 'gaps', '--capture-set', captures, '--baseline-capture-set', 'captures.json', '--reference-root', '.');
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'report.json'))), quality);
  assert.equal(quality.outcomes.declarations.find(row => row.id === imported.id).journey, `${scenario}#${group}`);
  base.run([...args, '--output', out, '--json'], 1);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'report.json'))), quality);
  const rejected = join(run.root, 'rejected');
  receipt.coverage.intervals[0].scenarioStatus = 'failed';
  run.jsonFile('evidence.json', receipt);
  const failure = base.run([...args, '--output', rejected, '--json'], 1);
  assert.match(failure.stderr, /scenario outcome/i);
  assert.equal(existsSync(rejected), false);

  receipt.status = receipt.scenarios[0].status = 'failed';
  run.jsonFile('evidence.json', receipt);
  const failedOutput = join(run.root, 'retained-failure');
  const failed = base.json(...args, '--output', failedOutput);
  assert.equal(failed.comparison.gainedLines, 0);
  assert.equal(failed.passedOnlyKnown.observedLines, 2);
  const failedReport = JSON.parse(readFileSync(join(failedOutput, 'report.json')));
  assert.equal(failedReport.allObserved.observedLines, 3);
  assert.equal(failedReport.intervals.outcomes.failed, 1);
  base.run([...args, '--receipt', join(run.root, 'evidence.json'), '--output', rejected, '--json'], 1);
  base.run([...args, '--output', join(run.root, analysis, 'new-batch'), '--json'], 1);
  assert.equal(existsSync(rejected), false);
  assert.equal(existsSync(join(run.root, analysis, 'new-batch')), false);

  const secondID = '872cb0cb-6ad7-4da1-8ef9-03e037befdf3', secondGroup = 'missing-history';
  run.manifest.runId = run.manifest.before.runId = run.manifest.after.runId = secondID;
  run.refresh();
  const secondImport = run.json(...run.args);
  run.put(`${analysis}/${dataPath}`, readFileSync(join(run.root, dataPath)));
  run.jsonFile(`coverage/sessions/${secondID}/import.json`, secondImport);
  const cases = [{ scenario, group }, { scenario, group: secondGroup }];
  receipt.status = 'passed';
  receipt.selection = { mode: 'subset', availableScenarioCount: 1, selectedScenarioCount: 2, cases };
  receipt.scenarios = cases.map((row, index) => ({ ...row, status: 'passed',
    startedAt: `2026-11-25T00:00:0${index * 2}.000Z`, endedAt: `2026-11-25T00:00:0${index * 2 + 1}.000Z` }));
  receipt.coverage.invocationID = '7d8c88ef-6fd9-435c-8568-4c1c1afa08ba';
  receipt.coverage.imported = 2;
  receipt.coverage.intervals = cases.map((row, index) => ({ ...row, runID: [runID, secondID][index],
    scenarioStatus: 'passed', status: 'imported', imported: true }));
  for (const row of receipt.coverage.intervals) run.jsonFile(`coverage/sessions/${row.runID}/session.json`, {
    version: 1, kind: 'scriv-session-coverage', status: 'captured', invocationID: receipt.coverage.invocationID,
    runID: row.runID, scenario: row.scenario, group: row.group, probeSHA256: receipt.coverage.probeSHA256,
    executableSHA256: receipt.app.executableSHA256, executableUnchanged: true, sourceManifestSHA256: receipt.coverage.sourceManifestSHA256,
  });
  run.jsonFile('evidence.json', receipt);
  const groupedOutput = join(run.root, 'grouped-cases');
  const batch = base.json(...args, '--output', groupedOutput);
  assert.equal(batch.comparison.gainedLines, 1, 'Two cases that reach the same new line count it once');
  assert.deepEqual(batch.receipts[0].cases, cases.map(row => ({ ...row, status: 'passed', elapsedSeconds: 1, intervals: 1 })));
  const grouped = JSON.parse(readFileSync(join(groupedOutput, 'report.json')));
  assert.equal(grouped.outcomes.declarations.find(row => row.id === secondImport.id).journey, `${scenario}#${secondGroup}`);
  const inputRoots = ['.'];
  const baselineDataset = readFileSync(join(base.root, dataPath));
  for (let index = 1; index < 256; index++) {
    const name = `retained/analysis-${index}`;
    base.put(`${name}/src/app.py`, source);
    base.put(`${name}/${dataPath}`, baselineDataset);
    execFileSync('git', ['init', '-q'], { cwd: join(base.root, name) });
    inputRoots.push(name);
  }
  base.jsonFile('large-captures.json', { version: 1, inputRoots, outcomes: 'outcomes.json', scope: 'source-lines' });
  const largeOutput = join(run.root, 'large-batch');
  const largeBatch = base.json('measure', 'batch', '--baseline-capture-set', 'large-captures.json', '--receipt',
    join(run.root, 'evidence.json'), '--reference-root', '.', '--output', largeOutput);
  const large = JSON.parse(readFileSync(join(largeOutput, 'report.json')));
  assert.equal(large.origins.length, 257);
  assert.equal(large.intervals.duplicates, 255);
  assert.deepEqual(largeBatch.passedOnlyKnown, batch.passedOnlyKnown);
  assert.equal(largeBatch.comparison.gainedLines, 1);
  assert.equal(largeBatch.comparison.lostLines, 0);
  base.jsonFile('large-series.json', { version: 1, captureSets: ['large-captures.json', largeBatch.captureSet] });
  const series = base.json('measure', 'gaps', '--reference-root', '.', '--series', 'large-series.json');
  assert.deepEqual(series.reports[0], large);
  receipt.coverage.intervals[0].group = secondGroup;
  run.jsonFile('evidence.json', receipt);
  assert.match(base.run([...args, '--output', rejected, '--json'], 1).stderr, /session.*case/i);
  assert.equal(existsSync(rejected), false);
  receipt.coverage.intervals[0].group = group;
  receipt.selection.cases.reverse();
  run.jsonFile('evidence.json', receipt);
  assert.match(base.run([...args, '--output', rejected, '--json'], 1).stderr, /case selection/i);
});

test('combined worklist respects current reviewed dispositions without hiding shared or stale gaps', t => {
  const f = project(t), path = 'tests/e2e/edit.mjs';
  f.put(path, '// Exact native scenario witness\n');
  const { id } = f.json(...f.args);
  f.jsonFile('evidence.json', { status: 'passed' });
  f.jsonFile('outcomes.json', { version: 1, intervals: [{ id, journey: path, status: 'passed',
    evidence: { path: 'evidence.json', sha256: f.hash('evidence.json') } }] });
  f.jsonFile('captures.json', { version: 1, inputRoots: ['.'], outcomes: 'outcomes.json' });
  f.jsonFile('discovery.json', { schemaVersion: 1, kind: 'native-cli-scenario-catalog',
    selection: { mode: 'all', availableScenarioCount: 1, selectedScenarioCount: 1 }, scenarios: [{ id: 'edit', path }] });
  f.jsonFile('capabilities.json', { protocol: 1, driver: 'UIKit controls', commands: ['activate'], semanticMenuActionScopes: ['edit-scope'] });
  const plan = (id, extra = {}) => ({ id, title: id, featureId: 'editing', state: 'needs-extension', existingPaths: [path],
    entryPoint: { path: 'src/app.py', symbol: 'change' }, actionIds: ['activate', 'edit-scope'],
    plannedActions: ['Change'], expectedOutcomes: ['Visible result'], ...extra });
  const draft = { schemaVersion: 1, kind: 'proposed-scenario-association-map', status: 'model-proposed-unreviewed',
    scenarios: [plan('held', { restriction: 'Fixture denies device pairing' }), plan('allowed'), plan('missing', { actionIds: ['drag'] })],
    associations: [{ rangeId: 'active', featureId: 'editing', status: 'model-proposed-unreviewed',
      source: { path: 'src/app.py', start: 2, end: 2 }, rationale: 'Known runtime conditions', confidence: 'high', uncertainty: '',
      proposedAssertions: ['Visible result'], scenarioIds: ['held'] }] };
  f.jsonFile('draft.json', draft);
  const prepared = f.json('proposal', 'prepare', '--file', 'draft.json');
  const args = ['worklist', '--file', 'proposal.json', '--capabilities', 'capabilities.json', '--routes', 'discovery.json',
    '--capture-set', 'captures.json', '--reference-root', '.'];
  const report = ids => {
    const proposal = structuredClone(prepared);
    proposal.associations[0].scenarioIds = ids;
    f.jsonFile('proposal.json', proposal);
    return f.json(...args);
  };
  const blocked = report(['held']);
  assert.equal(blocked.kind, 'source-coverage-worklist');
  assert.equal(blocked.coverage.passedOnlyKnown.gapLines, 1);
  assert.equal(blocked.extensionCandidates.gapLines, 0);
  assert.equal(blocked.decisions.heldGapLines, 1);
  assert.equal(blocked.decisions.proposal.capabilitiesSha256, f.hash('capabilities.json'));
  assert.deepEqual(blocked.decisions.queues.blocked.items[0].restrictions, ['Fixture denies device pairing']);
  assert.equal(blocked.nextStep.kind, 'resolve-blocker');
  assert.equal(blocked.nextStep.from, 'decisions.queues.blocked.items');
  const proposed = f.json('proposal', ...args);
  assert.equal(proposed.nextStep.from, 'queues.blocked.items');
  const scoped = f.json(...args, '--source', 'src/app.py:1');
  assert.deepEqual(scoped.coverage, blocked.coverage);
  assert.equal(scoped.sourceFocus.observedPassingLines, 1);
  assert.equal(scoped.decisions.heldGapLines, 0);
  assert.equal(scoped.extensionCandidates.gapLines, 0);
  const missing = report(['missing']);
  assert.equal(missing.extensionCandidates.gapLines, 0);
  assert.deepEqual(missing.decisions.queues['needs-cli-action'].items[0].missingActionIds, ['drag']);
  assert.equal(missing.nextStep.kind, 'review-cli-action');
  assert.equal(missing.nextStep.from, 'decisions.queues.needs-cli-action.items');
  const shared = report(['held', 'allowed']);
  assert.equal(shared.decisions.heldGapLines, 0);
  assert.equal(shared.extensionCandidates.gapLines, 1);
  assert.equal(shared.nextStep.kind, 'inspect-existing-case', 'Independent runnable work takes priority over a held alternative');
  assert.equal(shared.decisions.queues['needs-scenario'].items[0].planId, 'allowed');
  prepared.associations[0].source.fileSha256 = '0'.repeat(64);
  const stale = report(['held']);
  assert.equal(stale.decisions.heldGapLines, 0);
  assert.equal(stale.extensionCandidates.gapLines, 1);
  assert.equal(stale.unassigned.gapLines, 1);

  prepared.associations[0].source.fileSha256 = f.hash('src/app.py');
  f.run(['link', 'src/app.py:2', '--action', 'activate', '--step', `${path}:1`, '--why', 'Existing witness for a shared entry point.']);
  const heldWitness = report(['held']);
  assert.equal(heldWitness.linkedGapLines, 0);
  assert.equal(heldWitness.routeCount, 0);
  assert.equal(heldWitness.decisions.classifiedGapLines, 1);
  assert.equal(heldWitness.unassigned.gapLines, 0);
  const sharedWitness = report(['held', 'allowed']);
  assert.equal(sharedWitness.linkedGapLines, 1);
  assert.equal(sharedWitness.routes[0].gapLines, 1);
  assert.equal(sharedWitness.decisions.classifiedGapLines, 1);

  f.jsonFile('discovery.json', { schemaVersion: 1, kind: 'native-cli-scenario-catalog',
    selection: { mode: 'all', availableScenarioCount: 1, selectedScenarioCount: 1 },
    scenarios: [{ id: 'edit', path, groups: ['recover', 'review'], groupActions: { recover: [{
      id: 'edit-line', command: 'activate', condition: 'valid-edit',
      entryPoint: { path: 'src/app.py', start: 1, end: 4, sha256: f.hash('src/app.py') },
    }] } }] });
  report(['held']);
  for (const selector of [['--source', 'src/app.py:2'], ['--source', 'src/app.py:2', '--action', 'edit-line'], ['--action', 'edit-line']]) {
    const heldAction = f.json(...args, ...selector);
    assert.equal(heldAction.actionCases.count, 1, 'Discovery remains visible without overriding the reviewed blocker');
    assert.equal(heldAction.nextStep.kind, 'resolve-blocker');
    assert.equal(heldAction.actionCases.items[0].cases[0].next, 'resolve-blocker');
  }
  report(['held', 'allowed']);
  assert.equal(f.json(...args, '--source', 'src/app.py:2').nextStep.kind, 'use-action-cases');
  prepared.scenarios.find(row => row.id === 'allowed').routeIds = ['edit/group/recover'];
  const exact = report(['allowed']);
  assert.deepEqual(exact.decisions.queues['needs-scenario'].items[0].routeIds, ['edit/group/recover']);
  assert.deepEqual(exact.decisions.nativeBatch.argv, ['test', '--case', 'edit#recover']);
  assert.equal(exact.decisions.nativeBatch.candidateGapLines, 1);
  assert.equal(exact.nextStep.from, 'decisions.nativeBatch');
  assert.deepEqual(exact.coverage, blocked.coverage, 'A planned selector adds no observations');

  const allowed = prepared.scenarios.find(row => row.id === 'allowed');
  allowed.captureMode = 'startup';
  allowed.actionIds = ['--startup-trace'];
  f.jsonFile('discovery.json', { schemaVersion: 1, kind: 'native-cli-scenario-catalog',
    selection: { mode: 'all', availableScenarioCount: 1, selectedScenarioCount: 1 },
    launchModes: ['--startup-trace'], scenarios: [{ id: 'edit', path, groups: ['recover', 'review'] }] });
  const startup = report(['allowed']);
  assert.deepEqual(startup.decisions.nativeBatch.argv, []);
  assert.deepEqual(startup.decisions.nativeStartupBatch.argv, ['test', '--coverage-startup', '--case', 'edit#recover']);
  assert.equal(startup.decisions.queues['needs-scenario'].items[0].captureMode, 'startup');
  assert.equal(startup.nextStep.from, 'decisions.nativeStartupBatch');
  assert.deepEqual(startup.coverage, exact.coverage);
  allowed.captureMode = 'unknown';
  f.jsonFile('proposal.json', prepared);
  assert.match(f.run(args, 1).stderr, /invalid.*capture mode/i);
  delete allowed.captureMode;

  prepared.scenarios.find(row => row.id === 'allowed').routeIds = ['edit/group/missing'];
  const missingRoute = report(['allowed']);
  assert.deepEqual(missingRoute.decisions.queues['needs-scenario'].items[0].routeIds, []);
  assert.deepEqual(missingRoute.decisions.queues['needs-scenario'].items[0].unmatchedRouteIds, ['edit/group/missing']);
  assert.deepEqual(missingRoute.decisions.nativeBatch.argv, []);
  prepared.scenarios.find(row => row.id === 'allowed').routeIds = ['edit', 'edit'];
  f.jsonFile('proposal.json', prepared);
  assert.match(f.run(args, 1).stderr, /duplicate.*route id/i);
});

test('worklist ranks fresh replays from retained passing evidence without crediting changed source', t => {
  const old = project(t), alternate = project(t), f = project(t), path = 'src/app.py';
  const previous = 'start\nalpha\nrecover one\nomega\nmiddle\nrepeat\nrepeat\nrepeat\nrepeat\nbefore\nrecover two\nafter\nrecover three\nlast\nfinish\n';
  const updated = 'new header\n' + previous.replace('middle\n', 'new middle\n');
  function prepare(project, text, lines) {
    project.put(path, text);
    project.jsonFile('sources.json', { files: [{ path, sha256: project.hash(path) }] });
    project.manifest.sourceManifestSha256 = project.manifest.before.sourceManifestSha256
      = project.manifest.after.sourceManifestSha256 = project.hash('sources.json');
    project.put('before.lcov', project.record(lines.map(line => `DA:${line},0`).join('\n')));
    return (journey, increased, status = 'passed') => {
      project.manifest.runId = project.manifest.before.runId = project.manifest.after.runId = journey;
      project.put('after.lcov', project.record(lines.map(line => `DA:${line},${Number(increased.includes(line))}`).join('\n')));
      project.refresh();
      const { id } = project.json(...project.args);
      const evidence = `${status}.json`;
      project.jsonFile(evidence, { status });
      return { id, journey, status, evidence: { path: join(project.root, evidence), sha256: project.hash(evidence) } };
    };
  }
  const oldCapture = prepare(old, previous, Array.from({ length: 15 }, (_, i) => i + 1));
  const capture = prepare(f, updated, Array.from({ length: 16 }, (_, i) => i + 1));
  const alternateCapture = prepare(alternate, updated, [1, 5, 16]);
  const outcomes = [oldCapture('alpha', [3, 7, 11]), oldCapture('beta', [3, 13]),
    oldCapture('failed', [14], 'failed'), oldCapture('restricted', [2]), oldCapture('rerun', [15]), capture('rerun', [2]),
    alternateCapture('table', [5])];
  f.jsonFile('outcomes.json', { version: 1, intervals: outcomes });
  f.jsonFile('captures.json', { version: 1, inputRoots: [old.root, alternate.root, '.'], outcomes: 'outcomes.json' });
  f.put('tests/flow.mjs', '// Scenario witness\n');
  const route = (id, journey, extra = {}) => ({ id, argv: ['test', journey], paths: ['tests/flow.mjs'], journeys: [journey], ...extra });
  f.jsonFile('routes.json', { version: 1, routes: ['alpha', 'beta', 'failed', 'rerun', 'table'].map(id => route(id, id)).concat(
    route('alpha-alias', 'alpha'), route('restricted', 'restricted', { restriction: 'No permitted device' })) });
  const args = ['worklist', '--routes', 'routes.json', '--capture-set', 'captures.json', '--reference-root', '.'];
  const direct = f.json(...args), report = f.json(...args, '--replay');
  assert.deepEqual(report.coverage, direct.coverage);
  assert.deepEqual(report.unassigned, direct.unassigned);
  assert.equal(report.coverage.passedOnlyKnown.observedLines, 1);
  assert.equal(report.replayCandidates.gapLines, 4);
  assert.deepEqual(report.replayCandidates.items.map(({ argv, routeIds, gapLines, marginalGapLines, sources }) =>
    [argv, routeIds, gapLines, marginalGapLines, sources[0].gapRanges]), [
    [['test', 'alpha'], ['alpha', 'alpha-alias'], 2, 2, [[4, 4], [12, 12]]],
    [['test', 'beta'], ['beta'], 2, 1, [[4, 4], [14, 14]]],
    [['test', 'table'], ['table'], 1, 1, [[5, 5]]],
  ]);
  const limited = f.json(...args, '--replay', '--limit', '1');
  assert.equal(limited.replayCandidates.gapLines, 4);
  assert.equal(limited.replayCandidates.items.length, 1);
  const focused = f.json(...args, '--replay', '--source', 'src/app.py:12-14');
  assert.equal(focused.replayCandidates.gapLines, 2);
  assert.deepEqual(focused.replayCandidates.items.map(r => r.sources[0].gapRanges), [[[12, 12]], [[14, 14]]]);

  const currentFailure = capture('alpha', [3], 'failed');
  const journey = 'tests/e2e/journeys/alpha.mjs';
  const diagnostic = { code: 'ui-target-ambiguous', location: { path: journey, line: 23 }, matches: 2 };
  f.jsonFile('scriv-failed.json', { schemaVersion: 1, kind: 'actual-app-cli-scenarios', status: 'failed',
    scenarios: [{ scenario: journey, status: 'failed', diagnostic: { ...diagnostic, privateNote: 'not exported' } }] });
  currentFailure.evidence = { path: join(f.root, 'scriv-failed.json'), sha256: f.hash('scriv-failed.json') };
  currentFailure.journey = journey;
  const catalog = JSON.parse(readFileSync(join(f.root, 'routes.json')));
  catalog.routes[0].journeys.push(journey);
  f.jsonFile('routes.json', catalog);
  f.jsonFile('outcomes.json', { version: 1, intervals: [...outcomes, currentFailure] });
  const reviewed = f.json(...args, '--replay');
  assert.deepEqual(reviewed.coverage.passedOnlyKnown, report.coverage.passedOnlyKnown);
  assert.deepEqual(reviewed.replayCandidates.items.map(row => row.argv), [['test', 'beta'], ['test', 'table']]);
  assert.equal(reviewed.failedReplays.gapLines, 2);
  assert.equal(reviewed.nextStep.kind, 'repair-existing-case');
  assert.deepEqual(reviewed.failedReplays.items[0].routeIds, ['alpha', 'alpha-alias']);
  assert.equal(reviewed.failedReplays.items[0].failure.journey, journey);
  assert.deepEqual(reviewed.failedReplays.items[0].failure.diagnostic, diagnostic);
  assert.equal(reviewed.failedReplays.items[0].failure.evidence.sha256, currentFailure.evidence.sha256);
  f.jsonFile('scriv-failed.json', { schemaVersion: 1, kind: 'actual-app-cli-scenarios', status: 'failed',
    scenarios: [{ scenario: journey, status: 'failed', diagnostic: {
      code: 'ui-target-ambiguous', location: { path: '../private-output.mjs', line: 23 }, matches: 'invalid',
    } }] });
  currentFailure.evidence.sha256 = f.hash('scriv-failed.json');
  f.jsonFile('outcomes.json', { version: 1, intervals: [...outcomes, currentFailure] });
  assert.deepEqual(f.json(...args, '--replay').failedReplays.items[0].failure.diagnostic, { code: 'ui-target-ambiguous' });
  const recovered = capture('alpha', [4, 12]);
  f.jsonFile('outcomes.json', { version: 1, intervals: [...outcomes, currentFailure, recovered] });
  assert.equal(f.json(...args, '--replay').failedReplays.count, 0);

  old.put(path, previous + 'stale snapshot\n');
  assert.equal(f.json(...args, '--replay').replayCandidates.gapLines, 1);
});

test('native worklist keeps startup replays separate from regular case outcomes', t => {
  const earlier = project(t), current = project(t), path = 'src/app.py';
  const previous = 'opening line\nprepare the environment\nhandshake boundary\nregular interaction\nvisible status\nexit normally\n';
  const updated = 'new file heading\n' + previous;
  const id = 'journeys/recovery', witness = 'tests/e2e/journeys/recovery.mjs', group = 'cold';
  const journey = witness + '#' + group;
  const startup = ['launch isolated Scriv through the CLI', 'scriv capabilities'];
  const session = ['scriv capabilities', 'scriv activate'];
  function prepare(f, text) {
    f.put(path, text);
    f.jsonFile('sources.json', { files: [{ path, sha256: f.hash(path) }] });
    f.manifest.sourceManifestSha256 = f.manifest.before.sourceManifestSha256
      = f.manifest.after.sourceManifestSha256 = f.hash('sources.json');
    const lines = text.trimEnd().split('\n').map((_, index) => index + 1);
    f.put('before.lcov', f.record(lines.map(line => `DA:${line},0`).join('\n')));
    return (runId, actions, hits, status = 'passed') => {
      Object.assign(f.manifest, { runId, actions });
      f.manifest.before.runId = f.manifest.after.runId = runId;
      f.put('after.lcov', f.record(lines.map(line => `DA:${line},${Number(hits.includes(line))}`).join('\n')));
      f.refresh();
      const { id } = f.json(...f.args);
      const evidence = runId + '.json';
      f.jsonFile(evidence, { status });
      return { id, journey, status, evidence: { path: join(f.root, evidence), sha256: f.hash(evidence) } };
    };
  }
  const captureEarlier = prepare(earlier, previous), captureCurrent = prepare(current, updated);
  current.put(witness, '// Reviewed native case.\n');
  current.jsonFile('discovery.json', { schemaVersion: 1, kind: 'native-cli-scenario-catalog',
    selection: { mode: 'all', availableScenarioCount: 1, selectedScenarioCount: 1 },
    launchModes: ['--startup-trace'], scenarios: [{ id, path: witness, groups: [group] }] });
  current.jsonFile('captures.json', { version: 1, inputRoots: [earlier.root, '.'], outcomes: 'outcomes.json' });
  const outcomes = [captureEarlier('earlier-startup', startup, [2]), captureEarlier('earlier-session', session, [4]),
    captureCurrent('current-session', session, [7]), captureCurrent('failed-session', session, [6], 'failed')];
  function report() {
    current.jsonFile('outcomes.json', { version: 1, intervals: outcomes });
    return current.json('worklist', '--replay', '--routes', 'discovery.json', '--capture-set', 'captures.json', '--reference-root', '.');
  }
  const initial = report();
  const startupArgv = ['test', '--scenario', id, '--group', group, '--coverage-startup'];
  assert.deepEqual(initial.replayCandidates.items.map(row => [row.argv, row.sources[0].gapRanges]), [[startupArgv, [[3, 3]]]]);
  assert.equal(initial.failedReplays.count, 0, 'A regular failure cannot block startup');
  assert.equal(initial.coverage.passedOnlyKnown.observedLines, 1);

  outcomes.push(captureCurrent('failed-startup', startup, [], 'failed'));
  const failed = report();
  assert.equal(failed.replayCandidates.count, 0);
  assert.deepEqual(failed.failedReplays.items.map(row => row.argv), [startupArgv]);
  assert.equal(failed.coverage.passedOnlyKnown.observedLines, 1);

  outcomes.push(captureCurrent('current-startup', startup, [3]));
  const recovered = report();
  assert.equal(recovered.replayCandidates.count, 0);
  assert.equal(recovered.failedReplays.count, 0);
  assert.equal(recovered.coverage.passedOnlyKnown.observedLines, 2);
});

test('worklist guides branch-state case reuse, extension and repair without executing the app', t => {
  const f = project(t), path = 'src/app.py', journey = 'tests/e2e/journeys/editor.mjs';
  f.manifest.actions = ['scriv key']; f.save();
  const first = f.json(...f.args).id;
  f.put(journey, '// Existing cases drive the edit shortcut and assert its result.\n');
  f.put('sentinel.mjs', "import { writeFileSync } from 'node:fs'; writeFileSync('app-launched', 'unexpected');\n");
  f.jsonFile('tracer.json', { version: 1, app: [process.execPath, 'sentinel.mjs'] });
  f.run(['init']);
  const action = { id: 'edit-line', command: 'key', trigger: 'Command-Return',
    entryPoint: { path, start: 1, end: 4, sha256: f.hash(path) } };
  const scenario = { id: 'journeys/editor', path: journey, groups: ['available', 'locked'], groupActions: {
    available: [{ ...action, condition: 'lease-available' }],
    locked: [{ ...action, condition: 'lease-held-by-peer' }],
  } };
  const discovery = { schemaVersion: 1, kind: 'native-cli-scenario-catalog',
    selection: { mode: 'all', availableScenarioCount: 1, selectedScenarioCount: 1 }, scenarios: [scenario] };
  f.jsonFile('discovery.json', discovery);
  f.jsonFile('capabilities.json', { protocol: 1, driver: 'UIKit controls', commands: ['key'] });
  f.jsonFile('receipt.json', { fixture: 'synthetic producer receipt' });
  const evidence = { path: 'receipt.json', sha256: f.hash('receipt.json') };
  const outcome = (id, group, status) => ({ id, journey: `${journey}#${group}`, status, evidence });
  const passed = outcome(first, 'available', 'passed');
  f.jsonFile('outcomes.json', { version: 1, intervals: [passed] });
  f.jsonFile('captures.json', { version: 1, inputRoots: ['.'], outcomes: 'outcomes.json' });
  const lookup = ['worklist', '--routes', 'discovery.json'];
  const measured = [...lookup, '--capture-set', 'captures.json', '--reference-root', '.'];
  const cases = report => report.actionCases.items[0].cases;
  const next = report => cases(report).map(row => row.next);
  const protectedFiles = [path, 'docs/testing/code-e2e-links.json', 'before.lcov', 'after.lcov', dataPath, 'captures.json'];
  const before = protectedFiles.map(file => [file, f.hash(file)]);

  const preview = f.json(...lookup, '--action', 'edit-line');
  assert.equal(preview.nextStep.kind, 'use-action-cases');
  assert.equal(preview.nextStep.from, 'actionCases.items');
  assert.ok(preview.nextStep.recipe.includes('triggering state and owned fixture setup'));
  assert.deepEqual(next(preview), ['review-and-run-existing-case', 'review-and-run-existing-case']);
  assert.deepEqual(cases(preview).map(row => row.argv), [
    ['test', '--case', 'journeys/editor#available'], ['test', '--case', 'journeys/editor#locked'],
  ]);
  assert.equal(cases(preview)[0].evidence, undefined, 'Discovery guidance cannot manufacture outcomes');
  assert.deepEqual(next(f.json(...measured, '--action', 'edit-line')),
    ['reuse-passing-evidence', 'review-and-run-existing-case'], 'Reuse compatible evidence before rerunning');
  for (const selector of [['--source', `${path}:2`], ['--action', 'edit-line', '--source', `${path}:2`]]) {
    const focused = f.json(...measured, ...selector);
    assert.equal(focused.sourceFocus.gapLines, 1);
    assert.deepEqual(next(focused), ['extend-existing-case', 'review-and-run-existing-case']);
    assert.equal(cases(focused)[0].evidence.observedLines, 0);
  }
  assert.deepEqual(next(f.json(...measured, '--action', 'edit-line', '--source', `${path}:4`)),
    ['resolve-measurement', 'review-and-run-existing-case'], 'Missing instrumentation stays unknown');
  assert.equal(f.json(...measured, '--source', `${path}:4`).nextStep.kind, 'resolve-measurement');
  assert.deepEqual(protectedFiles.map(file => [file, f.hash(file)]), before);
  assert.equal(existsSync(join(f.root, 'app-launched')), false);

  f.jsonFile('capabilities.json', { protocol: 1, driver: 'UIKit controls', commands: ['snapshot'] });
  assert.deepEqual(next(f.json(...lookup, '--action', 'edit-line', '--capabilities', 'capabilities.json')),
    ['review-cli-action', 'review-cli-action']);
  f.jsonFile('outcomes.json', { version: 1, intervals: [outcome(first, 'available', 'failed')] });
  assert.deepEqual(next(f.json(...measured, '--action', 'edit-line', '--source', `${path}:2`)),
    ['repair-existing-case', 'review-and-run-existing-case']);

  f.manifest.runId = f.manifest.before.runId = f.manifest.after.runId = 'synthetic-guidance-run-2';
  f.put('after.lcov', f.record('DA:1,3\nDA:2,1\nDA:3,10')); f.refresh();
  const second = f.json(...f.args).id;
  f.jsonFile('outcomes.json', { version: 1, intervals: [passed, outcome(second, 'available', 'failed')] });
  assert.equal(next(f.json(...measured, '--action', 'edit-line'))[0], 'review-case-outcomes',
    'Mixed historical outcomes require inspection, not an assumption that the failure is still unresolved');
  f.jsonFile('outcomes.json', { version: 1, intervals: [passed, outcome(second, 'locked', 'passed')] });
  const closed = f.json(...measured, '--source', `${path}:2`);
  assert.equal(closed.sourceFocus.gapLines, 0);
  assert.deepEqual(next(closed), ['reuse-passing-evidence', 'reuse-passing-evidence']);
  assert.deepEqual(next(f.json(...measured, '--action', 'edit-line', '--source', `${path}:2`)), next(closed));

  delete scenario.groupActions;
  f.jsonFile('discovery.json', discovery);
  assert.equal(f.json(...measured, '--source', `${path}:2`).nextStep.kind, 'reuse-passing-evidence');
  f.jsonFile('outcomes.json', { version: 1, intervals: [passed] });
  const lead = f.json(...measured, '--source', `${path}:2`);
  assert.equal(lead.nextStep.kind, 'inspect-existing-case');
  assert.ok(lead.extensionCandidates.count > 0, 'Existing neighboring case remains a lead without action metadata');

  scenario.groupActions = { locked: [{ ...action, condition: 'lease-held-by-peer',
    entryPoint: { ...action.entryPoint, sha256: '0'.repeat(64) } }] };
  f.jsonFile('discovery.json', discovery);
  f.jsonFile('outcomes.json', { version: 1, intervals: [] });
  const stale = f.json(...measured, '--source', `${path}:2`);
  assert.deepEqual(stale.actionCases.items, []);
  assert.equal(stale.nextStep.kind, 'trace-entry-point');
  assert.match(stale.nextStep.instruction, /missing or stale entry-point/);
  assert.match(stale.nextStep.instruction, /do not invent a selector/);
  assert.equal(existsSync(join(f.root, 'app-launched')), false);
  assert.equal(f.hash(path), before[0][1]);
  assert.equal(f.hash('docs/testing/code-e2e-links.json'), before[1][1]);
});
