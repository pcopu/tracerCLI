import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../../bin/tracer.mjs', import.meta.url));
const map = 'docs/testing/code-e2e-links.json', proposal = 'docs/testing/proposed-scenario-map.json', queue = '.tracer/audits/queue.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function project(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tracer-audit-queue-')));
  t.after(() => rmSync(root, { recursive: true, force: true })); execFileSync('git', ['init', '-q'], { cwd: root });
  const put = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'); };
  const read = path => readFileSync(join(root, path), 'utf8');
  const run = (...args) => spawnSync(process.execPath, [cli, '--root', root, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, TRACER_NO_UPDATE: '1', NODE_OPTIONS: '', HOME: root } });
  const ok = (...args) => { const r = run(...args); assert.equal(r.status, 0, r.stderr); return r; };
  const json = (...args) => JSON.parse(ok(...args).stdout);
  put('model.mjs', 'export const title = "Synthetic";\nexport const saved = true;\n');
  put('caller.txt', 'Call create before reopening.\n');
  const draft = { schemaVersion: 1, kind: 'proposed-scenario-association-map', status: 'model-proposed-unreviewed',
    scenarios: [{ id: 'roundtrip', title: 'Save and reopen', featureId: 'project', state: 'unwritten', existingPaths: [], plannedActions: ['Create', 'Save', 'Reopen'], expectedOutcomes: ['Exact title persists.', 'Saved flag is retained.'] }],
    associations: [1, 2].map(n => ({ rangeId: `range-${n}`, featureId: 'project', status: 'model-proposed-unreviewed', source: { path: 'model.mjs', start: n, end: n }, scenarioIds: ['roundtrip'], rationale: 'Project state participates in persistence.', confidence: 'medium', uncertainty: 'Scenario not implemented.', proposedAssertions: [`Value on line ${n} is retained.`] })) };
  const prepare = () => { put('draft.json', draft); put(proposal, json('proposal', 'prepare', '--file', 'draft.json')); };
  prepare(); ok('init');
  const enqueue = (...args) => json('audit', 'enqueue', '--file', proposal, '--author', 'coder', ...args);
  const claim = (...args) => json('audit', 'claim', '--worker', 'independent-reviewer', ...args);
  const receipt = (claim, changes = {}) => {
    const source = claim.snapshot.contract.association.source, file = claim.snapshot.files.find(file => file.path === source.path);
    const lines = file.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    return { version: 1, kind: 'semantic-audit-receipt', jobId: claim.jobId, snapshotSha256: claim.snapshotSha256, claim: claim.claim,
      reviewer: 'independent-reviewer', execution: 'not-assessed', associationFit: 'accepted', assertionAdequacy: 'accepted', readiness: 'needs-implementation',
      rationale: 'Synthetic source and proposed state readback agree; implementation is a separate task.', corrections: [],
      assertionAssessments: claim.snapshot.assertions.map(a => ({ id: a.id, decision: 'accepted', fixture: 'Isolated project fixture.', action: 'Create then save and reopen.', state: 'Reset before creation; save before reopen.', oracle: a.description, guards: 'Public guards remain enforced; no replay assertion is claimed.', rationale: 'The contract names the expected public state.' })),
      evidence: [{ path: source.path, start: source.start, end: source.end, sha256: hash(lines.slice(source.start - 1, source.end).join('')), observation: 'This synthetic declaration participates in the proposed state contract.' }], ...changes };
  };
  const record = (claim, changes = {}) => { put('receipt.json', receipt(claim, changes)); return json('audit', 'record', '--file', 'receipt.json'); };
  return { root, put, read, run, ok, json, draft, prepare, enqueue, claim, receipt, record };
}

