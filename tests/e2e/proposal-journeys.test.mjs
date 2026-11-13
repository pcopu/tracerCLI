import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../../bin/tracer.mjs', import.meta.url));
const proposal = 'docs/testing/proposed-scenario-map.json', map = 'docs/testing/code-e2e-links.json';
const hash = text => createHash('sha256').update(text).digest('hex');
function project(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tracer-proposal-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const put = (path, data) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n'); };
  const read = path => readFileSync(join(root, path), 'utf8');
  const run = (...args) => spawnSync(process.execPath, [cli, '--root', root, ...args], { encoding: 'utf8', timeout: 15000, env: { ...process.env, TRACER_NO_UPDATE: '1', NODE_OPTIONS: '', HOME: root } });
  const ok = (...args) => { const r = run(...args); assert.equal(r.status, 0, r.stderr); return r; };
  const json = (...args) => JSON.parse(ok(...args).stdout);
  put('model.mjs', 'export const title = "Synthetic";\n\n// Synthetic comment\nexport const saved = true;\n');
  const draft = { schemaVersion: 1, kind: 'proposed-scenario-association-map', status: 'model-proposed-unreviewed',
    scenarios: [{ id: 'roundtrip', title: 'Save and reopen', featureId: 'project', state: 'unwritten', existingPaths: [],
      plannedActions: ['Create synthetic project', 'Save', 'Reopen', 'Reopen'], expectedOutcomes: ['The title remains Synthetic and saved state is retained.'] }],
    associations: [1, 4].map((line, index) => ({ rangeId: `range-${index}`, featureId: 'project', status: 'model-proposed-unreviewed',
      source: { path: 'model.mjs', start: index ? 3 : 1, end: line }, scenarioIds: ['roundtrip'],
      rationale: 'Proposed retained project state contract.', confidence: 'low', uncertainty: 'No assertion witness exists yet.', proposedAssertions: ['Reopened project has exact title and saved state.'] })) };
  const prepare = () => { put('draft.json', draft); const value = json('proposal', 'prepare', '--file', 'draft.json'); put(proposal, value); return value; };
  return { root, put, read, run, ok, json, draft, prepare };
}

test('proposal-first journey: full unwritten map before app setup, audit later, never execute or promote', t => {
  const p = project(t), pinned = p.prepare();
  assert.equal(existsSync(join(p.root, map)), false); assert.equal(existsSync(join(p.root, 'tracer.json')), false);
  assert.equal(pinned.associations[0].source.sha256, hash(p.read('model.mjs').split('\n')[0] + '\n'));
  assert.equal(pinned.associations[0].source.spanSha256, hash(p.read('model.mjs').split('\n')[0]));
  const r = p.json('proposal', 'report', '--file', proposal);
  assert.deepEqual(r.scenarios[0].plannedActions, ['Create synthetic project', 'Save', 'Reopen', 'Reopen']);
  assert.equal(r.valid, true); assert.equal(r.progress.proposed.percent, 100); assert.equal(r.progress.proposed.lines, 3);
  assert.equal(r.progress.reviewed.percent, 0); assert.equal(r.progress.executed.percent, null); assert.equal(r.progress.executed.lines, null);
  assert.equal(r.progress.proposed.scenarioStates.unwritten, 1); assert.equal(r.progress.proposed.uncertainAssociations, 2);
  const before = p.read(proposal);
  for (let offset = 0; offset < 2; offset++) {
    const batch = p.json('proposal', 'audit', '--file', proposal, '--offset', String(offset), '--limit', '1');
    assert.equal(batch.associations.length, 1); assert.equal(batch.associations[0].rangeId, `range-${offset}`);
    assert.match(batch.associations[0].sourceSnippet, /export const/); assert.equal(batch.nextOffset, offset ? null : 1);
    assert.equal(batch.associations[0].scenarios[0].state, 'unwritten');
  }
  assert.equal(p.json('proposal', 'audit', '--file', proposal, '--offset', '999').associations.length, 0);
  assert.equal(p.read(proposal), before); assert.equal(existsSync(join(p.root, map)), false);
  assert.notEqual(p.run('scenario', 'link', '--file', proposal, '--reviewed').status, 0);
  assert.notEqual(p.run('proposal', 'link', '--file', proposal, '--reviewed').status, 0);
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /propose the full scenario map first/); assert.match(help.stdout, /no execution is prerequisite/);
});

