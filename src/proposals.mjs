import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { safePath } from './tracer.mjs';

export const DEFAULT_PROPOSAL = 'docs/testing/proposed-scenario-map.json';
export const PROPOSAL_NOTICE = 'PROPOSED SCENARIO ASSOCIATIONS ONLY. Unreviewed plans are not reviewed links, exact runtime command logs, observed execution, passing assertions or measured coverage. Audit later in bounded batches; nothing is promoted automatically.';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const percent = (n, d) => d ? n * 100 / d : null;
const fail = message => { throw new Error(message); };
const MAX_BYTES = 32 * 1024 * 1024, MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
function text(value, label, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > 16384 || /[\x00-\x1f\x7f]/.test(value)) fail(`Invalid proposal ${label}.`);
}
function id(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value)) fail(`Invalid proposal ${label}.`);
}
function list(value, label, empty = false) {
  if (!Array.isArray(value) || (!empty && !value.length) || value.length > 100000) fail(`Invalid proposal ${label} array.`);
}
function strings(value, label, empty = false) { list(value, label, empty); for (const item of value) text(item, label); }
function filePath(root, file) {
  safePath(file);
  if (file.split('/').includes('.git')) fail('Proposal paths cannot enter .git.');
  let path = root;
  const parts = file.split('/');
  for (const [index, part] of parts.entries()) {
    path = resolve(path, part);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || realpathSync(path) !== path || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) fail(`Proposal path must be a regular unsymlinked repository file: ${file}`);
  }
  return path;
}
function readProposal(root, file, map) {
  if (file === map || file.startsWith(`${map}.`)) fail('Proposal must be separate from the reviewed map and its working files.');
  const path = filePath(root, file);
  if (lstatSync(path).size > MAX_BYTES) fail('Proposal exceeds 32 MiB.');
  const bytes = readFileSync(path);
  if (bytes.length > MAX_BYTES) fail('Proposal exceeds 32 MiB.');
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!value || value.schemaVersion !== 1 || value.kind !== 'proposed-scenario-association-map'
      || value.status !== 'model-proposed-unreviewed') fail('Expected version-1 proposed-scenario-association-map with model-proposed-unreviewed status.');
  list(value.scenarios, 'scenarios', true); list(value.associations, 'associations', true);
  return { value, proposalSha256: hash(bytes) };
}
// Compatibility with the initial proposal artifact: normalize CRLF to LF,
// omit each physical line ending, then join the selected span with LF. The exact
// full-file hash remains mandatory, so normalization cannot hide a byte change.
function spanHash(lines, start, end) {
  return hash(lines.slice(start - 1, end).map(line => line.replace(/\r?\n$/, '').replace(/\r$/, '')).join('\n'));
}
function inspectProposal(root, value, state, { prepare = false } = {}) {
  const scenarios = new Map(), rangeIds = new Set(), candidates = [], issues = [], occupied = new Map(), fileHashes = new Map();
  for (const scenario of value.scenarios) {
    id(scenario?.id, 'scenario id'); text(scenario.title, 'scenario title'); id(scenario.featureId, 'feature id');
    if (scenarios.has(scenario.id)) fail(`Duplicate proposal scenario: ${scenario.id}`);
    if (!['existing', 'needs-extension', 'unwritten'].includes(scenario.state)) fail(`Invalid proposal scenario state: ${scenario.id}`);
    strings(scenario.existingPaths, 'existing paths', true); strings(scenario.plannedActions, 'planned actions'); strings(scenario.expectedOutcomes, 'expected outcomes');
    if (scenario.state === 'unwritten' && scenario.existingPaths.length) fail(`Unwritten proposal cannot claim existing test files: ${scenario.id}`);
    for (const path of scenario.existingPaths) filePath(root, path);
    scenarios.set(scenario.id, scenario);
  }
  for (const [index, row] of value.associations.entries()) {
    id(row?.rangeId, 'range id');
    if (rangeIds.has(row.rangeId)) fail(`Duplicate proposal range id: ${row.rangeId}`);
    rangeIds.add(row.rangeId);
    if (row.status !== 'model-proposed-unreviewed') fail(`Proposal association must remain model-proposed-unreviewed: ${row.rangeId}`);
    id(row.featureId, 'association feature id'); strings(row.scenarioIds, 'scenario ids');
    if (new Set(row.scenarioIds).size !== row.scenarioIds.length || row.scenarioIds.some(key => !scenarios.has(key))) fail(`Unknown or duplicate scenario reference: ${row.rangeId}`);
    text(row.rationale, 'rationale'); text(row.uncertainty, 'uncertainty', true); strings(row.proposedAssertions, 'assertions');
    if (!['low', 'medium', 'high'].includes(row.confidence)) fail(`Invalid proposal confidence: ${row.rangeId}`);
    const source = row.source;
    if (!source || typeof source !== 'object') fail(`Missing proposal source: ${row.rangeId}`);
    safePath(source.path);
    if (!Number.isSafeInteger(source.start) || !Number.isSafeInteger(source.end) || source.start < 1 || source.end < source.start) fail(`Invalid proposal source range: ${row.rangeId}`);
    const candidate = { index, row, current: true, errors: [] }; candidates.push(candidate);
    const problem = message => { candidate.current = false; candidate.errors.push(message); issues.push(`${row.rangeId}: ${message}`); };
    const lines = state.files.get(source.path);
    if (!lines || source.end > lines.length) { problem('Source is missing, outside inventory or out of bounds.'); continue; }
    if (!fileHashes.has(source.path)) {
      fileHashes.set(source.path, hash(lines.join('')));
    }
    for (const [key, current] of [['fileSha256', fileHashes.get(source.path)], ['spanSha256', spanHash(lines, source.start, source.end)], ...(prepare || Object.hasOwn(source, 'sha256') ? [['sha256', hash(lines.slice(source.start - 1, source.end).join(''))]] : [])]) {
      if (prepare && source[key] === undefined) source[key] = current;
      if (!sha(source[key])) problem(`Missing or invalid ${key}; use proposal prepare to pin missing hashes.`);
      else if (source[key] !== current) problem(`Stale ${key}; review the source instead of refreshing old pins.`);
    }
    let entries = occupied.get(source.path); if (!entries) { entries = []; occupied.set(source.path, entries); }
    entries.push(candidate);
  }
  // Associations partition source ranges; represent multiple relevant scenarios
  // in one row instead of overlapping rows or repeatedly counting shared lines.
  for (const entries of occupied.values()) {
    entries.sort((a, b) => a.row.source.start - b.row.source.start || a.row.source.end - b.row.source.end);
    let furthest;
    for (const candidate of entries) {
      if (furthest && candidate.row.source.start <= furthest.row.source.end) {
        for (const item of [furthest, candidate]) if (!item.errors.includes('Overlapping proposal ranges.')) {
          item.current = false; item.errors.push('Overlapping proposal ranges.'); issues.push(`${item.row.rangeId}: Overlapping proposal ranges.`);
        }
      }
      if (!furthest || candidate.row.source.end > furthest.row.source.end) furthest = candidate;
    }
  }
  return { scenarios, candidates, issues };
}
function summarize(input, inspected, state, files, totals, file) {
  const included = new Map(files.map(value => [value.path, value])), counts = new Map();
  for (const { row, current } of inspected.candidates) {
    if (!current) continue;
    const source = row.source, scope = included.get(source.path);
    if (!scope) continue;
    let lines = counts.get(source.path); if (!lines) { lines = new Set(); counts.set(source.path, lines); }
    const text = state.files.get(source.path);
    for (let line = Math.max(source.start, scope.start); line <= Math.min(source.end, scope.end); line++) {
      if (text[line - 1].trim() && !scope.commentRanges.some(([a, b]) => line >= a && line <= b)) lines.add(line);
    }
  }
  const lines = [...counts.values()].reduce((sum, set) => sum + set.size, 0);
  return { status: inspected.issues.length ? 'issues' : 'model-proposed-unreviewed', file, proposalSha256: input.proposalSha256,
    lines, denominator: totals.lines, percent: percent(lines, totals.lines), unassociatedLines: totals.lines - lines,
    associations: inspected.candidates.length, currentAssociations: inspected.candidates.filter(value => value.current).length,
    scenarios: inspected.scenarios.size, scenarioStates: Object.fromEntries(['existing', 'needs-extension', 'unwritten'].map(key => [key, [...inspected.scenarios.values()].filter(value => value.state === key).length])),
    uncertainAssociations: inspected.candidates.filter(value => value.row.uncertainty.trim()).length, issues: inspected.issues };
}
export function proposalProgress(root, state, files, totals, map) {
  const empty = { file: DEFAULT_PROPOSAL, lines: 0, denominator: totals.lines, percent: null, unassociatedLines: totals.lines, issues: [] };
  try {
    // lstat sees dangling symlinks as invalid instead of treating them as missing.
    try { lstatSync(resolve(root, DEFAULT_PROPOSAL)); } catch (error) { if (error.code === 'ENOENT') return { ...empty, status: 'missing' }; throw error; }
    const input = readProposal(root, DEFAULT_PROPOSAL, map), inspected = inspectProposal(root, input.value, state);
    return summarize(input, inspected, state, files, totals, DEFAULT_PROPOSAL);
  } catch (error) { return { ...empty, status: 'invalid', issues: [error.message] }; }
}
export function proposalCommand(tracer, file, { mode, offset = 0, limit = 25 } = {}, snapshot) {
  if (!snapshot) return tracer.proposal(file, { mode, offset, limit });
  const input = readProposal(tracer.root, file, tracer.map), { state } = snapshot;
  const inspected = inspectProposal(tracer.root, input.value, state, { prepare: mode === 'prepare' });
  if (mode === 'prepare') {
    if (inspected.issues.length) fail(inspected.issues.join('\n'));
    return input.value;
  }
  const report = snapshot.report(), proposed = summarize(input, inspected, state, report.files, report.totals, file);
  const progress = { proposed, reviewed: report.progress.reviewed, executed: report.progress.executed };
  const result = { kind: `scenario-proposal-${mode}`, notice: PROPOSAL_NOTICE, valid: inspected.issues.length === 0,
    lineBasis: report.lineBasis, progress };
  if (mode === 'report') return { ...result, scenarios: input.value.scenarios, associations: input.value.associations };
  if (mode === 'audit') {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail('Proposal audit requires --offset >= 0 and --limit 1-1000.');
    const batch = inspected.candidates.slice(offset, offset + limit);
    let expandedBytes = 0;
    const associations = batch.map(({ row, current, errors }) => {
      const entry = { ...row, current, errors,
        sourceSnippet: current ? state.files.get(row.source.path).slice(row.source.start - 1, row.source.end).join('') : null,
        scenarios: row.scenarioIds.map(id => inspected.scenarios.get(id)) };
      expandedBytes += Buffer.byteLength(JSON.stringify(entry));
      if (expandedBytes > MAX_EXPANDED_BYTES) fail('Expanded proposal audit exceeds 64 MiB; select a smaller batch.');
      return entry;
    });
    return { ...result, offset, limit, nextOffset: offset + batch.length < inspected.candidates.length ? offset + batch.length : null,
      associations };
  }
  return result;
}