test('live audit lifecycle: immutable whole contracts, deduplicated enqueue, independent claims and explicit semantic drain', t => {
  const p = project(t), oldMap = p.read(map), oldProposal = p.read(proposal);
  const enqueued = p.enqueue('--context', 'caller.txt'); assert.equal(enqueued.enqueued.length, 2);
  const repeat = p.enqueue('--context', 'caller.txt'); assert.equal(repeat.enqueued.length, 0); assert.deepEqual(repeat.reused, enqueued.enqueued);
  assert.equal(p.json('audit', 'status', '--file', proposal).counts.pending, 2);
  assert.equal(p.run('audit', 'claim', '--worker', 'coder').status, 1, 'The author cannot claim an independent review.');
  const first = p.claim(); assert.equal(first.snapshot.files.length, 2); assert.equal(first.snapshot.assertions.length, 3);
  assert.equal(first.receiptTemplate.associationFit, 'unresolved'); assert.equal(first.receiptTemplate.assertionAssessments.length, 3);
  p.put('unfilled.json', first.receiptTemplate); assert.equal(p.run('audit', 'record', '--file', 'unfilled.json').status, 1);
  assert.ok(first.snapshot.assertions.some(a => a.id === 'range:0')); assert.ok(first.snapshot.assertions.some(a => a.id === 'scenario:roundtrip:1'));
  assert.equal(p.run('audit', 'claim', '--worker', 'second-reviewer').status, 1, 'One supervised running lane is bounded.');
  const stored = p.record(first); assert.equal(stored.current, true);
  const pending = p.run('audit', 'drain', '--file', proposal); assert.equal(pending.status, 1);
  assert.equal(JSON.parse(pending.stdout).counts.accepted, 1); assert.equal(JSON.parse(pending.stdout).counts.pending, 1);
  const last = p.claim(); p.record(last);
  const complete = p.json('audit', 'drain', '--file', proposal); assert.equal(complete.complete, true); assert.equal(complete.counts.accepted, 2); assert.equal(complete.executableReady, false); assert.equal(complete.execution, 'not-assessed');
  assert.equal(complete.results[0].assessment.readiness, 'needs-implementation', 'Semantic acceptance is separate from executable readiness.');
  assert.equal(p.read(map), oldMap); assert.equal(p.read(proposal), oldProposal);
  const gitStatus = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: p.root, encoding: 'utf8' });
  assert.doesNotMatch(gitStatus, /\.tracer\/audits/);
  assert.match(p.read('.tracer/audits/.gitignore'), /Private local audit evidence/);
  assert.match(complete.notice, /not.*execute tests|does not.*execute tests/);
});

test('live audit stale-result journey: coding continues, source/context/shared assertions invalidate old receipts', t => {
  const p = project(t); p.enqueue('--context', 'caller.txt'); const active = p.claim();
  const frozen = JSON.stringify(active.snapshot), oldModel = p.read('model.mjs');
  p.put('model.mjs', oldModel.replace('true', 'false'));
  assert.equal(p.json('audit', 'status', '--file', proposal).counts.stale, 2);
  const recorded = p.record(active); assert.equal(recorded.current, false, 'Late receipt remains historical, not current approval.');
  assert.equal(p.run('audit', 'drain', '--file', proposal).status, 1);
  const snapshotPath = JSON.parse(p.read(queue)).jobs.find(job => job.id === active.jobId).snapshot;
  assert.equal(JSON.stringify(JSON.parse(p.read(snapshotPath))), frozen, 'Coding never mutates the review snapshot.');
  p.prepare(); const fresh = p.enqueue('--context', 'caller.txt'); assert.equal(fresh.enqueued.length, 2);
  for (let n = 0; n < 2; n++) p.record(p.claim());
  const stalePending = p.run('audit', 'drain', '--file', proposal); assert.equal(stalePending.status, 1);
  const outstanding = JSON.parse(stalePending.stdout).outstandingJobs; assert.equal(outstanding.length, 1); assert.equal(outstanding[0].current, false);
  p.ok('audit', 'fail', '--job', outstanding[0].jobId, '--reason', 'Supervisor explicitly closes the superseded pending snapshot.');
  assert.equal(p.json('audit', 'drain', '--file', proposal).complete, true);
  const unrelated = JSON.parse(p.read(proposal)); unrelated.provenanceNote = 'Unrelated metadata does not change a contract.'; p.put(proposal, unrelated);
  assert.equal(p.json('audit', 'drain', '--file', proposal).complete, true, 'Exact unchanged contract/source can reuse review across unrelated proposal edits.');
  p.put('caller.txt', 'Different call ordering requires another review.\n');
  assert.equal(p.json('audit', 'status', '--file', proposal).counts.stale, 2);
  p.put('caller.txt', 'Call create before reopening.\n'); unrelated.scenarios[0].expectedOutcomes[1] = 'A contradictory outcome needs review.'; p.put(proposal, unrelated);
  assert.equal(p.json('audit', 'status', '--file', proposal).counts.stale, 2, 'Shared scenario outcomes are part of every associated contract.');
});

