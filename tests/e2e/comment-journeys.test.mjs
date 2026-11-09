import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Synthetic repositories and the public CLI are the only application interaction surface.
const cli = fileURLToPath(new URL('../../bin/tracer.mjs', import.meta.url));
const mapPath = 'docs/testing/code-e2e-links.json';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function project(t, source = '// header\n\nconst answer = 42;\n// footer\n') {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'tracer-comment-journey-')));
  const root = join(sandbox, 'repo'), home = join(sandbox, 'home');
  mkdirSync(root); mkdirSync(home);
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), TRACER_NO_UPDATE: '1' };
  execFileSync('git', ['init', '-q'], { cwd: root, env });
  const put = (path, bytes) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); };
  put('src/example.js', source); put('tests/example.spec', 'open\nassert answer 42\n');
  const run = (args, status = 0) => {
    const result = spawnSync(process.execPath, [cli, '--root', root, ...args], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error); assert.equal(result.signal, null);
    assert.equal(result.status, status, `${JSON.stringify(args)}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const ok = (...args) => run(args).stdout;
  const json = (...args) => JSON.parse(ok(...args, '--json'));
  const check = (status = 0, ...args) => JSON.parse(run(['check', ...args, '--json'], status).stdout);
  const bytes = () => readFileSync(join(root, mapPath));
  const map = () => JSON.parse(bytes());
  const edit = change => { const data = map(); change(data); put(mapPath, `${JSON.stringify(data)}\n`); };
  const mark = range => { ok('comment', range); return map().commentExclusions.find(row => `${row.source.path}:${row.source.start}-${row.source.end}` === range || `${row.source.path}:${row.source.start}` === range); };
  const link = (range, action = 'inspect answer', step = true) => ok('link', range, '--action', action,
    ...(step ? ['--step', 'tests/example.spec:1-2'] : []), '--why', 'Review synthetic answer.');
  return { root, put, run, ok, json, check, bytes, map, edit, mark, link };
}

test('comment journey: explicit declarations preserve v1 links, unknown metadata and exact idempotent bytes', t => {
  const f = project(t);
  assert.equal(f.json('report').totals.lines, 3, 'unmarked comments count without language parsing');
  f.link('src/example.js:1-4');
  f.edit(data => { data.unrelated = { preserved: ['synthetic', 7] }; });
  const originalLinks = f.map().links;
  const mark = f.mark('src/example.js:1');
  assert.equal(f.map().version, 1);
  assert.deepEqual(f.map().links, originalLinks);
  assert.deepEqual(f.map().unrelated, { preserved: ['synthetic', 7] });
  assert.deepEqual(mark.source, { path: 'src/example.js', start: 1, end: 1, sha256: sha256('// header\n') });
  assert.equal(mark.fileSha256, sha256('// header\n\nconst answer = 42;\n// footer\n'));
  const saved = f.bytes();
  f.ok('comment', 'src/example.js:1');
  assert.deepEqual(f.bytes(), saved, 'an unchanged repeated declaration must be byte-idempotent');
  const report = f.json('report');
  assert.equal(report.lineBasis, 'nonblank-undeclared-comment-lines');
  assert.equal(report.totals.commentLines, 1);
  assert.equal(report.totals.lines, 2);
  assert.deepEqual(report.files[0].comments, [mark]);
  assert.deepEqual(report.invalidComments, []);
  assert.equal(f.check().commentTotal, 1);
  assert.equal(f.check().commentValid, 1);
  f.ok('uncomment', mark.id);
  assert.equal(f.json('report').totals.lines, 3);
  assert.deepEqual(f.map().links, originalLinks);
  assert.deepEqual(f.map().unrelated, { preserved: ['synthetic', 7] });
  assert.equal(readFileSync(join(f.root, 'src/example.js'), 'utf8'), '// header\n\nconst answer = 42;\n// footer\n');
});

test('comment journey: overlapping marks union nonblank lines while physical navigation remains exact', t => {
  const f = project(t, '// one\n \t\n// three\n// four\nvalue\n\n// seven\n');
  f.link('src/example.js:1-5');
  f.link('src/example.js:3-7', 'inspect second', false);
  f.mark('src/example.js:1-3'); f.mark('src/example.js:3-4'); f.mark('src/example.js:6');
  const saved = f.bytes(), report = f.json('report', '--minimum-traces', '2'), file = report.files[0];
  assert.deepEqual(report.totals, { files: 1, physicalLines: 7, blankLines: 2, commentLines: 3,
    lines: 2, linked: 2, withStep: 1, unlinked: 0, belowMinimum: 1 });
  assert.deepEqual(file.commentRanges, [[1, 1], [3, 4]]);
  assert.deepEqual(file.blankRanges, [[2, 2], [6, 6]]);
  assert.deepEqual(file.linkedRanges, [[5, 5], [7, 7]]);
  assert.deepEqual(file.belowMinimumRanges, [[7, 7]]);
  assert.deepEqual(file.traceCounts, [{ start: 1, end: 2, count: 1, withStepCount: 1 },
    { start: 3, end: 5, count: 2, withStepCount: 1 }, { start: 6, end: 7, count: 1, withStepCount: 0 }]);
  assert.equal(file.comments.length, 3, 'blank-only marks remain navigable original declarations');
  const selected = f.json('report', '--source', 'src/example.js:2-5');
  assert.equal(selected.totals.physicalLines, 4); assert.equal(selected.totals.blankLines, 1);
  assert.equal(selected.totals.commentLines, 2); assert.equal(selected.totals.lines, 1);
  assert.deepEqual(selected.files[0].commentRanges, [[3, 4]]);
  const onlyComment = f.json('report', '--source', 'src/example.js:3-4');
  assert.equal(onlyComment.totals.lines, 0); assert.equal(onlyComment.files[0].links.length, 2);
  assert.deepEqual(onlyComment.files[0].linkedRanges, []);
  for (const selector of [['--action', 'inspect answer'], ['--sequence', '["inspect answer"]'], ['--step', 'tests/example.spec:2']]) {
    const filtered = f.json('report', ...selector);
    assert.equal(filtered.totals.linked, 1); assert.equal(filtered.totals.commentLines, 3);
  }
  assert.equal(f.check(1, '--require-minimum', '--minimum-traces', '2').belowMinimum, 1);
  assert.deepEqual(f.bytes(), saved, 'read-only selections and minimum overrides preserve map bytes');
  f.ok('config', '--minimum-traces', '2');
  assert.equal(f.check(1, '--require-minimum').belowMinimum, 1);
  f.mark('src/example.js:7');
  assert.equal(f.check(0, '--require-minimum').belowMinimum, 0);
});

test('comment journey: exact Unicode CRLF hashes and whole-file context staleness require explicit re-review', t => {
  const source = '\uFEFF// café 🦊\r\n\t\r\nconst value = "λ";\r\n// fin';
  const f = project(t, source), mark = f.mark('src/example.js:1-2');
  assert.equal(mark.source.sha256, sha256('\uFEFF// café 🦊\r\n\t\r\n'));
  assert.equal(mark.fileSha256, sha256(source));
  assert.equal(f.json('report').totals.commentLines, 1);
  const saved = f.bytes();
  f.put('src/example.js', source.replace('"λ"', '"μ"'));
  const stale = f.check(1);
  assert.equal(stale.commentTotal, 1); assert.equal(stale.commentValid, 0);
  assert.equal(stale.invalidComments.length, 1);
  assert.deepEqual(stale.invalidComments[0].comment, mark);
  assert.ok(stale.invalidComments[0].errors.length > 0);
  const report = f.json('report');
  assert.equal(report.totals.commentLines, 0); assert.equal(report.totals.lines, 3);
  assert.deepEqual(report.files[0].comments, []); assert.equal(report.invalidComments.length, 1);
  f.run(['comment', 'src/example.js:1-2'], 1);
  assert.deepEqual(f.bytes(), saved, 'repeating a stale declaration must not launder the file hash');
  f.ok('uncomment', mark.id); const fresh = f.mark('src/example.js:1-2');
  assert.equal(f.check().commentValid, 1); assert.notEqual(fresh.fileSha256, mark.fileSha256);
  assert.equal(fresh.source.sha256, mark.source.sha256, 'unchanged snippet still needs context review');
  f.put('src/example.js', source.replace('café', 'cafe').replace('"λ"', '"μ"'));
  assert.equal(f.check(1).commentValid, 0);
  f.run(['comment', 'src/example.js:1-2'], 1);
  f.ok('uncomment', fresh.id); f.mark('src/example.js:1-2');
  assert.equal(f.check().commentValid, 1);
});

test('comment journey: blank-only and agent-declared arbitrary text are explicit metadata, never parsed semantics', t => {
  const f = project(t, '\t\n \r\n');
  f.mark('src/example.js:1-2');
  let report = f.json('report');
  assert.equal(report.totals.lines, 0); assert.equal(report.totals.blankLines, 2);
  assert.equal(report.totals.commentLines, 0); assert.deepEqual(report.files[0].commentRanges, []);
  assert.equal(f.check(0, '--require-minimum').commentValid, 1);
  f.ok('uncomment', f.map().commentExclusions[0].id);
  f.put('src/example.js', 'not a recognized comment syntax\n');
  f.mark('src/example.js:1');
  report = f.json('report');
  assert.equal(report.totals.lines, 0); assert.equal(report.totals.commentLines, 1);
  assert.equal(f.check(0, '--require-minimum').commentValid, 1, 'explicit declarations do not claim executable semantics');
});

test('comment journey: malformed records and duplicate IDs never silently exclude or repair source', t => {
  const f = project(t), valid = f.mark('src/example.js:1');
  const clean = f.bytes();
  const mutations = [
    row => { row.id = ''; }, row => { row.source.start = 0; }, row => { row.source.end = 99; },
    row => { row.source.path = '../outside.js'; }, row => { row.source.path = 'src/missing.js'; },
    row => { row.source.sha256 = 'bad'; }, row => { delete row.source.sha256; },
    row => { row.fileSha256 = 'bad'; },
    row => { delete row.fileSha256; }, row => { row.source = null; },
  ];
  for (const mutate of mutations) {
    f.put(mapPath, clean); f.edit(data => mutate(data.commentExclusions[0]));
    const malformed = f.bytes(), result = f.check(1);
    assert.equal(result.commentValid, 0); assert.equal(result.invalidComments.length, 1);
    const report = f.json('report');
    assert.equal(report.totals.commentLines, 0); assert.equal(report.totals.lines, 3);
    assert.equal(report.invalidComments.length, 1);
    f.run(['comment', 'src/example.js:1'], 1);
    f.run(['comment', 'src/example.js:4'], 1);
    assert.deepEqual(f.bytes(), malformed, 'comment cannot silently repair malformed metadata');
  }
  f.put(mapPath, clean); f.edit(data => data.commentExclusions.push(structuredClone(valid)));
  const duplicated = f.bytes(), check = f.check(1);
  assert.equal(check.commentValid, 0); assert.equal(check.invalidComments.length, 2);
  assert.equal(f.json('report').totals.commentLines, 0);
  f.run(['comment', 'src/example.js:1'], 1);
  f.run(['uncomment', valid.id], 1);
  assert.deepEqual(f.bytes(), duplicated);
  for (const invalid of [null, 42, 'invalid', []]) {
    f.put(mapPath, clean); f.edit(data => { data.commentExclusions = [invalid]; });
    const untouched = f.bytes();
    assert.equal(f.check(1).commentValid, 0);
    assert.equal(f.json('report').totals.commentLines, 0);
    f.run(['comment', 'src/example.js:4'], 1);
    assert.deepEqual(f.bytes(), untouched);
  }
  f.put(mapPath, clean); f.edit(data => { data.commentExclusions = {}; });
  const invalidShape = f.bytes();
  f.run(['comment', 'src/example.js:1'], 1);
  f.run(['report', '--json'], 1); f.run(['check', '--json'], 1);
  assert.deepEqual(f.bytes(), invalidShape);
});

test('comment journey: reject unsafe ranges, unknown source kinds and invalid text without altering the map', t => {
  const f = project(t); f.mark('src/example.js:1');
  f.put('src/custom.oddlang', '// custom\n');
  f.put('docs/note.txt', 'not source\n'); f.put('generated/output.js', '// generated\n');
  symlinkSync(join(f.root, 'src/example.js'), join(f.root, 'src/alias.js'));
  const saved = f.bytes();
  for (const range of ['src/example.js', 'src/example.js:0', 'src/example.js:3-1', 'src/example.js:99',
    '../outside.js:1', '/tmp/outside.js:1', 'src/missing.js:1', 'docs/note.txt:1', 'generated/output.js:1',
    'src/alias.js:1', 'src/custom.oddlang:1']) {
    f.run(['comment', range], 1); assert.deepEqual(f.bytes(), saved);
  }
  f.run(['uncomment', 'does-not-exist'], 1); assert.deepEqual(f.bytes(), saved);
  f.put('src/binary.js', Buffer.from([0x00, 0x61]));
  f.run(['comment', 'src/binary.js:1'], 1); assert.deepEqual(f.bytes(), saved);
  f.put('src/binary.js', Buffer.from([0xff]));
  f.run(['comment', 'src/binary.js:1'], 1); assert.deepEqual(f.bytes(), saved);
  rmSync(join(f.root, 'src/binary.js'));
  f.ok('--include-ext', '.oddlang', 'comment', 'src/custom.oddlang:1');
  assert.equal(f.json('--include-ext', '.oddlang', 'report').totals.commentLines, 2);
  const defaultReport = f.json('report');
  assert.equal(defaultReport.invalidComments.length, 1, 'marks outside the current source inventory are invalid');
  assert.equal(f.check(1).commentValid, 1);
});

test('comment journey: narrow reports retain unrelated invalid declarations and never repair evidence', t => {
  const f = project(t);
  f.link('src/example.js:3');
  f.put('src/other.js', '// other header\nconst other = 1;\n');
  const stale = f.mark('src/other.js:1');
  f.put('src/other.js', '// other header\nconst other = 2;\n');
  f.edit(data => data.commentExclusions.push({ id: 'malformed-other', source: { path: 'src/missing.js', start: 1, end: 1 } }));
  const saved = f.bytes(), example = readFileSync(join(f.root, 'src/example.js')),
    other = readFileSync(join(f.root, 'src/other.js'));
  for (const selector of [['--source', 'src/example.js:3'], ['--action', 'inspect answer'],
    ['--sequence', '["inspect answer"]'], ['--step', 'tests/example.spec:2']]) {
    const report = f.json('report', ...selector);
    assert.deepEqual(report.files.map(file => file.path), ['src/example.js']);
    assert.deepEqual(report.invalidComments.map(row => row.comment.id).sort(), [stale.id, 'malformed-other'].sort());
    assert.ok(report.invalidComments.every(row => row.errors.length > 0));
    assert.equal(report.totals.commentLines, 0);
    const human = f.ok('report', ...selector);
    assert.match(human, /Comment exclusions are declarations, not verified syntax/);
    assert.match(human, /INVALID COMMENT malformed-other/);
    assert.ok(human.includes(`INVALID COMMENT ${stale.id}`));
  }
  const check = f.check(1);
  assert.equal(check.commentTotal, 2); assert.equal(check.commentValid, 0);
  assert.equal(check.invalidComments.length, 2);
  const humanCheck = f.run(['check'], 1).stdout;
  assert.match(humanCheck, /Comment syntax is not verified/);
  assert.deepEqual(f.bytes(), saved);
  assert.deepEqual(readFileSync(join(f.root, 'src/example.js')), example);
  assert.deepEqual(readFileSync(join(f.root, 'src/other.js')), other);
});
