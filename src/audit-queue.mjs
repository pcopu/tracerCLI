import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { safePath } from './tracer.mjs';
import { readProposal, inspectProposal } from './proposals.mjs';

const BASE = '.tracer/audits', QUEUE = `${BASE}/queue.json`, MAX = 64 * 1024 * 1024;
export const AUDIT_NOTICE = 'REVIEWER-DECLARED SEMANTIC AUDIT. The durable queue does not launch workers, certify correctness, execute tests or promote manual links. A current receipt is not execution evidence.';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = message => { throw Error(message); };
const stable = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const now = () => new Date().toISOString();
function text(value, label) { if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 16384 || /[\x00-\x1f\x7f]/.test(value)) fail(`Invalid audit ${label}.`); }
function integer(value, low, high, label) { if (!Number.isSafeInteger(value) || value < low || value > high) fail(`Audit ${label} must be ${low}-${high}.`); return value; }
function array(value, label, empty = false) { if (!Array.isArray(value) || (!empty && !value.length) || value.length > 10000) fail(`Invalid audit ${label}.`); }
function path(root, relative, missing = false) {
  safePath(relative); if (relative.split('/').includes('.git')) fail('Audit paths cannot enter .git.');
  let absolute = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    absolute = resolve(absolute, part);
    let stat;
    try { stat = lstatSync(absolute); } catch (error) { if (missing && error.code === 'ENOENT') return resolve(root, relative); throw error; }
    if (stat.isSymbolicLink() || realpathSync(absolute) !== absolute || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) fail(`Audit path must be a regular unsymlinked file: ${relative}`);
  }
  return absolute;
}
function readJSON(root, relative) {
  const absolute = path(root, relative);
  if (lstatSync(absolute).size > MAX) fail('Audit file exceeds 64 MiB.');
  const bytes = readFileSync(absolute); if (bytes.length > MAX) fail('Audit file exceeds 64 MiB.');
  return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), sha256: hash(bytes) };
}
function immutable(root, relative, value) {
  const absolute = path(root, relative, true), bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > MAX) fail('Audit snapshot or receipt exceeds 64 MiB.');
  mkdirSync(dirname(absolute), { recursive: true }); path(root, relative, true);
  try { writeFileSync(absolute, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST' || readFileSync(path(root, relative), 'utf8') !== bytes) throw error; }
  return hash(bytes);
}
function storeSnapshot(root, relative, frozen) {
  let previous;
  try { previous = readJSON(root, relative); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!previous) return immutable(root, relative, frozen);
  // An interrupted queue commit can leave this immutable file behind. Reuse only
  // equivalent input, retaining its original whole-proposal provenance.
  const old = previous.value;
  if (old?.version !== 1 || old.kind !== frozen.kind || old.jobId !== frozen.jobId || old.proposal !== frozen.proposal
      || !sha(old.proposalSha256) || stable(old.contract) !== stable(frozen.contract)
      || stable(old.files) !== stable(frozen.files) || stable(old.assertions) !== stable(frozen.assertions)) fail('Existing audit snapshot conflicts with queued input; preserve and inspect it.');
  return previous.sha256;
}
function readQueue(root) {
  try { lstatSync(resolve(root, QUEUE)); } catch (error) { if (error.code === 'ENOENT') return { version: 1, kind: 'supervised-semantic-audit-queue', maxPending: 100, maxRunning: 1, sequence: 0, jobs: [] }; throw error; }
  const { value } = readJSON(root, QUEUE);
  if (value?.version !== 1 || value.kind !== 'supervised-semantic-audit-queue') fail('Invalid audit queue; preserve and repair it explicitly.');
  integer(value.maxPending, 1, 1000, 'max pending'); integer(value.maxRunning, 1, 1, 'max running'); integer(value.sequence, 0, Number.MAX_SAFE_INTEGER, 'sequence');
  array(value.jobs, 'jobs', true); const ids = new Set();
  for (const job of value.jobs) {
    if (!sha(job?.id) || ids.has(job.id) || !sha(job.snapshotSha256) || job.snapshot !== `${BASE}/snapshots/${job.id}.json`
        || !['pending', 'running', 'reviewed', 'failed'].includes(job.state)) fail('Invalid audit job record.');
    ids.add(job.id); text(job.author, 'author'); text(job.rangeId, 'range id'); safePath(job.proposal);
    integer(job.order, 1, value.sequence, 'job order'); array(job.history, 'history');
    if (job.state === 'running') { text(job.worker, 'worker'); text(job.claim, 'claim'); }
    if (job.state === 'reviewed' && (!sha(job.receiptSha256) || job.receipt !== `${BASE}/receipts/${job.receiptSha256}.json`)) fail('Invalid audit receipt reference.');
  }
  return value;
}
function mutate(root, fn) {
  const absolute = path(root, QUEUE, true), lock = `${QUEUE}.lock`, temporary = `${QUEUE}.${randomUUID()}.tmp`;
  mkdirSync(dirname(absolute), { recursive: true }); path(root, QUEUE, true);
  // Keep newly created local evidence out of ordinary git add, without replacing custom ignores.
  const ignore = path(root, `${BASE}/.gitignore`, true);
  try { writeFileSync(ignore, '# Private local audit evidence; do not publish by default.\n*\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  try { writeFileSync(path(root, lock, true), `${process.pid}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') fail('Audit queue writer or stale lock exists; verify its owner before recovery.'); throw error; }
  try {
    const queue = readQueue(root), result = fn(queue);
    if (result.changed) {
      const bytes = `${JSON.stringify(queue, null, 2)}\n`; if (Buffer.byteLength(bytes) > MAX) fail('Audit queue exceeds 64 MiB; archive deliberately before continuing.');
      writeFileSync(path(root, temporary, true), bytes, { flag: 'wx', mode: 0o600 }); path(root, QUEUE, true);
      renameSync(resolve(root, temporary), absolute);
    }
    return { notice: AUDIT_NOTICE, ...result };
  } finally {
    try { unlinkSync(resolve(root, temporary)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    unlinkSync(resolve(root, lock));
  }
}
function context(tracer) {
  const state = tracer.inventory(), proposals = new Map(), files = new Map();
  return {
    proposal(file) {
      if (!proposals.has(file)) { const input = readProposal(tracer.root, file, tracer.map); proposals.set(file, { ...input, ...inspectProposal(tracer.root, input.value, state) }); }
      return proposals.get(file);
    },
    file(file) {
      if (!files.has(file)) {
        if (!state.candidates.has(file) || file.startsWith(`${BASE}/`)) fail(`Audit context is outside eligible repository text: ${file}`);
        const lines = state.files.get(file) ?? tracer.readLines(file), text = lines.join(''); files.set(file, { path: file, text, sha256: hash(text) });
      }
      return files.get(file);
    },
  };
}
function contract(input, rangeId) {
  const candidate = input.candidates.find(value => value.row.rangeId === rangeId);
  if (!candidate || !candidate.current) fail(`Audit association is missing or stale: ${rangeId}`);
  return { association: candidate.row, scenarios: candidate.row.scenarioIds.map(id => input.scenarios.get(id)).sort((a, b) => a.id.localeCompare(b.id)) };
}
function assertions(contract) {
  if (contract.association.proposedAssertions.length + contract.scenarios.reduce((sum, scenario) => sum + scenario.expectedOutcomes.length, 0) > 10000) fail('Invalid audit required assertions.');
  const required = [...contract.association.proposedAssertions.map((description, i) => ({ id: `range:${i}`, description })),
    ...contract.scenarios.flatMap(scenario => scenario.expectedOutcomes.map((description, i) => ({ id: `scenario:${scenario.id}:${i}`, description })))];
  array(required, 'required assertions');
  return required;
}
function snapshot(root, job) {
  const read = readJSON(root, job.snapshot), value = read.value;
  if (read.sha256 !== job.snapshotSha256 || value?.kind !== 'semantic-audit-snapshot' || value.jobId !== job.id || value.proposal !== job.proposal || value.contract?.association?.rangeId !== job.rangeId) fail('Audit snapshot identity mismatch.');
  array(value.files, 'snapshot files');
  for (const file of value.files) if (typeof file.text !== 'string' || !sha(file.sha256) || hash(file.text) !== file.sha256) fail('Corrupt audit snapshot source.');
  if (stable(value.assertions) !== stable(assertions(value.contract))) fail('Corrupt audit assertion list.');
  return value;
}
function current(ctx, frozen) {
  try {
    if (stable(contract(ctx.proposal(frozen.proposal), frozen.contract.association.rangeId)) !== stable(frozen.contract)) return false;
    return frozen.files.every(file => ctx.file(file.path).sha256 === file.sha256);
  } catch { return false; }
}
function change(queue, job, state, detail) {
  job.state = state; job.updatedAt = now(); job.history.push({ state, at: job.updatedAt, ...detail });
}
function receipt(root, job, frozen) {
  const input = readJSON(root, job.receipt); if (input.sha256 !== job.receiptSha256) fail('Audit receipt changed after recording.');
  validateReceipt(input.value, job, frozen); return input.value;
}
function template(job, frozen) {
  const source = frozen.contract.association.source, file = frozen.files.find(file => file.path === source.path);
  const lines = file.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  return { version: 1, kind: 'semantic-audit-receipt', jobId: job.id, snapshotSha256: job.snapshotSha256,
    claim: job.claim, reviewer: job.worker, execution: 'not-assessed', associationFit: 'unresolved', assertionAdequacy: 'unresolved',
    readiness: 'blocked', rationale: '', corrections: [],
    assertionAssessments: frozen.assertions.map(item => ({ id: item.id, decision: 'unresolved', fixture: '', action: '', state: '', oracle: '', guards: '', rationale: '' })),
    evidence: [{ path: source.path, start: source.start, end: source.end, sha256: hash(lines.slice(source.start - 1, source.end).join('')), observation: '' }] };
}
function validateReceipt(value, job, frozen) {
  if (value?.version !== 1 || value.kind !== 'semantic-audit-receipt' || value.jobId !== job.id || value.snapshotSha256 !== job.snapshotSha256
      || value.claim !== job.claim || value.reviewer !== job.worker || value.reviewer === job.author || value.execution !== 'not-assessed') fail('Audit receipt must match the claimed immutable snapshot and independent reviewer; execution is not assessed.');
  for (const key of ['associationFit', 'assertionAdequacy']) if (!['accepted', 'needs-correction', 'unresolved'].includes(value[key])) fail(`Invalid audit ${key}.`);
  if (!['ready', 'needs-implementation', 'blocked'].includes(value.readiness)) fail('Invalid audit readiness.');
  text(value.rationale, 'rationale'); array(value.corrections, 'corrections', true); for (const item of value.corrections) text(item, 'correction');
  if (value.corrections.length && value.associationFit === 'accepted' && value.assertionAdequacy === 'accepted') fail('Accepted audit judgments cannot hide open corrections.');
  if (value.readiness === 'ready' && frozen.contract.scenarios.some(scenario => scenario.state !== 'existing')) fail('Ready audit contradicts a scenario still unwritten or needing extension.');
  array(value.assertionAssessments, 'assertion assessments'); const seen = new Set(), expected = new Set(frozen.assertions.map(item => item.id));
  for (const item of value.assertionAssessments) {
    if (!expected.has(item?.id) || seen.has(item.id)) fail('Unknown or duplicate audit assertion.');
    seen.add(item.id);
    if (!['accepted', 'needs-correction', 'unresolved'].includes(item.decision)) fail('Invalid assertion decision.');
    for (const key of ['fixture', 'action', 'state', 'oracle', 'guards', 'rationale']) text(item[key], `assertion ${key}`);
  }
  if (seen.size !== frozen.assertions.length) fail('Audit must assess every range-specific and shared-scenario assertion.');
  if (value.assertionAdequacy === 'accepted' && value.assertionAssessments.some(item => item.decision !== 'accepted')) fail('Accepted assertion adequacy cannot conceal a correction or unresolved assertion.');
  if ([value.associationFit, value.assertionAdequacy, ...value.assertionAssessments.map(item => item.decision)].includes('needs-correction') && !value.corrections.length) fail('Correction-needed audit requires actionable corrections.');
  array(value.evidence, 'evidence'); let sourceEvidence = false;
  for (const item of value.evidence) {
    const file = frozen.files.find(file => file.path === item?.path); if (!file) fail('Audit evidence must be in the immutable snapshot, not the live tree.');
    const lines = file.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    integer(item.start, 1, lines.length, 'evidence start'); integer(item.end, item.start, lines.length, 'evidence end'); text(item.observation, 'evidence observation');
    if (!sha(item.sha256) || hash(lines.slice(item.start - 1, item.end).join('')) !== item.sha256) fail('Audit evidence hash does not match frozen bytes.');
    const source = frozen.contract.association.source;
    if (item.path === source.path && item.end >= source.start && item.start <= source.end) sourceEvidence = true;
  }
  if (!sourceEvidence) fail('Audit needs evidence overlapping the proposed source association.');
}
function selection(input, options, defaults = false) {
  const offset = integer(options.offset ?? 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
  const limit = options.limit === undefined ? (defaults ? 25 : input.candidates.length || 1) : integer(options.limit, 1, 1000, 'limit');
  return input.candidates.slice(offset, offset + limit);
}
export function auditQueue(tracer, mode, options = {}) {
  if (['enqueue', 'status', 'drain'].includes(mode) && !options.file) fail(`audit ${mode} requires --file.`);
  const ctx = context(tracer);
  if (mode === 'status' || mode === 'drain') {
    const queue = readQueue(tracer.root), input = ctx.proposal(options.file), selected = selection(input, options), results = [];
    for (const candidate of selected) {
      const job = queue.jobs.filter(job => job.proposal === options.file && job.rangeId === candidate.row.rangeId).sort((a, b) => b.order - a.order)[0];
      let status = candidate.current ? 'missing' : 'stale', assessment = null;
      if (job) {
        const frozen = snapshot(tracer.root, job);
        status = current(ctx, frozen) ? job.state : 'stale';
        if (status === 'reviewed') {
          const value = receipt(tracer.root, job, frozen); assessment = { associationFit: value.associationFit, assertionAdequacy: value.assertionAdequacy, readiness: value.readiness, reviewer: value.reviewer };
          status = [value.associationFit, value.assertionAdequacy].includes('needs-correction') ? 'needs-correction'
            : [value.associationFit, value.assertionAdequacy].includes('unresolved') ? 'unresolved' : 'accepted';
        }
      }
      results.push({ rangeId: candidate.row.rangeId, jobId: job?.id ?? null, status, assessment });
    }
    const scope = new Set(results.map(row => row.rangeId));
    const outstandingJobs = queue.jobs.filter(job => job.proposal === options.file && scope.has(job.rangeId) && ['pending', 'running'].includes(job.state))
      .map(job => ({ jobId: job.id, rangeId: job.rangeId, state: job.state, current: current(ctx, snapshot(tracer.root, job)) }));
    const complete = results.length > 0 && !outstandingJobs.length && results.every(row => row.status === 'accepted');
    return { kind: `semantic-audit-${mode}`, notice: AUDIT_NOTICE, proposalSha256: input.proposalSha256,
      scope: { offset: options.offset ?? 0, count: results.length, totalAssociations: input.candidates.length }, complete, outstandingJobs,
      executableReady: complete && results.every(row => row.assessment?.readiness === 'ready'), execution: 'not-assessed',
      queueCounts: Object.fromEntries(['pending', 'running', 'reviewed', 'failed'].map(key => [key, queue.jobs.filter(job => job.state === key).length])),
      currentScopeSha256: hash(stable(results.map(row => [row.rangeId, row.jobId, row.status]))),
      counts: Object.fromEntries(['missing', 'pending', 'running', 'failed', 'stale', 'needs-correction', 'unresolved', 'accepted'].map(key => [key, results.filter(row => row.status === key).length])), results };
  }
  return mutate(tracer.root, queue => {
    if (mode === 'enqueue') {
      text(options.author, 'author');
      if (!queue.jobs.length && options.maxPending !== undefined) queue.maxPending = integer(options.maxPending, 1, 1000, 'max pending');
      else if (options.maxPending !== undefined && options.maxPending !== queue.maxPending) fail('Existing queue capacity is fixed; use its current max-pending value.');
      const input = ctx.proposal(options.file), rows = selection(input, options, true), staged = [], reused = [];
      if (!rows.length) fail('Audit enqueue selected no associations.');
      for (const candidate of rows) {
        const declared = contract(input, candidate.row.rangeId), files = [...new Set([declared.association.source.path, ...declared.scenarios.flatMap(scenario => scenario.existingPaths), ...(options.context ?? [])])].sort().map(file => ctx.file(file));
        array(files, 'snapshot files');
        const id = hash(stable({ proposal: options.file, contract: declared, files: files.map(({ path, sha256 }) => ({ path, sha256 })) }));
        const previous = queue.jobs.find(job => job.id === id);
        if (previous) { snapshot(tracer.root, previous); reused.push(previous); continue; }
        const frozen = { version: 1, kind: 'semantic-audit-snapshot', jobId: id, proposal: options.file, proposalSha256: input.proposalSha256, contract: declared, assertions: assertions(declared), files };
        staged.push({ id, rangeId: candidate.row.rangeId, proposal: options.file, author: options.author, frozen });
      }
      if (queue.jobs.filter(job => ['pending', 'running'].includes(job.state)).length + staged.length > queue.maxPending) fail('Audit queue capacity exceeded; keep coding and explicitly finish/fail pending work before enqueueing more.');
      if (queue.jobs.length + staged.length > 10000) fail('Audit history reached 10000 jobs; archive deliberately before continuing.');
      for (const item of staged) {
        const location = `${BASE}/snapshots/${item.id}.json`, snapshotSha256 = storeSnapshot(tracer.root, location, item.frozen);
        const job = { ...item, snapshot: location, snapshotSha256, order: ++queue.sequence, state: 'pending', createdAt: now(), history: [] }; delete job.frozen;
        change(queue, job, 'pending', { reason: 'Immutable source and complete scenario contract queued.' }); queue.jobs.push(job);
      }
      // Explicitly reselecting identical historical input may reuse its exact receipt.
      for (const job of reused) if (queue.jobs.some(other => other.proposal === job.proposal && other.rangeId === job.rangeId && other.order > job.order)) job.order = ++queue.sequence;
      return { changed: staged.length > 0 || reused.length > 0, enqueued: staged.map(job => job.id), reused: reused.map(job => job.id), maxPending: queue.maxPending };
    }
    if (mode === 'claim') {
      text(options.worker, 'worker');
      if (queue.jobs.filter(job => job.state === 'running').length >= queue.maxRunning) fail('Audit worker capacity reached; supervise the running job or record its failure explicitly.');
      const candidates = queue.jobs.filter(job => job.state === 'pending' && (!options.job || job.id === options.job)).sort((a, b) => a.order - b.order);
      const job = candidates.find(job => job.author !== options.worker && current(ctx, snapshot(tracer.root, job)));
      if (!job) fail('No current pending audit for this independent worker. Stale or same-author jobs require explicit attention.');
      job.worker = options.worker; job.claim = randomUUID(); change(queue, job, 'running', { worker: job.worker, claim: job.claim });
      const frozen = snapshot(tracer.root, job);
      return { changed: true, jobId: job.id, claim: job.claim, snapshotSha256: job.snapshotSha256, snapshot: frozen, receiptTemplate: template(job, frozen) };
    }
    if (mode === 'record') {
      if (!options.file) fail('audit record requires --file.');
      const input = readJSON(tracer.root, options.file), value = input.value, job = queue.jobs.find(job => job.id === value?.jobId);
      if (!job || job.state !== 'running') fail('Receipt requires a currently claimed audit job.');
      const frozen = snapshot(tracer.root, job); validateReceipt(value, job, frozen);
      const location = `${BASE}/receipts/${hash(`${JSON.stringify(value, null, 2)}\n`)}.json`;
      job.receiptSha256 = immutable(tracer.root, location, value); job.receipt = location;
      change(queue, job, 'reviewed', { receiptSha256: job.receiptSha256 });
      return { changed: true, jobId: job.id, current: current(ctx, frozen), state: 'reviewed', assessment: { associationFit: value.associationFit, assertionAdequacy: value.assertionAdequacy, readiness: value.readiness } };
    }
    const job = queue.jobs.find(job => job.id === options.job); if (!job) fail('Unknown audit job.');
    if (mode === 'fail') {
      text(options.reason, 'failure reason');
      if (!['pending', 'running'].includes(job.state) || job.state === 'running' && options.claim !== job.claim) fail('Fail requires pending work or the exact active claim.');
      change(queue, job, 'failed', { reason: options.reason }); return { changed: true, jobId: job.id, state: job.state };
    }
    if (mode === 'retry') {
      if (job.state !== 'failed' || !current(ctx, snapshot(tracer.root, job))) fail('Retry requires failed work on unchanged current input; enqueue changed input instead.');
      if (queue.jobs.filter(job => ['pending', 'running'].includes(job.state)).length >= queue.maxPending) fail('Audit queue capacity exceeded.');
      change(queue, job, 'pending', { reason: 'Explicit supervised retry.' }); return { changed: true, jobId: job.id, state: job.state };
    }
    fail('Unknown audit queue operation.');
  });
}