test('live audit supervision journey: exited claim process leaves work running until explicit failure and retry', t => {
  const p = project(t); p.enqueue('--limit', '1'); const first = p.claim();
  // The claim CLI has exited, but no detached process or receipt is invented.
  assert.equal(p.json('audit', 'status', '--file', proposal).counts.running, 1);
  assert.equal(p.run('audit', 'drain', '--file', proposal).status, 1);
  assert.equal(p.run('audit', 'fail', '--job', first.jobId, '--claim', 'wrong', '--reason', 'Worker exited.').status, 1);
  p.ok('audit', 'fail', '--job', first.jobId, '--claim', first.claim, '--reason', 'Supervisor observed the worker exit without a result.');
  assert.equal(p.json('audit', 'status', '--file', proposal).counts.failed, 1);
  p.ok('audit', 'retry', '--job', first.jobId); const second = p.claim(); assert.notEqual(second.claim, first.claim);
  p.put('receipt.json', p.receipt(first)); assert.equal(p.run('audit', 'record', '--file', 'receipt.json').status, 1, 'An obsolete claim cannot complete a new attempt.');
  p.record(second); assert.equal(p.json('audit', 'drain', '--file', proposal, '--limit', '1').complete, true);
  assert.equal(p.run('audit', 'drain', '--file', proposal).status, 1, 'Default gate cannot silently narrow the missing second association.');
  const history = JSON.parse(p.read(queue)).jobs[0].history; assert.deepEqual(history.map(x => x.state), ['pending', 'running', 'failed', 'pending', 'running', 'reviewed']);
});

test('live audit receipt journey: every assertion, independent identity and frozen evidence are required; findings do not become passes', t => {
  const p = project(t); p.enqueue('--limit', '1'); const claim = p.claim(), baseline = p.receipt(claim), before = p.read(queue);
  const invalid = [
    v => { v.execution = 'passed'; }, v => { v.reviewer = 'coder'; }, v => { v.snapshotSha256 = '0'.repeat(64); },
    v => { v.assertionAssessments.pop(); }, v => { v.assertionAssessments[0].id = 'missing'; }, v => { v.assertionAssessments[1].id = v.assertionAssessments[0].id; },
    v => { v.assertionAssessments[0].state = ''; }, v => { v.assertionAssessments[0].decision = 'unresolved'; },
    v => { v.associationFit = 'needs-correction'; }, v => { v.readiness = 'passed'; }, v => { v.readiness = 'ready'; },
    v => { v.corrections = ['An open correction cannot be hidden behind accepted labels.']; },
    v => { v.evidence[0].path = 'live-only.txt'; }, v => { v.evidence[0].sha256 = 'f'.repeat(64); },
  ];
  for (const mutate of invalid) { const v = structuredClone(baseline); mutate(v); p.put('bad-receipt.json', v); assert.equal(p.run('audit', 'record', '--file', 'bad-receipt.json').status, 1); assert.equal(p.read(queue), before); }
  p.record(claim, { associationFit: 'needs-correction', corrections: ['Assign this source to the actual state owner rather than a UI-only scenario.'] });
  const corrected = p.run('audit', 'drain', '--file', proposal, '--limit', '1'); assert.equal(corrected.status, 1); assert.equal(JSON.parse(corrected.stdout).counts['needs-correction'], 1);
  p.enqueue('--offset', '1', '--limit', '1'); const unresolved = p.claim();
  p.record(unresolved, { associationFit: 'unresolved', rationale: 'Caller context is missing; request a new immutable snapshot.' });
  assert.equal(p.json('audit', 'status', '--file', proposal).counts.unresolved, 1);
});

