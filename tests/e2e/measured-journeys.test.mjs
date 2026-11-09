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
