import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Tracer, safePath, parseRange, validateActions, compactRanges } from './tracer.mjs';

export const MEASURED_PATH = 'docs/testing/code-e2e-measurements.json';
export const MEASURED_NOTICE = 'LCOV COUNTER DELTAS: observed during the whole recorded interval, not caused by each action. Supplied provenance is not a build attestation or proof of correctness. Manual links and their minimums are separate.';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = value => typeof value === 'string' && value.trim() && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const fixedLimitations = [
  'Background activity, transport and snapshot work may overlap the interval.',
  'Snapshots may not be globally atomic; nonnegative deltas alone cannot prove consistency.',
  'Only supplied instrumented line records are represented; absent lines are unknown.',
  'A counter increase does not establish test assertions, branch coverage or causal attribution.',
  'Only DA line counters are used; function, branch, LF and LH exporter summaries are not denominators.',
];
function keys(value, allowed, label) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`Invalid or unknown ${label} fields.`);
}
function readInput(path) {
  if (!text(path)) fail('Provide an input file path.');
  const absolute = resolve(path), info = lstatSync(absolute);
  if (!info.isFile() || realpathSync(absolute) !== absolute || info.size > 64 * 1024 * 1024) fail('Inputs must be regular unsymlinked files no larger than 64 MiB.');
  const bytes = readFileSync(absolute);
  const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (content.includes('\0')) fail('Inputs must be UTF-8 text without NUL bytes.');
  return { bytes, content, sha256: sha(bytes) };
}
function validateManifest(value) {
  keys(value, ['version', 'runId', 'actions', 'counterMode', 'counterReset', 'before', 'after', 'sourceManifestSha256', 'probeSha256', 'tools', 'limitations'], 'measurement manifest');
  if (value.version !== 1 || !text(value.runId) || value.runId.length > 200 || value.counterMode !== 'cumulative' || value.counterReset !== false) fail('Require manifest version 1, a runId, cumulative counters and counterReset: false.');
  validateActions(value.actions);
  if (!hex(value.sourceManifestSha256) || !hex(value.probeSha256)) fail('Require pinned source-manifest and probe SHA256 identities.');
  if (!Array.isArray(value.tools) || !value.tools.length) fail('Require capture/export tool identities.');
  const names = new Set();
  for (const tool of value.tools) {
    keys(tool, ['name', 'version', 'sha256', 'hashTiming'], 'tool');
    if (!text(tool.name) || !text(tool.version) || !((hex(tool.sha256) && ['capture', 'after-export'].includes(tool.hashTiming)) || (tool.sha256 === null && tool.hashTiming === 'unavailable')) || names.has(tool.name)) fail('Require unique tool names/versions and explicit SHA256 timing, or null hash with unavailable timing.');
    names.add(tool.name);
  }
  if (!Array.isArray(value.limitations) || value.limitations.some(item => !text(item))) fail('limitations must be an array of single-line strings.');
  for (const phase of ['before', 'after']) {
    const snapshot = value[phase];
    keys(snapshot, ['sha256', 'runId', 'buildSha256', 'sourceManifestSha256', 'toolchainSha256'], `${phase} snapshot`);
    if (!hex(snapshot.sha256) || !hex(snapshot.buildSha256) || !hex(snapshot.toolchainSha256)
      || snapshot.runId !== value.runId || snapshot.sourceManifestSha256 !== value.sourceManifestSha256) fail('Snapshot run/build/source/tool identities must be explicit and compatible.');
    if (snapshot.toolchainSha256 !== sha(JSON.stringify(value.tools))) fail('Snapshot toolchainSha256 must hash the exact JSON tools array.');
  }
  if (value.before.buildSha256 !== value.after.buildSha256 || value.before.toolchainSha256 !== value.after.toolchainSha256) fail('Before and after build/tool identities differ.');
  return value;
}
function validatePrefix(prefix) {
  if (prefix === undefined) return '';
  if (!text(prefix) || !prefix.endsWith('/') || prefix.includes('\\') || prefix.split('/').some(part => part === '.' || part === '..')) fail('--strip-prefix must be an exact path prefix ending in /, without traversal.');
  return prefix;
}
function lcov(content, prefix) {
  const files = new Map();
  let record, records = 0, scope = '', pendingScope = false;
  for (const raw of content.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line) continue;
    if (line.startsWith('TN:')) {
      if (record || pendingScope || /[\x00-\x1f\x7f]/.test(line.slice(3))) fail('Duplicate or misplaced LCOV TN scope.');
      scope = line.slice(3); pendingScope = true; continue;
    }
    if (line.startsWith('SF:')) {
      if (record) fail('LCOV source record is missing end_of_record.');
      const original = line.slice(3);
      if (prefix && !original.startsWith(prefix)) fail('LCOV SF path does not match the explicit prefix.');
      const path = safePath(prefix ? original.slice(prefix.length) : original);
      if (path.split('/').includes('.git') || path === MEASURED_PATH || files.has(path)) fail(`Duplicate or unsafe LCOV source path: ${path}`);
      record = { path, rows: new Map(), scope, version: null }; files.set(path, record); pendingScope = false;
    } else if (line.startsWith('VER:')) {
      if (!record || record.version !== null || record.rows.size || !text(line.slice(4))) fail('Duplicate or misplaced LCOV VER source version.');
      record.version = line.slice(4);
    } else if (line.startsWith('DA:')) {
      if (!record) fail('LCOV DA appears outside a source record.');
      const match = /^DA:([1-9]\d*),(0|[1-9]\d*)(?:,([^,\s]+))?$/.exec(line);
      if (!match) fail('Malformed LCOV DA record.');
      const number = Number(match[1]), count = Number(match[2]);
      if (!Number.isSafeInteger(number) || !integer(count) || record.rows.has(number)) fail('Duplicate or unsafe LCOV line/count.');
      if (++records > 500000) fail('LCOV exceeds the 500,000 line-record limit.');
      record.rows.set(number, { count, checksum: match[3] ?? null });
    } else if (line === 'end_of_record') {
      if (!record || !record.rows.size) fail('Empty or unmatched LCOV source record.');
      record = undefined;
    } else if (!record || !/^(?:FN|FNDA|FNF|FNH|BRDA|BRF|BRH|LF|LH):/.test(line)) {
      fail('Unsupported or malformed LCOV record. Only line counters are imported.');
    }
  }
  if (record || pendingScope || !files.size) fail('LCOV must contain complete nonempty source records.');
  return files;
}
class MeasuredStore extends Tracer {
  constructor(root) { super({ root, map: MEASURED_PATH }); }
  serializeMap(data) {
    const serialized = `${JSON.stringify(data)}\n`;
    if (Buffer.byteLength(serialized) > 64 * 1024 * 1024) fail('Measurement dataset exceeds 64 MiB.');
    return serialized;
  }
  readMap({ withHash = false } = {}) {
    this.validateMapPath();
    if (!existsSync(this.mapPath)) return { version: 1, kind: 'lcov-intervals', intervals: [] };
    const file = readInput(this.mapPath), data = JSON.parse(file.content);
    keys(data, ['version', 'kind', 'intervals'], 'measurement dataset');
    if (data.version !== 1 || data.kind !== 'lcov-intervals' || !Array.isArray(data.intervals)) fail('Expected measurement dataset version 1.');
    const ids = new Set(), occurrences = new Set();
    for (const interval of data.intervals) {
      validateInterval(interval);
      const occurrence = intervalId(interval);
      if (ids.has(interval.id) || occurrences.has(occurrence)) fail('Duplicate measured interval identity.');
      ids.add(interval.id); occurrences.add(occurrence);
    }
    return withHash ? { data, datasetSha256: file.sha256 } : data;
  }
}
function captureContentId(value) {
  return sha(JSON.stringify([value.manifest.before.sha256, value.manifest.after.sha256,
    value.manifest.before.buildSha256]));
}
function intervalId(value) {
  return sha(JSON.stringify([captureContentId(value), value.manifest.runId]));
}
function validateInterval(value) {
  keys(value, ['id', 'manifest', 'manifestSha256', 'stripPrefix', 'files', 'payloadSha256'], 'interval');
  validateManifest(value.manifest); validatePrefix(value.stripPrefix || undefined);
  // Legacy version-1 records used only capture content identity. Preserve them unchanged.
  if (!hex(value.manifestSha256) || ![intervalId(value), captureContentId(value)].includes(value.id) || !Array.isArray(value.files) || !value.files.length) fail('Invalid interval identity or files.');
  const paths = new Set();
  for (const file of value.files) {
    keys(file, ['path', 'sha256', 'rows'], 'measured source'); safePath(file.path);
    if (file.path.split('/').includes('.git') || file.path === MEASURED_PATH || paths.has(file.path) || !hex(file.sha256) || !Array.isArray(file.rows) || !file.rows.length) fail('Invalid or duplicate measured source.');
    paths.add(file.path);
    let previous = 0;
    for (const row of file.rows) {
      if (!Array.isArray(row) || row.length !== 3 || !integer(row[0]) || row[0] <= previous || !integer(row[1]) || !integer(row[2]) || row[2] < row[1]) fail('Invalid measured counters; lines must be sorted and deltas nonnegative.');
      previous = row[0];
    }
  }
  const { payloadSha256, ...payload } = value;
  if (payloadSha256 !== sha(JSON.stringify(payload))) fail('Measured payload digest mismatch. This is integrity checking, not a signature.');
}
function currentFile(store, file) {
  try {
    const lines = store.readLines(file.path);
    if (sha(lines.join('')) !== file.sha256) return 'Source bytes are stale against the pinned capture manifest.';
    if (file.rows.at(-1)[0] > lines.length) return 'Instrumented line is outside the source file.';
  } catch (error) { return error.message; }
  return null;
}
export function importMeasured(root, { before, after, manifest, sources, stripPrefix, allowStale = false }) {
  const store = new MeasuredStore(root), prefix = validatePrefix(stripPrefix);
  const inputManifest = readInput(manifest), metadata = validateManifest(JSON.parse(inputManifest.content));
  const inputSources = readInput(sources), sourceData = JSON.parse(inputSources.content);
  if (inputSources.sha256 !== metadata.sourceManifestSha256 || !object(sourceData) || !Array.isArray(sourceData.files)) fail('Pinned source manifest hash or files array mismatch.');
  const hashes = new Map();
  for (const file of sourceData.files) {
    if (!object(file)) fail('Invalid pinned source entry.');
    safePath(file.path);
    if (!hex(file.sha256) || hashes.has(file.path)) fail('Invalid or duplicate pinned source hash.');
    hashes.set(file.path, file.sha256);
  }
  const inputBefore = readInput(before), inputAfter = readInput(after);
  if (inputBefore.sha256 !== metadata.before.sha256 || inputAfter.sha256 !== metadata.after.sha256) fail('LCOV input SHA256 mismatch.');
  const a = lcov(inputBefore.content, prefix), b = lcov(inputAfter.content, prefix);
  if (a.size !== b.size || [...a.keys()].some(path => !b.has(path))) fail('Before and after LCOV file sets differ.');
  const files = [];
  for (const path of [...a.keys()].sort()) {
    const beforeFile = a.get(path), afterFile = b.get(path);
    if (beforeFile.scope !== afterFile.scope || beforeFile.version !== afterFile.version) fail(`Before and after LCOV TN/VER identities differ: ${path}`);
    const x = beforeFile.rows, y = afterFile.rows;
    if (!hashes.has(path)) fail(`No capture-time source hash for ${path}.`);
    if (x.size !== y.size || [...x.keys()].some(line => !y.has(line))) fail(`Before and after instrumented line sets differ: ${path}`);
    const rows = [...x.keys()].sort((a, b) => a - b).map(line => {
      if (x.get(line).checksum !== y.get(line).checksum) fail(`LCOV checksum differs: ${path}:${line}`);
      if (y.get(line).count < x.get(line).count) fail(`Negative delta or counter reset: ${path}:${line}`);
      return [line, x.get(line).count, y.get(line).count];
    });
    const file = { path, sha256: hashes.get(path), rows }, error = currentFile(store, file);
    if (error && !(allowStale && error.startsWith('Source bytes are stale'))) fail(`${path}: ${error}`);
    files.push(file);
  }
  const candidate = { manifest: metadata, manifestSha256: inputManifest.sha256, stripPrefix: prefix, files };
  const payload = { id: intervalId(candidate), ...candidate };
  const interval = { ...payload, payloadSha256: sha(JSON.stringify(payload)) };
  validateInterval(interval);
  return store.mutate(data => {
    const existing = data.intervals.find(item => intervalId(item) === interval.id);
    if (existing) {
      // Compare the exact payload under its stored ID, including legacy IDs, without rewriting it.
      const existingIdPayload = { ...payload, id: existing.id };
      if (existing.payloadSha256 !== sha(JSON.stringify(existingIdPayload))) fail('This LCOV pair already exists in this run with conflicting provenance or labels. Never relabel captured evidence silently.');
      return { changed: false, id: existing.id, notice: MEASURED_NOTICE };
    }
    data.intervals.push(interval);
    return { changed: true, id: interval.id, notice: MEASURED_NOTICE };
  });
}
export function reportMeasured(root, query) {
  const store = new MeasuredStore(root), data = store.readMap();
  let range;
  if (query?.kind === 'source') range = parseRange(query.value, false);
  else if (query?.kind === 'sequence') validateActions(query.value);
  else if (query?.kind === 'action' && !text(query.value)) fail('Action must be a nonempty single-line description.');
  const intervals = [];
  for (const interval of data.intervals) {
    if (query?.kind === 'action' && !interval.manifest.actions.includes(query.value)) continue;
    if (query?.kind === 'sequence' && JSON.stringify(interval.manifest.actions) !== JSON.stringify(query.value)) continue;
    const files = [];
    for (const file of interval.files) {
      if (range && file.path !== range.path) continue;
      const rows = file.rows.filter(row => !range?.start || row[0] >= range.start && row[0] <= range.end);
      if (!rows.length) continue;
      const error = currentFile(store, file), increased = rows.filter(row => row[2] > row[1]).map(row => row[0]);
      files.push({ path: file.path, sourceSha256: file.sha256, status: error ? 'stale' : 'current', ...(error ? { error } : {}),
        instrumentedLines: rows.length, observedLines: error ? 0 : increased.length,
        observedRanges: error ? [] : compactRanges(increased),
        unincreasedRanges: error ? [] : compactRanges(rows.filter(row => row[2] === row[1]).map(row => row[0])),
        historicalIncreasedRanges: compactRanges(increased),
        counters: rows.map(([line, before, after]) => ({ line, before, after, delta: after - before })),
      });
    }
    if (range && !files.length) continue;
    intervals.push({ id: interval.id, manifest: interval.manifest, manifestSha256: interval.manifestSha256,
      files, totals: { files: files.length, staleFiles: files.filter(file => file.status === 'stale').length,
        instrumentedLines: files.reduce((sum, file) => sum + file.instrumentedLines, 0),
        currentInstrumentedLines: files.filter(file => file.status === 'current').reduce((sum, file) => sum + file.instrumentedLines, 0),
        historicalIncreasedLines: files.reduce((sum, file) => sum + file.counters.filter(row => row.delta > 0).length, 0),
        observedLines: files.reduce((sum, file) => sum + file.observedLines, 0) } });
  }
  return { kind: 'lcov-intervals', notice: MEASURED_NOTICE, limitations: fixedLimitations, intervals };
}
export function checkMeasured(root) {
  const result = reportMeasured(root);
  return { kind: result.kind, notice: result.notice, intervals: result.intervals.length,
    invalid: result.intervals.flatMap(interval => interval.files.filter(file => file.status !== 'current').map(file => ({ id: interval.id, path: file.path, error: file.error }))) };
}