test('live audit bounds journey: enqueue fails atomically at capacity or invalid source; scope and missing work are explicit', t => {
  const p = project(t);
  const fail = p.run('audit', 'enqueue', '--file', proposal, '--author', 'coder', '--max-pending', '1'); assert.equal(fail.status, 1);
  assert.equal(existsSync(join(p.root, queue)), false, 'No partially enqueued batch.');
  p.enqueue('--max-pending', '1', '--limit', '1'); assert.equal(p.enqueue('--limit', '1').reused.length, 1, 'Deduplication does not consume capacity.');
  assert.equal(p.run('audit', 'enqueue', '--file', proposal, '--author', 'coder', '--offset', '1').status, 1);
  assert.equal(p.run('audit', 'enqueue', '--file', proposal, '--author', 'coder', '--max-pending', '2').status, 1);
  const job = JSON.parse(p.read(queue)).jobs[0]; p.ok('audit', 'fail', '--job', job.id, '--reason', 'Explicitly superseded by changed feature work.');
  p.put('model.mjs', p.read('model.mjs') + '// Changed context\n');
  assert.equal(p.run('audit', 'retry', '--job', job.id).status, 1, 'Changed source cannot inherit a retry.');
  p.prepare(); p.enqueue('--offset', '1', '--limit', '1');
  const empty = p.run('audit', 'drain', '--file', proposal, '--offset', '99'); assert.equal(empty.status, 1); assert.equal(JSON.parse(empty.stdout).complete, false);
  for (const args of [['--limit', '0'], ['--limit', '1001'], ['--offset', '-1'], ['--offset', '1.2'], ['--author', 'duplicate']]) assert.equal(p.run('audit', 'enqueue', '--file', proposal, '--author', 'coder', ...args).status, 1);
});

test('live audit storage journey: reject locks, symlink targets and changed snapshots or receipts without changing manual data', t => {
  const p = project(t), before = p.read(map); p.enqueue('--limit', '1');
  p.put(`${queue}.lock`, 'existing writer\n'); assert.equal(p.run('audit', 'claim', '--worker', 'reviewer').status, 1); rmSync(join(p.root, `${queue}.lock`));
  const claim = p.claim(); p.record(claim); const q = JSON.parse(p.read(queue)), job = q.jobs[0];
  const originalReceipt = p.read(job.receipt); p.put(job.receipt, originalReceipt + ' ');
  assert.equal(p.run('audit', 'drain', '--file', proposal, '--limit', '1').status, 1); p.put(job.receipt, originalReceipt);
  const originalSnapshot = p.read(job.snapshot); p.put(job.snapshot, originalSnapshot + ' ');
  assert.equal(p.run('audit', 'status', '--file', proposal).status, 1); p.put(job.snapshot, originalSnapshot);
  p.put('ordinary.txt', 'not a queue\n'); rmSync(join(p.root, queue)); symlinkSync(join(p.root, 'ordinary.txt'), join(p.root, queue));
  assert.equal(p.run('audit', 'status', '--file', proposal).status, 1); assert.equal(p.run('audit', 'enqueue', '--file', proposal, '--author', 'coder').status, 1);
  assert.equal(p.read(map), before); assert.equal(p.read('ordinary.txt'), 'not a queue\n');
});

test('live audit witness context journey: existing test files freeze automatically and changed witnesses invalidate readiness', t => {
  const p = project(t), data = JSON.parse(p.read(proposal));
  data.scenarios[0].state = 'existing'; data.scenarios[0].existingPaths = ['caller.txt']; p.put(proposal, data);
  p.enqueue('--limit', '1'); const claim = p.claim(); assert.equal(claim.snapshot.files.length, 2);
  assert.ok(claim.snapshot.files.some(file => file.path === 'caller.txt')); p.record(claim, { readiness: 'ready' });
  assert.equal(p.json('audit', 'drain', '--file', proposal, '--limit', '1').executableReady, true);
  p.put('caller.txt', 'Changed test contract.\n');
  const gate = p.run('audit', 'drain', '--file', proposal, '--limit', '1'); assert.equal(gate.status, 1);
  assert.equal(JSON.parse(gate.stdout).counts.stale, 1); assert.equal(JSON.parse(gate.stdout).executableReady, false);
});