test('proposal progress journey: current scope, review and execution stay independent, saved totals never trusted', t => {
  const p = project(t); p.prepare(); p.ok('init'); const before = p.read(map);
  const report = p.json('report', '--json');
  assert.equal(report.progress.proposed.percent, 100); assert.equal(report.progress.reviewed.lines, 0); assert.equal(p.read(map), before);
  p.ok('link', 'model.mjs:1', '--action', 'Read title', '--why', 'Explicit operator declaration after source review.');
  p.ok('comment', 'model.mjs:3');
  const linked = p.read(map), next = p.json('report', '--json');
  assert.equal(next.progress.proposed.denominator, 2); assert.equal(next.progress.proposed.percent, 100);
  assert.equal(next.progress.reviewed.percent, 50); assert.equal(next.progress.reviewed.withWitnessLines, 0); assert.equal(next.progress.executed.percent, null);
  assert.equal(p.json('report', '--source', 'model.mjs:4', '--json').progress.proposed.lines, 1);
  const forged = JSON.parse(p.read(proposal)); forged.totals = { proposedMappingPercentage: 100, reviewed: 100, executed: 100 }; forged.associations.pop(); p.put(proposal, forged);
  assert.equal(p.json('report', '--json').progress.proposed.percent, 50); assert.equal(p.read(map), linked);
  const text = p.ok('report').stdout; assert.match(text, /PROPOSED SCENARIO MAP/); assert.match(text, /REVIEWED MANUAL LINKS/); assert.match(text, /EXECUTED:.*N\/A/);
  p.ok('ignore', 'model.mjs', '--why', 'Synthetic scope test.');
  const empty = p.json('report', '--json').progress;
  assert.equal(empty.proposed.lines, 0); assert.equal(empty.proposed.percent, null); assert.equal(empty.reviewed.percent, null);
});

test('proposal freshness journey: changed bytes invalidate pins without refreshing, legacy pins remain compatible', t => {
  const p = project(t), pinned = p.prepare();
  delete pinned.associations[0].source.sha256; delete pinned.associations[1].source.sha256; p.put(proposal, pinned);
  p.ok('proposal', 'check', '--file', proposal);
  p.put('model.mjs', p.read('model.mjs').replaceAll('\n', '\r\n'));
  const before = p.read(proposal);
  const r = p.run('proposal', 'check', '--file', proposal); assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).progress.proposed.lines, 0); assert.match(r.stdout, /Stale fileSha256/);
  assert.notEqual(p.run('proposal', 'prepare', '--file', proposal).status, 0); assert.equal(p.read(proposal), before);
  assert.equal(p.json('proposal', 'audit', '--file', proposal).associations[0].sourceSnippet, null);
  for (const row of p.draft.associations) { delete row.source.sha256; delete row.source.fileSha256; delete row.source.spanSha256; }
  const fresh = p.prepare();
  assert.equal(fresh.associations[0].source.sha256, hash('export const title = "Synthetic";\r\n'));
  assert.equal(fresh.associations[0].source.spanSha256, hash('export const title = "Synthetic";'));
});

