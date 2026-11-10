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