export function unionMeasured(root, { inputRoots, outcomes, scopeMode = 'strict' } = {}) {
  if (!['strict', 'source-lines'].includes(scopeMode)) fail('Union --scope must be strict or source-lines.');
  if (!Array.isArray(inputRoots) || !inputRoots.length || inputRoots.length > 256 || inputRoots.some(path => !text(path))) fail('measure union requires 1-256 --input-root paths.');
  const origins = [], records = new Map(), storedIds = new Map(), provenance = new Map();
  let scope, scopeId, sourceLinesId, duplicates = 0;
  for (const inputRoot of inputRoots) {
    const store = new MeasuredStore(resolve(root, inputRoot));
    if (!existsSync(store.mapPath)) fail('Union input measurement dataset is missing.');
    const { data, datasetSha256 } = store.readMap({ withHash: true });
    const origin = { root: store.root, dataset: store.mapPath, sha256: datasetSha256, intervals: data.intervals.length };
    origins.push(origin);
    const checked = new Map();
    for (const interval of data.intervals) {
      for (const file of interval.files) {
        const key = JSON.stringify([file.path, file.sha256, file.rows.at(-1)[0]]);
        if (!checked.has(key)) checked.set(key, currentFile(store, file));
        if (checked.get(key)) fail(`Union input ${interval.id}: ${checked.get(key)}`);
      }
      const occurrence = intervalId(interval), { id, payloadSha256, ...content } = interval;
      const digest = sha(JSON.stringify(content)), previous = records.get(occurrence);
      if (storedIds.has(id) && storedIds.get(id) !== occurrence) fail(`Conflicting duplicate interval: ${id}`);
      storedIds.set(id, occurrence);
      if (previous) {
        if (previous.digest !== digest) fail(`Conflicting duplicate interval: ${id}`);
        if (!previous.aliases.includes(id)) previous.aliases.push(id);
        previous.origins.push(origins.length - 1); duplicates++; continue;
      }
      if (records.size === 10000) fail('Measurement union exceeds 10000 unique intervals.');
      const currentScope = { sourceManifestSha256: interval.manifest.sourceManifestSha256, probeSha256: interval.manifest.probeSha256,
        buildSha256: interval.manifest.before.buildSha256, toolchainSha256: interval.manifest.before.toolchainSha256,
        files: interval.files.map(file => ({ path: file.path, sha256: file.sha256, lines: file.rows.map(row => row[0]) }))
          .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
      const currentScopeId = sha(JSON.stringify(currentScope)), currentSourceLinesId = sha(JSON.stringify(currentScope.files));
      if (scope && (scopeMode === 'strict' ? scopeId !== currentScopeId : sourceLinesId !== currentSourceLinesId)) {
        fail(`Incompatible measurement scope: ${scopeMode === 'strict' ? scopeId : sourceLinesId} versus ${scopeMode === 'strict' ? currentScopeId : currentSourceLinesId}. Report these scopes separately.`);
      }
      if (!scope) { scope = currentScope; scopeId = currentScopeId; sourceLinesId = currentSourceLinesId; }
      if (!provenance.has(currentScopeId)) {
        const { files, ...identities } = currentScope;
        provenance.set(currentScopeId, { id: currentScopeId, ...identities, intervalIds: [], origins: new Set() });
      }
      provenance.get(currentScopeId).intervalIds.push(occurrence);
      const observed = new Set();
      for (const file of interval.files) for (const [line, before, after] of file.rows) if (after > before) observed.add(`${file.path}\0${line}`);
      records.set(occurrence, { id: occurrence, aliases: [id], digest, observed, provenanceId: currentScopeId, origins: [origins.length - 1] });
    }
  }
  if (!scope) fail('measure union requires at least one measured interval.');
  const declarations = new Map(), outcomeBindings = [], declaredIds = new Set();
  let outcomeProvenance = null;
  if (outcomes !== undefined) {
    const path = resolve(root, outcomes), input = readInput(path), data = JSON.parse(input.content);
    keys(data, ['version', 'intervals'], 'union outcomes');
    if (data.version !== 1 || !Array.isArray(data.intervals) || data.intervals.length > 10000) fail('Require outcomes version 1 and at most 10000 interval declarations.');
    const evidenceFiles = new Map();
    for (const row of data.intervals) {
      keys(row, ['id', 'journey', 'status', 'evidence'], 'interval outcome');
      keys(row.evidence, ['path', 'sha256'], 'outcome evidence');
      if (!hex(row.id) || (!storedIds.has(row.id) && !records.has(row.id)) || declaredIds.has(row.id) || !text(row.journey) || row.journey.length > 4096
          || !['passed', 'failed'].includes(row.status) || !text(row.evidence.path) || !hex(row.evidence.sha256)) fail('Invalid, unknown or duplicate interval outcome declaration.');
      const evidencePath = resolve(dirname(path), row.evidence.path);
      if (!evidenceFiles.has(evidencePath)) evidenceFiles.set(evidencePath, readInput(evidencePath).sha256);
      if (evidenceFiles.get(evidencePath) !== row.evidence.sha256) fail('Outcome evidence digest mismatch.');
      const canonicalId = storedIds.get(row.id) ?? row.id, previous = declarations.get(canonicalId);
      if (previous && (previous.journey !== row.journey || previous.status !== row.status)) fail('Conflicting outcome declarations for interval aliases.');
      const declaration = { journey: row.journey, status: row.status, evidence: { path: evidencePath, sha256: row.evidence.sha256 } };
      declaredIds.add(row.id); declarations.set(canonicalId, declaration);
      outcomeBindings.push({ id: row.id, canonicalId, ...declaration });
    }
    outcomeProvenance = { path, sha256: input.sha256 };
  }
  const all = new Set(), passed = new Set(), journeys = new Map(), outcomeCounts = { passed: 0, failed: 0, unknown: 0 };
  for (const record of records.values()) {
    for (const origin of record.origins) provenance.get(record.provenanceId).origins.add(origin);
    const declaration = declarations.get(record.id), status = declaration?.status ?? 'unknown';
    const journey = declaration?.journey ?? `interval:${record.id}`;
    outcomeCounts[status]++;
    if (!journeys.has(journey)) journeys.set(journey, { journey, intervalIds: [], outcomes: { passed: 0, failed: 0, unknown: 0 }, all: new Set(), passed: new Set() });
    const group = journeys.get(journey); group.intervalIds.push(record.id); group.outcomes[status]++;
    for (const line of record.observed) {
      all.add(line); group.all.add(line);
      if (status === 'passed') { passed.add(line); group.passed.add(line); }
    }
  }
  const instrumentedLines = scope.files.reduce((sum, file) => sum + file.lines.length, 0);
  const totals = observed => ({ files: scope.files.length, instrumentedLines, observedLines: observed.size,
    gapLines: instrumentedLines - observed.size, percent: observed.size / instrumentedLines * 100 });
  const ranges = (file, observed) => ({ observedLines: file.lines.filter(line => observed.has(`${file.path}\0${line}`)).length,
    observedRanges: compactRanges(file.lines.filter(line => observed.has(`${file.path}\0${line}`))),
    gapRanges: compactRanges(file.lines.filter(line => !observed.has(`${file.path}\0${line}`))) });
  const earlier = new Set(), earlierPassed = new Set();
  const marginal = (observed, previous) => {
    let count = 0;
    for (const line of observed) { if (!previous.has(line)) count++; previous.add(line); }
    return count;
  };
  return { kind: scopeMode === 'strict' ? 'lcov-compatible-interval-union' : 'lcov-cross-provenance-source-line-union', notice: MEASURED_NOTICE, limitations: [...fixedLimitations,
    'Passed-only results use explicitly supplied producer-declared outcomes with digest-bound evidence. Evidence meaning and assertions are not independently verified.',
    'Missing outcomes remain unknown and contribute only to the all-observed union.',
    'Source-lines mode unions observed presence across provenance groups with exact source bytes and instrumented line sets; it does not establish identical adapters or builds.',
    'Journey marginal novelty depends on first-encounter journey order, then combines that journey’s intervals. It is not per-action causality.'],
    scope: scopeMode === 'strict' ? { mode: scopeMode, id: scopeId, ...scope } : { mode: scopeMode, id: sourceLinesId, files: scope.files }, origins,
    provenanceGroups: [...provenance.values()].map(group => ({ ...group, origins: [...group.origins] })),
    intervals: { unique: records.size, duplicates, outcomes: outcomeCounts,
      aliases: [...records.values()].map(record => ({ id: record.id, storedIds: record.aliases })) },
    outcomes: { kind: 'producer-declared', provenance: outcomeProvenance,
      declarations: outcomeBindings },
    allObserved: totals(all), passedOnlyKnown: totals(passed),
    files: scope.files.map(file => ({ path: file.path, sourceSha256: file.sha256, instrumentedLines: file.lines.length,
      instrumentedRanges: compactRanges(file.lines), allObserved: ranges(file, all), passedOnlyKnown: ranges(file, passed) })),
    journeyOrder: 'First encounter in input-root order and stored interval order; unknown journeys use interval IDs.',
    journeys: [...journeys.values()].map(group => ({ journey: group.journey, intervalIds: group.intervalIds, outcomes: group.outcomes,
      allObserved: { observedLines: group.all.size, marginalLines: marginal(group.all, earlier) },
      passedOnlyKnown: { observedLines: group.passed.size, marginalLines: marginal(group.passed, earlierPassed) } })) };
}