test('proposal integrity journey: reject malformed claims, duplicates, missing references, unsafe files and options', t => {
  const p = project(t), original = p.prepare(); p.ok('init'); const before = p.read(map);
  const mutations = [
    v => { v.status = 'reviewed'; }, v => { v.associations[0].status = 'executed'; },
    v => { v.associations[0].scenarioIds = ['missing']; }, v => { v.associations[0].scenarioIds = ['roundtrip', 'roundtrip']; },
    v => { v.scenarios.push(v.scenarios[0]); }, v => { v.associations.push(v.associations[0]); },
    v => { v.associations[0].source.path = '../outside'; }, v => { v.associations[0].source.start = 0; },
    v => { v.scenarios[0].plannedActions = []; }, v => { v.scenarios[0].expectedOutcomes = []; },
    v => { v.scenarios[0].existingPaths = ['model.mjs']; }, v => { v.scenarios[0].state = 'existing'; v.scenarios[0].existingPaths = ['missing.mjs']; },
    v => { v.associations[0].confidence = 'certain'; }, v => { v.associations[0].proposedAssertions = []; },
    v => { v.associations[0].uncertainty = null; },
  ];
  for (const mutate of mutations) { const v = structuredClone(original); mutate(v); p.put('bad.json', v); assert.notEqual(p.run('proposal', 'check', '--file', 'bad.json').status, 0); assert.equal(p.read(map), before); }
  for (const args of [['--limit', '0'], ['--limit', '1001'], ['--offset', '-1'], ['--offset', '1.2'], ['--offset', '9007199254740992'], ['--json', '--json'], ['--file', proposal]]) assert.notEqual(p.run('proposal', 'audit', '--file', proposal, ...args).status, 0);
  assert.notEqual(p.run('proposal', 'check').status, 0); assert.notEqual(p.run('proposal', 'check', '--file', map).status, 0);
  symlinkSync(join(p.root, proposal), join(p.root, 'linked.json'));
  assert.notEqual(p.run('proposal', 'check', '--file', 'linked.json').status, 0);
  const overlap = structuredClone(original); overlap.associations[1].source = structuredClone(original.associations[0].source); p.put(proposal, overlap);
  const r = p.json('report', '--json'); assert.equal(r.progress.proposed.status, 'issues'); assert.equal(r.progress.proposed.lines, 0);
  p.put(proposal, '{invalid'); assert.equal(p.json('report', '--json').progress.proposed.status, 'invalid');
});

test('proposal absence journey: missing proposals and missing execution are unknown, not full coverage', t => {
  const p = project(t), progress = p.json('report', '--json').progress;
  assert.equal(progress.proposed.status, 'missing'); assert.equal(progress.proposed.percent, null);
  assert.equal(progress.executed.percent, null); assert.equal(progress.executed.denominator, null);
  assert.equal(progress.reviewed.percent, 0);
  assert.equal(existsSync(join(p.root, map)), false);
});

test('proposal boundary journey: validate partial rows, safe paths, bounded artifacts and bounded audit expansion', t => {
  const p = project(t), original = p.prepare();
  const cases = [
    [v => { v.associations[0].source.path = 'missing.mjs'; }, /outside inventory/],
    [v => { v.associations[0].source.end = 99; }, /out of bounds/],
    [v => { delete v.associations[0].source.fileSha256; }, /Missing or invalid fileSha256/],
    [v => { v.associations[0].source.spanSha256 = 'x'; }, /Missing or invalid spanSha256/],
    [v => { v.associations[0].source.sha256 = '0'.repeat(64); }, /Stale sha256/],
  ];
  for (const [mutate, message] of cases) {
    const v = structuredClone(original); mutate(v); p.put('partial.json', v);
    const r = p.run('proposal', 'check', '--file', 'partial.json'); assert.equal(r.status, 1); assert.match(r.stdout, message);
    assert.equal(JSON.parse(r.stdout).progress.proposed.lines, 2, 'Unrelated valid association remains counted.');
  }
  for (const mutate of [v => { v.scenarios[0].id = 'bad id'; }, v => { v.scenarios[0].state = 'passed'; },
    v => { v.scenarios[0].title = 'x'.repeat(16385); }, v => { v.scenarios[0].plannedActions = ['line\nbreak']; },
    v => { v.associations[0].source = null; }, v => { v.associations = Array(100001).fill({}); }]) {
    const v = structuredClone(original); mutate(v); p.put('invalid.json', v);
    assert.notEqual(p.run('proposal', 'check', '--file', 'invalid.json').status, 0);
  }
  const existing = structuredClone(original); existing.scenarios[0].state = 'needs-extension'; existing.scenarios[0].existingPaths = ['witness.txt'];
  p.put('witness.txt', 'Potential witness, not an assertion claim.\n'); p.put('existing.json', existing);
  assert.equal(p.json('proposal', 'check', '--file', 'existing.json').progress.proposed.scenarioStates['needs-extension'], 1);
  for (const path of ['.git/config', `${map}.tmp`, 'docs/testing', 'missing.json']) assert.notEqual(p.run('proposal', 'check', '--file', path).status, 0);
  symlinkSync(join(p.root, 'docs'), join(p.root, 'alias'));
  assert.notEqual(p.run('proposal', 'check', '--file', 'alias/testing/proposed-scenario-map.json').status, 0);
  p.put('oversized.json', ' '.repeat(32 * 1024 * 1024 + 1));
  assert.match(p.run('proposal', 'check', '--file', 'oversized.json').stderr, /exceeds 32 MiB/);
  p.put('model.mjs', 'export const n = 1;\n'.repeat(6));
  const large = structuredClone(p.draft); large.scenarios[0].expectedOutcomes = Array(1000).fill('x'.repeat(16384));
  large.associations = Array.from({ length: 6 }, (_, i) => ({ ...structuredClone(large.associations[0]), rangeId: `large-${i}`, source: { path: 'model.mjs', start: i + 1, end: i + 1 } }));
  // Pin through the public CLI to a file: output intentionally exceeds spawnSync's default buffer.
  p.put('large-draft.json', large);
  const prepared = spawnSync(process.execPath, [cli, '--root', p.root, 'proposal', 'prepare', '--file', 'large-draft.json'], { encoding: 'utf8', timeout: 15000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, TRACER_NO_UPDATE: '1' } });
  assert.equal(prepared.status, 0, prepared.stderr); p.put('large.json', prepared.stdout);
  const audit = p.run('proposal', 'audit', '--file', 'large.json'); assert.equal(audit.status, 1); assert.match(audit.stderr, /exceeds 64 MiB/);
  assert.equal(existsSync(join(p.root, map)), false);
});