test('live audit recovery journey: interrupted queue commit reuses exact orphan snapshots without rewriting provenance', t => {
  const p = project(t); p.enqueue('--limit', '1'); const savedQueue = p.read(queue), job = JSON.parse(savedQueue).jobs[0];
  const savedSnapshot = p.read(job.snapshot);
  // The fixture owner preserves the queue copy then simulates the on-disk state
  // after snapshot persistence but before an interrupted queue commit.
  p.put('preserved-queue.json', savedQueue); rmSync(join(p.root, queue));
  const changed = JSON.parse(p.read(proposal)); changed.note = 'Unrelated proposal metadata changed while recovering.'; p.put(proposal, changed);
  const recovered = p.enqueue('--limit', '1'); assert.deepEqual(recovered.enqueued, [job.id]);
  assert.equal(p.read(job.snapshot), savedSnapshot, 'Original immutable provenance must not be replaced.');
  assert.equal(JSON.parse(p.read(queue)).jobs[0].snapshotSha256, job.snapshotSha256);
  const claim = p.claim(); assert.notEqual(claim.snapshot.proposalSha256, hash(p.read(proposal)));
  p.record(claim); assert.equal(p.json('audit', 'drain', '--file', proposal, '--limit', '1').complete, true);
  rmSync(join(p.root, queue)); const conflict = JSON.parse(savedSnapshot); conflict.files[0].text = 'Conflicting source bytes.\n'; p.put(job.snapshot, conflict);
  const conflictingBytes = p.read(job.snapshot); const rejected = p.run('audit', 'enqueue', '--file', proposal, '--author', 'coder', '--limit', '1');
  assert.equal(rejected.status, 1); assert.match(rejected.stderr, /snapshot conflicts/); assert.equal(p.read(job.snapshot), conflictingBytes);
  assert.equal(existsSync(join(p.root, queue)), false);
});

test('live audit input guards: fail closed on unsafe receipts, corrupt queue metadata and unsupported public options', t => {
  const p = project(t); p.enqueue('--limit', '1'); const claim = p.claim(), savedQueue = p.read(queue), oldMap = p.read(map);
  for (const args of [[], ['unknown'], ['status'], ['record'], ['retry', '--job', 'unknown'], ['enqueue', '--file', proposal, '--author', 'coder', '--offset', '999'],
    ['status', '--file', proposal, '--json', '--json'], ['status', '--file', proposal, '--unknown'],
    ['enqueue', '--file', proposal, '--author', ' coder '], ['enqueue', '--file', proposal, '--author', 'coder', '--context', '.tracer/audits/queue.json']]) {
    assert.equal(p.run('audit', ...args).status, 1); assert.equal(p.read(queue), savedQueue);
  }
  p.put('valid-receipt.json', p.receipt(claim)); symlinkSync(join(p.root, 'valid-receipt.json'), join(p.root, 'receipt-alias.json'));
  for (const file of ['.git/config', 'docs/testing', 'receipt-alias.json', '../outside.json']) assert.equal(p.run('audit', 'record', '--file', file).status, 1);
  p.put('bad-json.json', '{bad'); assert.equal(p.run('audit', 'record', '--file', 'bad-json.json').status, 1);
  p.put('large-receipt.json', ' '.repeat(64 * 1024 * 1024 + 1));
  assert.match(p.run('audit', 'record', '--file', 'large-receipt.json').stderr, /exceeds 64 MiB/);
  for (const mutate of [v => { v.kind = 'other'; }, v => { v.jobs.push(v.jobs[0]); }, v => { v.maxPending = 0; },
    v => { v.jobs[0].state = 'passed'; }, v => { v.jobs[0].snapshot = '../other.json'; }, v => { v.jobs[0].claim = ''; }]) {
    const value = JSON.parse(savedQueue); mutate(value); p.put(queue, value);
    assert.equal(p.run('audit', 'status', '--file', proposal).status, 1);
  }
  p.put(queue, savedQueue); p.record(claim); assert.equal(p.read(map), oldMap);
});


test('live audit assertion bounds: reject unrecordable work before persistence and support the exact receipt limit', t => {
  const p = project(t); p.draft.associations = [p.draft.associations[0]];
  p.draft.associations[0].proposedAssertions = Array(5000).fill('The isolated synthetic title is retained.');
  p.draft.scenarios[0].expectedOutcomes = Array(5001).fill('The reopened synthetic title is retained.');
  p.prepare(); const tooLarge = p.run('audit', 'enqueue', '--file', proposal, '--author', 'coder');
  assert.equal(tooLarge.status, 1); assert.match(tooLarge.stderr, /Invalid audit required assertions/);
  assert.equal(existsSync(join(p.root, queue)), false, 'Unrecordable work cannot consume queue capacity.');
  assert.equal(existsSync(join(p.root, '.tracer/audits/snapshots')), false, 'Rejected input leaves no immutable snapshot.');
  p.draft.scenarios[0].expectedOutcomes.pop(); p.prepare(); p.enqueue();
  const claim = p.claim(); assert.equal(claim.snapshot.assertions.length, 10000); assert.equal(claim.receiptTemplate.assertionAssessments.length, 10000);
  p.record(claim); assert.equal(p.json('audit', 'drain', '--file', proposal).complete, true);
});
