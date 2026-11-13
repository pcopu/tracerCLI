import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { safePath, SOURCE_EXTENSIONS } from './tracer.mjs';

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
export function readProposal(root, file, map) {
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
export function inspectProposal(root, value, state, { prepare = false } = {}) {
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
export function proposalCommand(tracer, file, { mode, offset = 0, limit = 25, scenarioId } = {}, snapshot) {
  if (!snapshot) return tracer.proposal(file, { mode, offset, limit, scenarioId });
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
  if (mode === 'prioritize') return prioritize(inspected, state, report, result, limit);
  if (mode === 'next') {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10 || scenarioId !== undefined && limit !== 1) fail('next requires --limit 1-10; --scenario selects one task and requires limit 1.');
    if (scenarioId !== undefined && !inspected.scenarios.has(scenarioId)) fail(`Unknown proposal scenario: ${scenarioId}`);
    const selected = [], ranked = prioritize(inspected, state, report, result, limit, { scenarioId,
      onSelect: (candidate, entries, deficits) => selected.push({ scenario: candidate.scenario, potentialGapLines: candidate.remaining, entries, deficits }) });
    return nextPacket(tracer, file, report, ranked, selected, snapshot, scenarioId);
  }
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

function prioritize(inspected, state, report, result, limit, { scenarioId, onSelect } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail('Proposal prioritize requires --limit 1-1000.');
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const deficits = new Map(); let gapLines = 0;
  // One prefix count per included file clips proposals to actual witnessed gaps,
  // including action-only links but excluding blanks and current declared comments.
  for (const file of report.files) {
    const lines = state.files.get(file.path), prefix = new Uint32Array(lines.length + 1);
    let trace = 0, comment = 0;
    for (let line = 1; line <= lines.length; line++) {
      while (file.traceCounts[trace]?.end < line) trace++;
      while (file.commentRanges[comment]?.[1] < line) comment++;
      const declared = file.commentRanges[comment]?.[0] <= line;
      const gap = lines[line - 1].trim() && !declared && file.traceCounts[trace].withStepCount < report.minimumTraces;
      prefix[line] = prefix[line - 1] + (gap ? 1 : 0);
    }
    gapLines += prefix[lines.length]; deficits.set(file.path, prefix);
  }
  const scenarios = new Map([...inspected.scenarios].sort(([a], [b]) => compare(a, b)).map(([id, scenario]) =>
    [id, { scenario, rows: [], initial: 0, remaining: 0 }]));
  let proposedGapLines = 0;
  for (const { row, current, index } of inspected.candidates) {
    const prefix = deficits.get(row.source.path);
    if (!current || !prefix) continue;
    const weight = prefix[row.source.end] - prefix[row.source.start - 1];
    if (!weight) continue;
    // Valid associations partition source, so row weights are disjoint. Multiple
    // referring scenarios compete for the same weight instead of multiplying it.
    const entry = { row, index, weight, targeted: false }; proposedGapLines += weight;
    for (const id of row.scenarioIds) {
      const scenario = scenarios.get(id); scenario.rows.push(entry); scenario.initial += weight; scenario.remaining += weight;
    }
  }
  const eligible = [...scenarios.values()].filter(value => value.initial), ranking = [];
  let targetedGapLines = 0;
  while (ranking.length < limit) {
    let best;
    for (const candidate of eligible) if ((!scenarioId || candidate.scenario.id === scenarioId) && candidate.remaining > (best?.remaining ?? 0)) best = candidate;
    if (!best) break;
    const marginalGapLines = best.remaining, { scenario } = best;
    onSelect?.(best, best.rows.filter(entry => !entry.targeted), deficits);
    for (const entry of best.rows) {
      if (entry.targeted) continue;
      entry.targeted = true; targetedGapLines += entry.weight;
      for (const id of entry.row.scenarioIds) scenarios.get(id).remaining -= entry.weight;
    }
    const associationIds = best.rows.map(entry => entry.row.rangeId).sort(compare), paths = [...new Set(scenario.existingPaths)].sort(compare);
    ranking.push({ rank: ranking.length + 1, scenarioId: scenario.id, title: scenario.title, featureId: scenario.featureId, state: scenario.state,
      initialGapLines: best.initial, marginalGapLines, cumulativeTargetedGapLines: targetedGapLines,
      associationCount: associationIds.length, associationIds: associationIds.slice(0, 25), associationIdsTruncated: associationIds.length > 25,
      existingPathCount: paths.length, existingPaths: paths.slice(0, 10), existingPathsTruncated: paths.length > 10 });
  }
  const reuse = new Map();
  for (const candidate of eligible) for (const path of new Set(candidate.scenario.existingPaths)) {
    let group = reuse.get(path);
    if (!group) { group = { path, scenarioIds: [], rows: new Set() }; reuse.set(path, group); }
    group.scenarioIds.push(candidate.scenario.id);
    for (const row of candidate.rows) group.rows.add(row);
  }
  const opportunities = [...reuse.values()].filter(group => group.scenarioIds.length > 1).map(group => ({ path: group.path,
    gapLines: [...group.rows].reduce((sum, entry) => sum + entry.weight, 0), scenarioCount: group.scenarioIds.length,
    scenarioIds: group.scenarioIds.slice(0, 25), scenarioIdsTruncated: group.scenarioIds.length > 25 }))
    .sort((a, b) => b.gapLines - a.gapLines || compare(a.path, b.path));
  const diagnostics = { invalidLinks: report.invalid, invalidComments: report.invalidComments, invalidDeadCode: report.progress.deadCode.invalid,
    ignoredSources: report.ignoredSources, ignoredTotals: report.ignoredTotals, excluded: report.excluded };
  const output = { ...result, valid: result.valid && !diagnostics.invalidLinks.length && !diagnostics.invalidComments.length && !diagnostics.invalidDeadCode.length,
    selection: { method: 'greedy-marginal-unique-witness-gap-lines', minimumTraces: report.minimumTraces, denominator: report.totals.lines,
      gapLines, unproposedGapLines: gapLines - proposedGapLines, targetedGapLines, remainingGapLines: gapLines - targetedGapLines,
      eligibleScenarios: eligible.length, selectedScenarios: ranking.length, limit, hasMore: eligible.some(candidate => candidate.remaining > 0),
      notice: 'Unreviewed potential targets only, not closed deficits or distinct new witnessed traces. Greedy ranking makes no optimality or execution claim. Shared existing paths are reuse opportunities, not proof that scenarios can be merged. Audit full contracts before linking.' },
    ranking, reuseOpportunities: opportunities.slice(0, limit), reuseOpportunitiesTruncated: opportunities.length > limit, diagnostics };
  if (Buffer.byteLength(JSON.stringify(output, null, 2)) + 1 > MAX_EXPANDED_BYTES) fail('Expanded proposal prioritization exceeds 64 MiB; select a smaller limit or inspect global diagnostics separately.');
  return output;
}

function preview(values, maximum = 12, budget = 4096) {
  const items = []; let bytes = 0;
  for (const value of values) {
    const size = Buffer.byteLength(JSON.stringify(value));
    if (items.length === maximum || bytes + size > budget) break;
    items.push(value); bytes += size;
  }
  return { items, total: values.length, truncated: items.length < values.length, ...(items.length < values.length ? { sha256: hash(JSON.stringify(values)) } : {}) };
}
function excerpt(lines, start, end) {
  let text = '', last = start - 1;
  for (let line = start; line <= Math.min(end, start + 19); line++) {
    if (Buffer.byteLength(text) + Buffer.byteLength(lines[line - 1]) > 2048) break;
    text += lines[line - 1]; last = line;
  }
  return { text, start, end: last, sha256: hash(text), truncated: last < end, nextLine: last < end ? last + 1 : null };
}
function nextPacket(tracer, file, report, ranked, selected, snapshot, scenarioId) {
  const prefix = ['tracer', '--root', tracer.root, '--map', tracer.map,
    ...[...tracer.extensions].filter(extension => !SOURCE_EXTENSIONS.includes(extension)).sort().flatMap(extension => ['--include-ext', extension])];
  const command = (...args) => [...prefix, ...args], audit = offset => ({ offset, argv: command('proposal', 'audit', '--file', file, '--offset', String(offset), '--limit', '1', '--json') });
  const witnesses = [], witnessIds = new Map();
  const tasks = selected.map(({ scenario, potentialGapLines, entries, deficits }) => {
    const ranges = [];
    for (const { row, index } of entries) {
      const counts = deficits.get(row.source.path); let first;
      for (let line = row.source.start; line <= row.source.end + 1; line++) {
        const gap = line <= row.source.end && counts[line] > counts[line - 1];
        if (gap && first === undefined) first = line;
        if (!gap && first !== undefined) { ranges.push({ row, index, start: first, end: line - 1 }); first = undefined; }
      }
    }
    ranges.sort((a, b) => a.row.source.path < b.row.source.path ? -1 : a.row.source.path > b.row.source.path ? 1 : a.start - b.start);
    const sources = ranges.slice(0, 8).map(({ row, index, start, end }) => {
      const lines = snapshot.state.files.get(row.source.path);
      return { path: row.source.path, start, end, sha256: hash(lines.slice(start - 1, end).join('')), fileSha256: row.source.fileSha256,
        associationId: row.rangeId, audit: audit(index), snippet: excerpt(lines, start, end) };
    });
    const paths = new Set(entries.map(entry => entry.row.source.path)), candidates = new Map();
    for (const source of report.files) if (paths.has(source.path)) for (const link of source.links) if (link.step) {
      const key = JSON.stringify([link.source, link.actions, link.step]);
      if (!candidates.has(key)) candidates.set(key, link);
    }
    const reusable = [...candidates].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, link]) => link);
    const reuse = reusable.slice(0, 5).map(link => {
      const key = JSON.stringify(link.step); let witnessId = witnessIds.get(key);
      if (!witnessId) {
        witnessId = `witness-${witnesses.length + 1}`; witnessIds.set(key, witnessId);
        const lines = snapshot.witness(link.step);
        witnesses.push({ id: witnessId, ...link.step, fileSha256: hash(lines.join('')), snippet: excerpt(lines, link.step.start, link.step.end) });
      }
      return { id: link.id, source: link.source, actions: preview(link.actions), witnessId, why: link.why.slice(0, 512), whyTruncated: link.why.length > 512,
        inspect: { argv: command('report', '--step', `${link.step.path}:${link.step.start}-${link.step.end}`, '--json') } };
    });
    return { scenarioId: scenario.id, title: scenario.title.slice(0, 256), titleTruncated: scenario.title.length > 256, state: scenario.state, featureId: scenario.featureId,
      potentialGapLines, plan: { actions: preview(scenario.plannedActions), outcomes: preview(scenario.expectedOutcomes), existingPaths: preview(scenario.existingPaths), fullContract: audit(entries[0].index) },
      sources: { items: sources, total: ranges.length, truncated: ranges.length > sources.length,
        continuation: ranges.length > sources.length ? { auditOffset: ranges[sources.length].index, argv: audit(ranges[sources.length].index).argv } : null },
      reuse: { items: reuse, total: reusable.length, truncated: reusable.length > reuse.length,
        continuation: reusable.length > reuse.length ? { argv: command('report', '--source', reusable[reuse.length].source.path, '--json') } : null } };
  });
  const { invalidLinks, invalidComments, invalidDeadCode, ignoredSources, ignoredTotals, excluded } = ranked.diagnostics;
  const status = !ranked.valid ? 'integrity-issues' : !report.totals.lines ? 'empty-scope' : !ranked.selection.gapLines ? 'no-witness-gaps'
    : tasks.length ? 'ready' : scenarioId ? 'no-target-for-selection' : 'no-current-proposal-targets';
  const output = { kind: 'agent-work-packet', status, valid: ranked.valid,
    notice: 'These are unreviewed potential gap targets, not closed deficits, distinct new traces or observed execution. Review source and assertions, run real supported journeys, then integrate reviewed links explicitly.',
    reuseNotice: 'Existing witness candidates only; the same source file does not establish compatible assertions or execution.',
    snapshot: { proposal: { path: file, sha256: ranked.progress.proposed.proposalSha256 }, map: { path: tracer.map, sha256: report.mapSha256 },
      lineBasis: report.lineBasis, minimumTraces: report.minimumTraces, denominator: report.totals.lines, gapLines: ranked.selection.gapLines, unproposedGapLines: ranked.selection.unproposedGapLines },
    progress: { reviewed: ranked.progress.reviewed, executed: ranked.progress.executed },
    scope: { ignoredSources, ignoredTotals, excludedFileCount: excluded.length },
    diagnostics: { proposalIssues: ranked.progress.proposed.issues, invalidLinks, invalidComments, invalidDeadCode }, tasks, witnesses,
    commands: { discover: { argv: command('actions'), required: 'Review tracer.json before executing its configured discovery argv.' },
      run: { argvPrefix: command('app', '--'), required: 'Append exact advertised test argv from application discovery. A proposal action or test file path does not establish a test selector.' },
      integrate: { argvTemplate: command('scenario', 'link', '--file', '<reviewed-catalog>', '--reviewed', '--expect-catalog-sha256', '<catalog-sha256>', '--expect-map-sha256', report.mapSha256),
        required: 'Author or extend a meaningful assertion-bearing catalog; review it, then use scenario report --file CATALOG --json for current catalog/map hashes. Never infer review or passes from this packet.' },
      check: { argv: command('check', '--json') }, next: { argv: command('next', '--file', file) } } };
  if (Buffer.byteLength(JSON.stringify(output, null, 2)) + 1 > MAX_EXPANDED_BYTES) fail('Expanded next packet exceeds 64 MiB; repair global diagnostics or select a smaller limit.');
  return output;
}