test('proposal snapshot journey: concurrent source edits cannot mix numerator and denominator or repeat source hashing', { timeout: 20000, skip: typeof WebSocket === 'undefined' }, async t => {
  const p = project(t); p.prepare(); const sourceBefore = p.read('model.mjs');
  // Debugger scheduling only: drive the real CLI and change a synthetic fixture
  // between inspection and reporting. No implementation APIs or I/O overrides.
  const sourceUrl = new URL('../../src/proposals.mjs', import.meta.url), lines = readFileSync(sourceUrl, 'utf8').split('\n');
  const locate = text => { const found = lines.flatMap((line, index) => line.includes(text) ? [index] : []); assert.equal(found.length, 1); return found[0]; };
  const locations = { inspect: locate('const scenarios = new Map(), rangeIds'), hash: locate('fileHashes.set(source.path'), report: locate('const report = snapshot.report()') };
  const child = spawn(process.execPath, ['--inspect-brk=127.0.0.1:0', cli, '--root', p.root, 'proposal', 'report', '--file', proposal], {
    env: { ...process.env, TRACER_NO_UPDATE: '1', NODE_OPTIONS: '', HOME: p.root }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', ended, socket;
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  child.on('close', (code, signal) => { ended = { code, signal }; });
  t.after(() => { socket?.close(); if (!ended) child.kill('SIGKILL'); });
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 8000;
    while (!predicate()) {
      if (ended || Date.now() > deadline) throw Error(`CLI stopped or timed out waiting for ${label}: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  await wait(() => /Debugger listening on (ws:\/\/[^\s]+)/.test(stderr), 'inspector');
  socket = new WebSocket(stderr.match(/Debugger listening on (ws:\/\/[^\s]+)/)[1]);
  let opened = false, nextId = 0; const responses = new Map(), pauses = [];
  socket.addEventListener('open', () => { opened = true; });
  socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.id) responses.set(message.id, message); if (message.method === 'Debugger.paused') pauses.push(message.params); });
  await wait(() => opened, 'connection');
  const command = async (method, params = {}) => {
    const id = ++nextId; socket.send(JSON.stringify({ id, method, params }));
    await wait(() => responses.has(id), method); const response = responses.get(id); responses.delete(id);
    assert.equal(response.error, undefined); return response.result;
  };
  await command('Debugger.enable');
  const breakpoints = new Map();
  for (const [name, lineNumber] of Object.entries(locations)) { const result = await command('Debugger.setBreakpointByUrl', { url: sourceUrl.href, lineNumber }); breakpoints.set(result.breakpointId, name); }
  await command('Runtime.runIfWaitingForDebugger');
  const hits = { inspect: 0, hash: 0, report: 0 };
  while (!/Waiting for the debugger to disconnect/.test(stderr)) {
    await wait(() => pauses.length || /Waiting for the debugger to disconnect/.test(stderr), 'breakpoint or exit');
    if (!pauses.length) break;
    const pause = pauses.shift();
    for (const key of pause.hitBreakpoints) {
      const name = breakpoints.get(key); if (!name) continue; hits[name]++;
      if (name === 'report') p.put('model.mjs', '\n\n\nexport const saved = true;\n');
    }
    await command('Debugger.resume');
  }
  socket.close(); socket = undefined;
  await wait(() => ended, 'exit'); assert.equal(ended.code, 0, stdout + stderr);
  assert.deepEqual(hits, { inspect: 1, hash: 1, report: 1 }, 'Inspect one proposal once and hash its shared source file only once.');
  const report = JSON.parse(stdout);
  assert.equal(report.progress.proposed.lines, 3); assert.equal(report.progress.proposed.denominator, 3);
  assert.equal(report.progress.proposed.percent, 100, 'Both counts describe the same pre-edit inventory snapshot.');
  assert.notEqual(p.read('model.mjs'), sourceBefore);
  const next = p.run('proposal', 'check', '--file', proposal); assert.equal(next.status, 1);
  const current = JSON.parse(next.stdout).progress.proposed;
  assert.equal(current.lines, 0); assert.equal(current.denominator, 1); assert.equal(current.percent, 0, 'A later command gets fresh source and rejects old pins.');
});

function priorityProject(t) {
  const p = project(t);
  p.put('model.mjs', 'export const a = 1;\n\n// Declared comment\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\nexport const f = 6;\n');
  p.put('orphan.mjs', 'export const orphan = 1;\n');
  p.put('witness.txt', 'assert retained synthetic state\n');
  p.draft.scenarios = ['beta', 'gamma', 'alpha', 'delta'].map(id => ({ ...p.draft.scenarios[0], id, title: id,
    state: 'needs-extension', existingPaths: ['witness.txt'] }));
  p.draft.associations = [[1, 4, ['alpha', 'beta']], [5, 6, ['alpha', 'gamma']], [7, 8, ['beta', 'delta']]]
    .map(([start, end, scenarioIds], i) => ({ ...p.draft.associations[0], rangeId: `part-${i}`, source: { path: 'model.mjs', start, end }, scenarioIds }));
  p.prepare(); p.ok('init'); p.ok('comment', 'model.mjs:3');
  p.ok('link', 'model.mjs:1', '--action', 'Inspect retained state', '--step', 'witness.txt:1', '--why', 'Assert synthetic retained state.');
  p.ok('link', 'model.mjs:4', '--action', 'Inspect without witness', '--why', 'Planning-only link.');
  return p;
}

test('proposal prioritization journey: greedy unique gains, stable ties, reuse opportunities and read-only limits', t => {
  const p = priorityProject(t), before = p.read(map), plan = p.read(proposal);
  assert.match(p.ok('proposal', '--help').stdout, /proposal prioritize --file PROPOSAL \[--limit N\]/);
  p.put('tracer.json', { version: 1, app: [process.execPath, '-e', "require('fs').writeFileSync('EXECUTED', 'bad')"] });
  const r = p.json('proposal', 'prioritize', '--file', proposal, '--json');
  assert.equal(r.valid, true); assert.equal(r.kind, 'scenario-proposal-prioritize');
  assert.equal(r.progress.executed.percent, null); assert.equal(r.selection.minimumTraces, 1);
  assert.equal(r.selection.gapLines, 6); assert.equal(r.selection.unproposedGapLines, 1);
  assert.equal(r.selection.targetedGapLines, 5); assert.equal(r.selection.remainingGapLines, 1);
  assert.deepEqual(r.ranking.map(row => [row.scenarioId, row.initialGapLines, row.marginalGapLines]), [['alpha', 3, 3], ['beta', 3, 2]]);
  assert.equal(r.ranking[1].cumulativeTargetedGapLines, 5);
  assert.deepEqual(r.reuseOpportunities[0].scenarioIds, ['alpha', 'beta', 'delta', 'gamma']);
  assert.equal(r.reuseOpportunities[0].path, 'witness.txt'); assert.match(r.selection.notice, /not.*optimal|no.*optimal/i);
  const limited = p.json('proposal', 'prioritize', '--file', proposal, '--limit', '1');
  assert.equal(limited.ranking.length, 1); assert.equal(limited.selection.remainingGapLines, 3); assert.equal(limited.selection.hasMore, true);
  assert.equal(p.read(map), before); assert.equal(p.read(proposal), plan); assert.equal(existsSync(join(p.root, 'EXECUTED')), false);
  const reordered = JSON.parse(plan); reordered.scenarios.reverse(); reordered.associations.reverse(); p.put(proposal, reordered);
  assert.deepEqual(p.json('proposal', 'prioritize', '--file', proposal).ranking, r.ranking);
  for (const args of [['--limit', '0'], ['--limit', '1001'], ['--limit', '9007199254740992'], ['--limit', '-1'], ['--limit', '1.5'], ['--offset', '1'], ['--limit', '1', '--limit', '2']]) {
    assert.notEqual(p.run('proposal', 'prioritize', '--file', proposal, ...args).status, 0);
  }
});

test('proposal prioritization journey: exact witnessed sequences and higher minimums never imply closed deficits', t => {
  const p = priorityProject(t);
  // A second assertion witness for the same ordered actions is still one trace.
  p.put('second.txt', 'assert the same retained state\n');
  p.ok('link', 'model.mjs:1', '--action', 'Inspect retained state', '--step', 'second.txt:1', '--why', 'Same sequence, alternate witness.');
  p.ok('link', 'model.mjs:1', '--action', 'Other planned inspection', '--why', 'A distinct action-only link is not a witnessed trace.');
  p.ok('config', '--minimum-traces', '2');
  const r = p.json('proposal', 'prioritize', '--file', proposal);
  assert.equal(r.selection.minimumTraces, 2); assert.equal(r.selection.gapLines, 7);
  assert.equal(r.selection.targetedGapLines, 6); assert.equal(r.selection.remainingGapLines, 1);
  assert.deepEqual(r.ranking.map(row => [row.scenarioId, row.marginalGapLines]), [['alpha', 4], ['beta', 2]]);
  assert.match(r.selection.notice, /potential targets/); assert.match(r.selection.notice, /distinct.*trace/i);
  p.ok('config', '--minimum-traces', '1'); p.put('witness.txt', 'changed witness\n'); p.put('second.txt', 'changed alternate witness\n');
  const stale = p.json('proposal', 'prioritize', '--file', proposal, '--limit', '1');
  assert.equal(stale.valid, false); assert.equal(stale.selection.gapLines, 7); assert.equal(stale.diagnostics.invalidLinks.length, 2);
});

test('proposal prioritization journey: global stale and ignored diagnostics survive ranking limits and empty scope', t => {
  const p = priorityProject(t);
  p.put('stale.mjs', 'export const stale = 1;\n'); p.put('ignored.mjs', '// ignored comment\nexport const ignored = 1;\n');
  p.draft.associations.push({ ...p.draft.associations[0], rangeId: 'stale', source: { path: 'stale.mjs', start: 1, end: 1 } });
  p.prepare(); p.ok('comment', 'ignored.mjs:1');
  p.ok('link', 'ignored.mjs:2', '--action', 'Inspect ignored fixture', '--step', 'witness.txt:1', '--why', 'Ignored integrity fixture.');
  p.ok('dead-code', 'ignored.mjs:2', '--why', 'Synthetic stale declaration.', '--evidence', 'Synthetic fixture only; no production reachability claim.');
  p.ok('ignore', 'ignored.mjs', '--why', 'Synthetic ignored scope.');
  p.put('stale.mjs', 'export const stale = 2;\n'); p.put('ignored.mjs', '// changed comment\nexport const ignored = 2;\n');
  const mapBefore = p.read(map), planBefore = p.read(proposal), r = p.json('proposal', 'prioritize', '--file', proposal, '--limit', '1');
  assert.equal(r.valid, false); assert.equal(r.ranking.length, 1);
  assert.ok(r.progress.proposed.issues.some(value => value.includes('stale: Stale')));
  assert.equal(r.diagnostics.invalidLinks.length, 1); assert.equal(r.diagnostics.invalidComments.length, 1);
  assert.equal(r.diagnostics.invalidDeadCode.length, 1);
  assert.deepEqual(r.diagnostics.ignoredSources.map(row => row.path), ['ignored.mjs']);
  assert.equal(r.selection.gapLines, 7); assert.equal(r.selection.unproposedGapLines, 2);
  assert.equal(p.read(map), mapBefore); assert.equal(p.read(proposal), planBefore);
  const overlap = JSON.parse(planBefore); overlap.associations.push({ ...overlap.associations[0], rangeId: 'overlap' }); p.put('overlap.json', overlap);
  const overlapping = p.json('proposal', 'prioritize', '--file', 'overlap.json', '--limit', '1');
  assert.equal(overlapping.selection.unproposedGapLines, 3); assert.ok(overlapping.progress.proposed.issues.some(value => value.includes('Overlapping')));
  for (const name of ['model.mjs', 'orphan.mjs', 'stale.mjs']) p.ok('ignore', name, '--why', 'Empty synthetic scope.');
  const empty = p.json('proposal', 'prioritize', '--file', proposal);
  assert.deepEqual(empty.ranking, []); assert.equal(empty.selection.gapLines, 0); assert.equal(empty.progress.reviewed.percent, null);
  const invalid = JSON.parse(planBefore); invalid.scenarios[0].existingPaths = ['missing.txt']; p.put(proposal, invalid);
  assert.notEqual(p.run('proposal', 'prioritize', '--file', proposal).status, 0, 'Global path validation cannot be skipped by a small ranking.');
});

test('proposal prioritization journey: bounded previews expose truncation and fully witnessed plans add no targets', t => {
  const p = project(t);
  p.put('model.mjs', 'export const n = 1;\n'.repeat(30));
  const paths = Array.from({ length: 11 }, (_, i) => `witness-${i}.txt`);
  for (const path of paths) p.put(path, 'assert synthetic state\n');
  p.draft.scenarios = Array.from({ length: 30 }, (_, i) => ({ ...p.draft.scenarios[0], id: `plan-${String(i).padStart(2, '0')}`,
    state: 'needs-extension', existingPaths: paths }));
  p.draft.associations = p.draft.scenarios.map((scenario, i) => ({ ...p.draft.associations[0], rangeId: `row-${i}`,
    source: { path: 'model.mjs', start: i + 1, end: i + 1 }, scenarioIds: [scenario.id] }));
  p.prepare();
  const r = p.json('proposal', 'prioritize', '--file', proposal);
  assert.equal(r.ranking.length, 25); assert.equal(r.selection.hasMore, true);
  assert.equal(r.ranking[0].existingPathCount, 11); assert.equal(r.ranking[0].existingPaths.length, 10); assert.equal(r.ranking[0].existingPathsTruncated, true);
  assert.equal(r.reuseOpportunities[0].scenarioCount, 30); assert.equal(r.reuseOpportunities[0].scenarioIds.length, 25); assert.equal(r.reuseOpportunities[0].scenarioIdsTruncated, true);
  const one = p.json('proposal', 'prioritize', '--file', proposal, '--limit', '1');
  assert.equal(one.reuseOpportunities.length, 1); assert.equal(one.reuseOpportunitiesTruncated, true);
  p.draft.associations.forEach(row => { row.scenarioIds = ['plan-00']; }); p.prepare();
  const broad = p.json('proposal', 'prioritize', '--file', proposal);
  assert.equal(broad.ranking.length, 1); assert.equal(broad.ranking[0].associationCount, 30);
  assert.equal(broad.ranking[0].associationIds.length, 25); assert.equal(broad.ranking[0].associationIdsTruncated, true);
  p.ok('link', 'model.mjs:1-30', '--action', 'Inspect synthetic state', '--step', 'witness-0.txt:1', '--why', 'Synthetic complete fixture.');
  const complete = p.json('proposal', 'prioritize', '--file', proposal);
  assert.equal(complete.selection.gapLines, 0); assert.deepEqual(complete.ranking, []);
  // These diagnostics fit as compact JSON but exceed 64 MiB with the actual CLI indentation.
  p.put(map, { version: 1, links: Array.from({ length: 4000 }, (_, i) => ({ id: `bad-${i}`, source: { path: 'model.mjs', start: 1, end: 1, sha256: '0'.repeat(64) },
    actions: ['Inspect synthetic state'], why: 'x'.repeat(16384) })) });
  const oversized = p.run('proposal', 'prioritize', '--file', proposal, '--limit', '1');
  assert.equal(oversized.status, 1); assert.equal(oversized.stdout, ''); assert.match(oversized.stderr, /exceeds 64 MiB/);
});
