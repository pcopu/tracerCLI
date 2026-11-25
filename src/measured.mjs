import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
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
  keys(value, ['version', 'runId', 'actions', 'actionLabels', 'counterMode', 'counterReset', 'before', 'after', 'sourceManifestSha256', 'probeSha256', 'tools', 'limitations'], 'measurement manifest');
  if (value.version !== 1 || !text(value.runId) || value.runId.length > 200 || value.counterMode !== 'cumulative' || value.counterReset !== false) fail('Require manifest version 1, a runId, cumulative counters and counterReset: false.');
  validateActions(value.actions);
  if (Object.hasOwn(value, 'actionLabels')) {
    validateActions(value.actionLabels);
    if (new Set(value.actionLabels).size !== value.actionLabels.length) fail('Require unique action labels.');
  }
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
function hasAction(record, label) {
  return record.actions.includes(label) || record.actionLabels?.includes(label);
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
    if (query?.kind === 'action' && !hasAction(interval.manifest, query.value)) continue;
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


function readMeasurementManifest(path, manifests) {
  let manifest = manifests?.get(path);
  if (!manifest) {
    const input = readInput(path);
    manifest = { sha256: input.sha256, data: JSON.parse(input.content) };
    manifests?.set(path, manifest);
  }
  return manifest;
}

function measuredInputs(root, options, localDefault, manifests) {
  let { inputRoots, outcomes, scopeMode } = options;
  let captureSet = null;
  if (options.captureSet !== undefined) {
    if (inputRoots !== undefined || outcomes !== undefined || scopeMode !== undefined) fail('--capture-set cannot be combined with --input-root, --outcomes or --scope.');
    const path = resolve(root, options.captureSet), { sha256, data } = readMeasurementManifest(path, manifests);
    keys(data, ['version', 'inputRoots', 'outcomes', 'scope'], 'capture set');
    if (data.version !== 1 || !Array.isArray(data.inputRoots) || data.inputRoots.some(path => !text(path))
        || (data.outcomes !== undefined && !text(data.outcomes))) fail('Require capture set version 1, inputRoots and an optional outcomes path.');
    inputRoots = data.inputRoots.map(value => resolve(dirname(path), value));
    outcomes = data.outcomes === undefined ? undefined : resolve(dirname(path), data.outcomes);
    scopeMode = data.scope;
    captureSet = { path, sha256 };
  }
  inputRoots ??= localDefault ? [root] : undefined;
  scopeMode ??= 'strict';
  if (!['strict', 'source-lines'].includes(scopeMode)) fail('Union --scope must be strict or source-lines.');
  if (!Array.isArray(inputRoots) || !inputRoots.length || inputRoots.length > 256 || inputRoots.some(path => !text(path))) fail('Require 1-256 measurement input roots.');
  return { inputRoots, outcomes, scopeMode, captureSet };
}

function intervalIdentity(interval) {
  const { id, payloadSha256, ...content } = interval;
  return { occurrence: intervalId(interval), digest: sha(JSON.stringify(content)) };
}

function intervalScope(interval, scopes) {
  const scope = { sourceManifestSha256: interval.manifest.sourceManifestSha256, probeSha256: interval.manifest.probeSha256,
    buildSha256: interval.manifest.before.buildSha256, toolchainSha256: interval.manifest.before.toolchainSha256,
    files: interval.files.map(file => ({ path: file.path, sha256: file.sha256, lines: file.rows.map(row => row[0]) }))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
  const scopeId = sha(JSON.stringify(scope));
  const seen = scopes?.get(scopeId);
  if (seen) return seen;
  const result = { scope, scopeId, sourceLinesId: sha(JSON.stringify(scope.files)) };
  scopes?.set(scopeId, result);
  return result;
}

function loadMeasuredRecords(root, options, { lookupPath, referenceRoot, retainFiles = Boolean(referenceRoot), shared } = {}) {
  const { inputRoots, outcomes, scopeMode, captureSet } = measuredInputs(root, options, Boolean(lookupPath), shared?.manifests);
  if (referenceRoot) {
    const index = inputRoots.findIndex(path => realpathSync(resolve(root, path)) === referenceRoot);
    if (index < 0) fail('The reference root must be listed in the capture set.');
    inputRoots.unshift(...inputRoots.splice(index, 1));
  }
  const origins = [], records = new Map(), storedIds = new Map(), provenance = new Map();
  const snapshots = shared?.datasets ?? (retainFiles ? new Map() : undefined);
  let scope, scopeId, sourceLinesId, duplicates = 0;
  for (const inputRoot of inputRoots) {
    const path = resolve(root, inputRoot);
    const store = shared?.stores.get(path) ?? new MeasuredStore(path);
    shared?.stores.set(path, store);
    const isReference = store.root === referenceRoot;
    // A shared report keeps the first known dataset state for this root.
    const reused = snapshots?.get(store.root);
    if (!reused && (shared?.missingDatasets.has(store.root) || !existsSync(store.mapPath))) {
      if (isReference) fail('The reference measurement dataset is missing.');
      if (!lookupPath && !retainFiles) fail('Union input measurement dataset is missing.');
      shared?.missingDatasets.add(store.root);
      origins.push({ root: store.root, dataset: store.mapPath, sha256: null, intervals: 0, status: 'missing' }); continue;
    }
    if (!reused && shared?.maxDatasets !== undefined && snapshots.size === shared.maxDatasets) {
      fail(`Gap series exceeds ${shared.maxDatasets} distinct measurement input roots.`);
    }
    const snapshot = reused ?? { ...store.readMap({ withHash: true }), checked: new Map() };
    snapshots?.set(store.root, snapshot);
    const { data, datasetSha256, checked } = snapshot;
    if (isReference && !data.intervals.length) fail('The reference measurement dataset must contain at least one interval.');
    const origin = { root: store.root, dataset: store.mapPath, sha256: datasetSha256, intervals: data.intervals.length };
    origins.push(origin);
    const invalidFiles = retainFiles ? new Map() : undefined;
    for (const interval of data.intervals) {
      const lookupFile = lookupPath ? interval.files.find(file => file.path === lookupPath) : undefined;
      const validFiles = retainFiles ? new Set() : undefined;
      let snapshotError = null;
      for (const file of interval.files) {
        if (lookupPath && file.path !== lookupPath) continue;
        const key = JSON.stringify([file.path, file.sha256, file.rows.at(-1)[0]]);
        if (!checked.has(key)) checked.set(key, currentFile(store, file));
        if (checked.get(key)) {
          if (isReference) fail(`Reference interval ${interval.id}, ${file.path}: ${checked.get(key)}`);
          if (!lookupPath && !retainFiles) fail(`Union input ${interval.id}: ${checked.get(key)}`);
          invalidFiles?.set(key, { path: file.path, sourceSha256: file.sha256, error: checked.get(key) });
          snapshotError = checked.get(key);
        } else validFiles?.add(file.path);
      }
      const identity = shared?.intervals.get(interval) ?? intervalIdentity(interval);
      shared?.intervals.set(interval, identity);
      const { occurrence, digest } = identity, { id } = interval, previous = records.get(occurrence);
      if (storedIds.has(id) && storedIds.get(id) !== occurrence) fail(`Conflicting duplicate interval: ${id}`);
      storedIds.set(id, occurrence);
      if (previous) {
        if (previous.digest !== digest) fail(`Conflicting duplicate interval: ${id}`);
        if (!previous.aliases.includes(id)) previous.aliases.push(id);
        previous.origins.push(origins.length - 1);
        if (lookupFile && !snapshotError) previous.validOrigins.push(origins.length - 1);
        if (validFiles) for (const path of validFiles) previous.validFiles.add(path);
        duplicates++; continue;
      }
      if (records.size === 10000) fail('Measurement union exceeds 10000 unique intervals.');
      const { scope: currentScope, scopeId: currentScopeId, sourceLinesId: currentSourceLinesId } =
        (identity.scope ??= intervalScope(interval, shared?.scopes));
      if (isReference && scope && scopeId !== currentScopeId) fail('Incompatible strict measurement scope within the reference dataset.');
      if (!lookupPath && !retainFiles && scope && (scopeMode === 'strict' ? scopeId !== currentScopeId : sourceLinesId !== currentSourceLinesId)) {
        fail(`Incompatible measurement scope: ${scopeMode === 'strict' ? scopeId : sourceLinesId} versus ${scopeMode === 'strict' ? currentScopeId : currentSourceLinesId}. Report these scopes separately.`);
      }
      if (!scope) { scope = currentScope; scopeId = currentScopeId; sourceLinesId = currentSourceLinesId; }
      if (!provenance.has(currentScopeId)) {
        const { files, ...identities } = currentScope;
        provenance.set(currentScopeId, { id: currentScopeId, ...identities, intervalIds: [], origins: new Set(),
          ...(lookupPath ? { familyId: scopeMode === 'strict' ? currentScopeId : currentSourceLinesId, sourceFiles: currentScope.files } : {}) });
      }
      provenance.get(currentScopeId).intervalIds.push(occurrence);
      const observed = new Set();
      if (!retainFiles) {
        for (const file of interval.files.filter(file => !lookupPath || file.path === lookupPath)) for (const [line, before, after] of file.rows) if (after > before) observed.add(`${file.path}\0${line}`);
      }
      records.set(occurrence, { id: occurrence, aliases: [id], digest, observed, provenanceId: currentScopeId, origins: [origins.length - 1],
        ...(retainFiles ? { captureFiles: interval.files, validFiles, actions: interval.manifest.actions, actionLabels: interval.manifest.actionLabels } : {}),
        ...(lookupPath ? { lookupFile, snapshotError, actions: interval.manifest.actions, validOrigins: lookupFile && !snapshotError ? [origins.length - 1] : [] } : {}) });
    }
    if (invalidFiles?.size) origin.invalidSnapshotFiles = [...invalidFiles.values()];
  }
  if (!scope && !lookupPath) fail(retainFiles ? 'Comparison requires at least one measured baseline interval.' : 'measure union requires at least one measured interval.');
  const declarations = new Map(), outcomeBindings = [], declaredIds = new Set();
  let outcomeProvenance = null;
  if (outcomes !== undefined) {
    const path = resolve(root, outcomes), { sha256, data } = readMeasurementManifest(path, shared?.manifests);
    keys(data, ['version', 'intervals'], 'union outcomes');
    if (data.version !== 1 || !Array.isArray(data.intervals) || data.intervals.length > 10000) fail('Require outcomes version 1 and at most 10000 interval declarations.');
    const evidenceFiles = shared?.evidenceDigests ?? new Map();
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
    outcomeProvenance = { path, sha256 };
  }
  for (const record of records.values()) for (const origin of record.origins) provenance.get(record.provenanceId).origins.add(origin);
  return { origins, records, provenance, scope, scopeId, sourceLinesId, duplicates, declarations, outcomeBindings, outcomeProvenance, scopeMode, captureSet };
}

export function unionMeasured(root, options = {}) {
  const { origins, records, provenance, scope, scopeId, sourceLinesId, duplicates, declarations, outcomeBindings, outcomeProvenance, scopeMode, captureSet } = loadMeasuredRecords(root, options);
  const all = new Set(), passed = new Set(), journeys = new Map(), outcomeCounts = { passed: 0, failed: 0, unknown: 0 };
  for (const record of records.values()) {
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
    ...(captureSet ? { captureSet } : {}),
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


export function whereMeasured(root, { source, captureSet } = {}, shared) {
  const range = parseRange(source, false), store = new MeasuredStore(root), lines = store.readLines(range.path);
  const sourceSha256 = sha(lines.join('')), start = range.start ?? 1, end = range.end ?? lines.length;
  if (range.start && end > lines.length) fail('Requested source range is outside the current file.');
  const loaded = loadMeasuredRecords(root, { captureSet }, { lookupPath: range.path, shared });
  const observed = new Set(), instrumented = new Set(), passed = new Set(), hits = [], historical = [], families = new Map(), journeys = new Map();
  const sorted = values => [...values].sort((a, b) => a - b);
  for (const group of loaded.provenance.values()) {
    const file = group.sourceFiles.find(file => file.path === range.path);
    if (!file) continue;
    if (!families.has(group.familyId)) families.set(group.familyId, { id: group.familyId, mode: loaded.scopeMode,
      sourceUniverseSha256: sha(JSON.stringify(group.sourceFiles)), scopeFiles: group.sourceFiles.length,
      source: { path: file.path, sha256: file.sha256, instrumentedRanges: compactRanges(file.lines) }, provenanceGroups: [] });
    const { familyId, sourceFiles, origins, intervalIds, ...identities } = group;
    families.get(familyId).provenanceGroups.push({ ...identities, intervalCount: intervalIds.length, origins: [...origins] });
  }
  for (const record of loaded.records.values()) {
    const file = record.lookupFile;
    if (!file) continue;
    const declaration = loaded.declarations.get(record.id), outcome = declaration?.status ?? 'unknown';
    const relevant = file.rows.filter(row => row[0] >= start && row[0] <= end);
    const increased = relevant.filter(row => row[2] > row[1]).map(row => row[0]);
    const base = { id: record.id, aliases: record.aliases, journey: declaration?.journey ?? null, outcome,
      provenanceId: record.provenanceId, origins: record.origins };
    if (!record.validOrigins.length || file.sha256 !== sourceSha256) {
      if (!relevant.length) continue;
      historical.push({ ...base, coordinateSpace: 'captured-source', sourceSha256: file.sha256, reason: !record.validOrigins.length ? 'Snapshot source is stale or unavailable.' : 'Current source bytes differ from the captured source.',
        observedRanges: compactRanges(increased), instrumentedRanges: compactRanges(relevant.map(row => row[0])) });
      continue;
    }
    for (const [line] of relevant) instrumented.add(line);
    const overlap = relevant.filter(row => row[2] > row[1]).map(row => row[0]);
    for (const line of overlap) { observed.add(line); if (outcome === 'passed') passed.add(line); }
    if (overlap.length) {
      hits.push({ ...base, actions: record.actions, observedRanges: compactRanges(overlap), validatedOrigins: record.validOrigins });
      const key = JSON.stringify([base.journey, outcome]);
      if (!journeys.has(key)) journeys.set(key, { journey: base.journey, outcome, intervals: 0, lines: new Set() });
      const journey = journeys.get(key); journey.intervals++;
      for (const line of overlap) journey.lines.add(line);
    }
  }
  const instrumentedLines = sorted(instrumented), unknownRanges = missingRanges(instrumentedLines, start, end);
  if (sha(store.readLines(range.path).join('')) !== sourceSha256) fail('Requested source changed during measurement lookup.');
  const returnedIds = new Set(hits.concat(historical).map(record => record.id));
  return { kind: 'measured-source-lookup', notice: MEASURED_NOTICE,
    validationScope: 'Dataset payloads and requested snapshot source files are checked. Current credit additionally requires the exact current requested file hash. Other snapshot files are outside this lookup.',
    aggregation: 'Current physical-source-line presence across the listed independent families. No combined build coverage percentage or assertion proof.',
    status: observed.size ? 'observed' : instrumented.size ? 'unobserved' : 'unknown',
    source: { path: range.path, start, end, sha256: sourceSha256, physicalLines: lines.length }, captureSet: loaded.captureSet,
    observedRanges: compactRanges(sorted(observed)), unobservedInstrumentedRanges: compactRanges(instrumentedLines.filter(line => !observed.has(line))), unknownRanges,
    passedOnlyKnown: { observedRanges: compactRanges(sorted(passed)) },
    hits, historical, families: [...families.values()], origins: loaded.origins,
    journeys: [...journeys.values()].map(({ lines, ...journey }) => ({ ...journey, observedRanges: compactRanges(sorted(lines)) })),
    outcomes: { kind: 'producer-declared', provenance: loaded.outcomeProvenance,
      declarations: loaded.outcomeBindings.filter(row => returnedIds.has(row.canonicalId)) },
    intervals: { unique: loaded.records.size, duplicates: loaded.duplicates, matchingSource: [...loaded.records.values()].filter(record => record.lookupFile).length } };
}

export function whereMeasuredBatch(root, { sources, captureSet }) {
  if (sources.length < 2 || sources.length > 32) fail('Batched source lookup requires 2-32 --source selectors.');
  const shared = measurementSnapshot();
  const reports = sources.map(source => whereMeasured(root, { source, captureSet }, shared));
  const store = new MeasuredStore(root);
  for (const { source } of reports) {
    if (sha(store.readLines(source.path).join('')) !== source.sha256) fail('Requested source changed during measurement lookup.');
  }
  return { kind: 'measured-source-lookup-batch', notice: MEASURED_NOTICE, reports };
}

function missingRanges(lines, start, end) {
  const result = [];
  let next = start;
  for (const line of lines) { if (next < line) result.push([next, line - 1]); next = line + 1; }
  if (next <= end) result.push([next, end]);
  return result;
}

function currentSource(store, path) {
  try {
    const lines = store.readLines(path);
    return { sha256: sha(lines.join('')), physicalLines: lines.length };
  } catch {
    return { sha256: null, physicalLines: null };
  }
}

function measurementSnapshot(maxDatasets) {
  // Independent reports share validated inputs only within one command.
  return { maxDatasets, stores: new Map(), datasets: new Map(), manifests: new Map(),
    missingDatasets: new Set(), intervals: new WeakMap(), scopes: new Map(), evidenceDigests: new Map() };
}

function readReferenceFunctions(root, file, scope, referenceRoot) {
  const { content, sha256 } = readInput(resolve(root, file));
  const map = JSON.parse(content);
  keys(map, ['version', 'kind', 'buildSha256', 'sourceManifestSha256', 'files'], 'function map');
  if (map.version !== 1 || map.kind !== 'llvm-function-map' || !Array.isArray(map.files) || !map.files.length
      || map.files.length > scope.files.length) fail('Invalid version-1 function map.');
  if (scope.buildSha256 !== map.buildSha256 || scope.sourceManifestSha256 !== map.sourceManifestSha256) {
    fail('The function map does not match the reference build and source manifest.');
  }
  const reference = new Map(scope.files.map(file => [file.path, file.sha256]));
  const store = new MeasuredStore(referenceRoot), files = new Map();
  let count = 0;
  for (const row of map.files) {
    keys(row, ['path', 'sha256', 'ranges'], 'function map file');
    if (!hex(row.sha256) || reference.get(row.path) !== row.sha256 || files.has(row.path)) fail('Invalid function map source identity.');
    if (!Array.isArray(row.ranges) || !row.ranges.length) fail('Invalid function map ranges.');
    const lastLine = store.readLines(row.path).length;
    for (const range of row.ranges) {
      if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger)
          || range[0] < 1 || range[0] > range[1] || range[1] > lastLine) fail('Invalid function map range.');
    }
    count += row.ranges.length;
    if (count > 200000) fail('The function map exceeds 200000 ranges.');
    files.set(row.path, row.ranges.sort(([a, b], [c, d]) => a - c || d - b));
  }
  return { sha256, files };
}

function crossesFunction(ranges, left, right) {
  const covers = (line, [start, end]) => start <= line && line <= end;
  return ranges && ranges.some(range => covers(left, range)) && ranges.some(range => covers(right, range))
    && !ranges.some(([start, end]) => start <= left && right <= end);
}

// A terminal block has no second anchor inside its function. Use only the
// immediate surviving anchor in the smallest compiler range for that block.
function collectFunctionEdges({ path, lines, first, last, ranges, passing, ownerAt, edges }) {
  if (!ranges?.length) return;
  for (let start = first; start <= last;) {
    const owner = ownerAt(start);
    let end = start;
    while (end < last && ownerAt(end + 1) === owner) end++;
    const left = start - 1, right = end + 1;
    if (owner) {
      const before = ownerAt(left) === owner, after = ownerAt(right) === owner;
      if (before !== after) {
        const anchor = before ? left : right;
        const range = [lines[start], lines[end]];
        const matched = new Set(), startupMatched = new Set(), exactMatched = new Set();
        for (const { journey, intervalId, rows, startup, actionIds, matchesAction } of passing) {
          if (rows[anchor][2] <= rows[anchor][1]) continue;
          const example = { path, range, functionRange: owner, observedAnchor: lines[anchor], intervalId, journey,
            ...(actionIds?.length && { actionIds }) };
          const seen = startup ? startupMatched : matched;
          if (!seen.has(journey)) {
            seen.add(journey);
            (startup ? edges.startup : edges.scenario).push(example);
          }
          if (matchesAction && !exactMatched.has(journey)) {
            exactMatched.add(journey);
            edges.action.push(example);
          }
        }
      }
    }
    start = end + 1;
  }
}

// Both anchors must increase in the same interval. Lines without counters
// can split the physical ranges of a single gap in the instrumented sequence.
function surroundingPassingIntervals(files, recordsByFile, referenceFilesByPath, functions) {
  const surroundingIntervals = [], startupIntervals = [], actionIntervals = [], crossFunctionGaps = [];
  const edges = functions && { scenario: [], startup: [], action: [] };
  for (const { path, passedOnlyKnown } of files) {
    const passing = recordsByFile.get(path);
    if (!passing?.length || !passedOnlyKnown.gapRanges.length) continue;
    const { lines } = referenceFilesByPath.get(path).file;
    const index = new Map(lines.map((line, i) => [line, i]));
    const ranges = functions?.files.get(path);
    const owners = new Map();
    const ownerAt = position => {
      if (position < 0 || position >= lines.length) return;
      if (!owners.has(position)) {
        const line = lines[position];
        let nearest;
        for (const range of ranges) {
          if (range[0] > line) break;
          if (line <= range[1] && (!nearest || range[1] - range[0] < nearest[1] - nearest[0])) nearest = range;
        }
        owners.set(position, nearest);
      }
      return owners.get(position);
    };
    const gaps = passedOnlyKnown.gapRanges.map(([start, end]) => [index.get(start), index.get(end)]);
    for (let cursor = 0; cursor < gaps.length;) {
      const [first, initialLast] = gaps[cursor++];
      let last = initialLast;
      while (gaps[cursor]?.[0] === last + 1) last = gaps[cursor++][1];
      collectFunctionEdges({ path, lines, first, last, ranges, passing, ownerAt, edges });
      const left = first - 1, right = last + 1;
      if (left < 0 || right >= lines.length) continue;
      const range = [lines[first], lines[last]];
      const gapRanges = last - first === range[1] - range[0] ? undefined : compactRanges(lines.slice(first, right));
      const found = new Map(), atStartup = new Map(), exactAction = new Map();
      for (const { journey, intervalId, rows, startup, actionIds, matchesAction } of passing) {
        const group = startup ? atStartup : found;
        if (group.has(journey) && (!matchesAction || exactAction.has(journey))) continue;
        if (rows[left][2] <= rows[left][1] || rows[right][2] <= rows[right][1]) continue;
        const example = { path, range, ...(gapRanges && { gapRanges }),
          observedAround: [lines[left], lines[right]], intervalId, journey,
          ...(actionIds?.length && { actionIds }) };
        if (!group.has(journey)) group.set(journey, example);
        if (matchesAction && !exactAction.has(journey)) exactAction.set(journey, example);
      }
      if ((found.size || atStartup.size) && crossesFunction(functions?.files.get(path), lines[left], lines[right])) {
        crossFunctionGaps.push({ path, ranges: gapRanges ?? [range] });
        continue;
      }
      for (const example of exactAction.values()) actionIntervals.push(example);
      if (found.size) for (const example of found.values()) surroundingIntervals.push(example);
      else for (const example of atStartup.values()) startupIntervals.push(example);
    }
  }
  return { surroundingIntervals, startupIntervals, actionIntervals, crossFunctionGaps, ...(edges && { functionEdges: edges }) };
}

function uniqueLineContexts(lines) {
  const contexts = new Map();
  for (const [index, line] of lines.entries()) {
    const key = JSON.stringify([lines[index - 1], line, lines[index + 1]]);
    contexts.set(key, contexts.has(key) ? 0 : index + 1);
  }
  return contexts;
}

const replayDiagnosticCodes = new Set(['ui-target-ambiguous', 'ui-target-missing', 'ui-wait-timeout',
  'fixture-dependency-missing', 'scenario-assertion', 'scenario-error']);

function replayFailure(record, declaration) {
  const { journey, evidence } = declaration;
  const failure = { intervalId: record.id, journey, evidence };
  const input = readInput(evidence.path);
  if (input.sha256 !== evidence.sha256) fail('Outcome evidence changed during replay planning.');
  let receipt;
  try { receipt = JSON.parse(input.content); } catch { return failure; }
  if (receipt?.schemaVersion !== 1 || receipt.kind !== 'actual-app-cli-scenarios' || receipt.status !== 'failed'
      || !Array.isArray(receipt.scenarios)) return failure;
  const scenario = receipt.scenarios.find(row => row?.status === 'failed' && typeof row.scenario === 'string'
    && (row.group === undefined || typeof row.group === 'string')
    && (row.scenario + (row.group ? `#${row.group}` : '')) === journey);
  const raw = scenario?.diagnostic;
  if (!replayDiagnosticCodes.has(raw?.code)) return failure;
  const diagnostic = { code: raw.code };
  const { path, line } = raw.location ?? {};
  if (typeof path === 'string' && path.length <= 512 && /^tests\/e2e\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.mjs$/.test(path)
      && Number.isSafeInteger(line) && line > 0) diagnostic.location = { path, line };
  if (raw.code === 'ui-target-missing' && raw.matches === 0
      || raw.code === 'ui-target-ambiguous' && Number.isSafeInteger(raw.matches) && raw.matches > 1) diagnostic.matches = raw.matches;
  return { ...failure, diagnostic };
}

function replayPassingSources(store, files, referenceFilesByPath, loaded, journeys, shared) {
  const targets = new Map(files.filter(file => file.status === 'current' && file.passedOnlyKnown.gapLines)
    .map(({ path, passedOnlyKnown }) => [path, { reference: referenceFilesByPath.get(path).file,
      gaps: new Set(passedOnlyKnown.gapRanges.flatMap(([start, end]) => Array.from({ length: end - start + 1 }, (_, index) => start + index))),
      seen: new Set(), mappings: new Map() }]));
  const passing = [], failures = new Map();
  for (const record of loaded.records.values()) {
    const declaration = loaded.declarations.get(record.id), execution = journeys.get(declaration?.journey);
    if (!execution || execution.restrictions.length) continue;
    if (declaration.status === 'failed') {
      if (record.provenanceId === loaded.scopeId && record.validFiles.size && !failures.has(execution)) {
        failures.set(execution, replayFailure(record, declaration));
      }
      continue;
    }
    passing.push({ record, execution });
    for (const captured of record.captureFiles) {
      const target = targets.get(captured.path);
      if (target && !fileEvidenceMismatch(record, captured, target.reference)) target.seen.add(execution);
    }
  }

  const eligible = new Map(), failed = new Map();
  for (const { record, execution } of passing) for (const captured of record.captureFiles) {
    const { path, sha256 } = captured, target = targets.get(path);
    if (!target || target.seen.has(execution) || !record.validFiles.has(path)) continue;
    // The source can still match when the DA line universe changed. These
    // counters also need a fresh capture before they can count in this scope.
    const sameBytes = sha256 === target.reference.sha256;
    if (!sameBytes && !target.mappings.has(sha256)) {
      let earlier;
      for (const i of record.origins) {
        const root = loaded.origins[i].root;
        try {
          const snapshot = shared.stores.get(root) ?? new MeasuredStore(root);
          const lines = snapshot.readLines(path);
          if (sha(lines.join('')) === sha256) { earlier = lines; break; }
        } catch { /* Another validated origin may still have the source. */ }
      }
      if (!earlier) continue;
      if (!target.contexts) {
        const current = store.readLines(path);
        if (sha(current.join('')) !== target.reference.sha256) fail(`Current source changed during replay planning: ${path}`);
        target.contexts = uniqueLineContexts(current);
      }
      const mapping = new Map();
      for (const [context, oldLine] of uniqueLineContexts(earlier)) {
        const currentLine = target.contexts.get(context);
        if (oldLine && target.gaps.has(currentLine)) mapping.set(oldLine, currentLine);
      }
      target.mappings.set(sha256, mapping);
    }
    const mapping = target.mappings.get(sha256);
    for (const [line, before, after] of captured.rows) {
      const currentLine = sameBytes ? line : mapping.get(line);
      if (after <= before || !target.gaps.has(currentLine)) continue;
      const queue = failures.has(execution) ? failed : eligible;
      if (!queue.has(execution)) queue.set(execution, new Map());
      const sources = queue.get(execution);
      if (!sources.has(path)) sources.set(path, new Set());
      sources.get(path).add(currentLine);
    }
  }
  return { eligible, failed, failures };
}

function observedSourceLines({ path, rows }, focus) {
  if (!focus.intersects(path, 1, Infinity)) return [];
  return rows.filter(([line, before, after]) => after > before && focus.intersects(path, line)).map(([line]) => line);
}

function recordActionSource(sources, execution, path, lines, example) {
  if (!sources.has(execution)) sources.set(execution, { files: new Map(), example });
  const entry = sources.get(execution);
  if (!lines.length) return;
  if (!entry.files.size) entry.example = example;
  if (!entry.files.has(path)) entry.files.set(path, new Set());
  for (const line of lines) entry.files.get(path).add(line);
}

export function gapsMeasured(root, { referenceRoot, captureSet, baselineCaptureSet, baselineReferenceRoot, extensionJourneys, replayJourneys, actionQuery, actionDiscovery, launchActions, actionIdsByLabel, functionMapFile }, shared = measurementSnapshot()) {
  referenceRoot = realpathSync(resolve(root, referenceRoot));
  const loaded = loadMeasuredRecords(root, { captureSet }, { referenceRoot, shared });
  if (baselineReferenceRoot) baselineReferenceRoot = realpathSync(resolve(root, baselineReferenceRoot));
  const baseline = baselineCaptureSet && loadMeasuredRecords(root, { captureSet: baselineCaptureSet },
    { referenceRoot: baselineReferenceRoot, retainFiles: true, shared });
  const { files: referenceFiles, ...referenceIdentity } = loaded.scope;
  const functions = functionMapFile && readReferenceFunctions(root, functionMapFile, loaded.scope, referenceRoot);
  const store = new MeasuredStore(root), referenceFilesByPath = new Map();
  for (const file of referenceFiles) {
    const current = currentSource(store, file.path);
    referenceFilesByPath.set(file.path, { file, current, comparable: current.sha256 === file.sha256,
      observed: { passed: new Set(), failed: new Set(), unknown: new Set() }, referencePassing: new Set(), incompatible: new Map() });
  }

  const outcomeCounts = { passed: 0, failed: 0, unknown: 0 }, outOfReference = new Map(), extensionRecords = new Map();
  const actionSources = actionQuery && new Map();
  const dispatchWindowSources = actionQuery?.windowLabel && new Map();
  const recordedActions = actionDiscovery && new Map();
  for (const record of loaded.records.values()) {
    const declaration = loaded.declarations.get(record.id), outcome = declaration?.status ?? 'unknown';
    const extensionJourney = outcome === 'passed' && extensionJourneys?.has(declaration.journey);
    const startup = extensionJourney && launchActions?.length === record.actions.length
      && launchActions.every((action, index) => action === record.actions[index]);
    const actionIds = extensionJourney && !startup && actionIdsByLabel
      && [...new Set([...record.actions, ...(record.actionLabels ?? [])].map(label => actionIdsByLabel.get(label)).filter(Boolean))];
    const actionExecution = actionQuery && outcome === 'passed' && hasAction(record, actionQuery.label)
      && actionQuery.journeys.get(declaration.journey);
    const dispatchWindow = dispatchWindowSources && actionExecution && record.actionLabels?.includes(actionQuery.windowLabel);
    const recordedExecution = actionDiscovery && extensionJourney && !startup && extensionJourneys.get(declaration.journey);
    const discovered = recordedExecution && actionDiscovery.actions(record);
    outcomeCounts[outcome]++;
    const provenanceId = record.provenanceId;
    for (const captured of record.captureFiles) {
      const target = referenceFilesByPath.get(captured.path);
      if (!target) {
        if (!outOfReference.has(captured.path)) outOfReference.set(captured.path, new Set());
        outOfReference.get(captured.path).add(provenanceId); continue;
      }
      const { file } = target;
      const reason = fileEvidenceMismatch(record, captured, file);
      if (reason) {
        const key = `${provenanceId}:${reason}`;
        const entry = target.incompatible.get(key) ?? { provenanceId, reason, intervals: 0 };
        entry.intervals++; target.incompatible.set(key, entry); continue;
      }
      if (!target.comparable) continue;
      if (actionExecution || discovered?.length) {
        const example = { journey: declaration.journey, intervalId: record.id };
        const lines = observedSourceLines(captured, (actionQuery ?? actionDiscovery).focus);
        if (actionExecution) {
          recordActionSource(actionSources, actionExecution, captured.path, lines, example);
          if (dispatchWindow) recordActionSource(dispatchWindowSources, actionExecution, captured.path, lines, example);
        }
        if (lines.length) {
          for (const { action, window } of discovered || []) {
            if (!recordedActions.has(action.label)) recordedActions.set(action.label, { action, sessions: new Map(), windows: new Map() });
            const { sessions, windows } = recordedActions.get(action.label);
            recordActionSource(window ? windows : sessions, recordedExecution, captured.path, lines, example);
          }
        }
      }
      if (extensionJourney) {
        if (!extensionRecords.has(captured.path)) extensionRecords.set(captured.path, []);
        extensionRecords.get(captured.path).push({ journey: declaration.journey, intervalId: record.id,
          rows: captured.rows, startup, actionIds, matchesAction: !startup && Boolean(actionExecution) });
      }
      for (const [line, before, after] of captured.rows) {
        if (after <= before) continue;
        target.observed[outcome].add(line);
        if (outcome === 'passed' && provenanceId === loaded.scopeId) target.referencePassing.add(line);
      }
    }
  }

  const files = [...referenceFilesByPath.values()].map(({ file, current, comparable, observed, referencePassing, incompatible }) => {
    const latest = currentSource(store, file.path);
    if (latest.sha256 !== current.sha256) fail(`Current source changed during measurement gap analysis: ${file.path}`);
    const { lines } = file, { passed, failed, unknown } = observed;
    const all = lines.filter(line => passed.has(line) || failed.has(line) || unknown.has(line));
    const passingGaps = lines.filter(line => !passed.has(line));
    const instrumentedRanges = compactRanges(lines);
    return { path: file.path, referenceSourceSha256: file.sha256, currentSource: current,
      status: comparable ? 'current' : current.sha256 === null ? 'unavailable-current-source' : 'stale-current-source',
      instrumentedLines: lines.length, instrumentedRanges, observedLines: all.length, observedRanges: compactRanges(all),
      passedOnlyKnown: { observedLines: passed.size, observedRanges: compactRanges(lines.filter(line => passed.has(line))),
        gapLines: passingGaps.length, gapRanges: compactRanges(passingGaps) },
      referencePassingObservedRanges: compactRanges(lines.filter(line => referencePassing.has(line))),
      reusedPassingObservedRanges: compactRanges(lines.filter(line => passed.has(line) && !referencePassing.has(line))),
      failedOnlyRanges: compactRanges(passingGaps.filter(line => failed.has(line) && !unknown.has(line))),
      unknownOutcomeRanges: compactRanges(passingGaps.filter(line => unknown.has(line))),
      unobservedInstrumentedRanges: comparable ? compactRanges(passingGaps.filter(line => !failed.has(line) && !unknown.has(line))) : [],
      unknownInstrumentationRanges: current.physicalLines === null ? null : missingRanges(comparable ? lines : [], 1, current.physicalLines),
      unavailableReferenceRanges: comparable ? [] : instrumentedRanges,
      incompatibleEvidence: [...incompatible.values()] };
  }).sort((a, b) => b.passedOnlyKnown.gapLines - a.passedOnlyKnown.gapLines || (a.path < b.path ? -1 : 1));

  const instrumentedLines = referenceFiles.reduce((sum, file) => sum + file.lines.length, 0);
  const totals = observedLines => ({ files: files.length, instrumentedLines, observedLines,
    gapLines: instrumentedLines - observedLines, percent: observedLines / instrumentedLines * 100 });
  return { kind: 'lcov-reference-source-gaps', notice: MEASURED_NOTICE, limitations: [...fixedLimitations,
    'The denominator is the explicit reference instrumentation only. Unavailable current files retain their reference denominator without current observation credit.',
    'Cross-build reuse requires exact current source bytes, a valid snapshot and the same per-file DA line set. Reuse describes source-line evidence across provenances.',
    'Passed-only results require producer-declared outcomes with digest-bound evidence. An absent declaration never earns passing credit.'],
    reference: { root: referenceRoot, datasetSha256: loaded.origins[0].sha256, scopeId: loaded.scopeId, ...referenceIdentity },
    captureSet: loaded.captureSet, origins: loaded.origins,
    provenanceGroups: [...loaded.provenance.values()].map(group => ({ ...group, origins: [...group.origins] })),
    intervals: { unique: loaded.records.size, duplicates: loaded.duplicates, outcomes: outcomeCounts },
    outcomes: { kind: 'producer-declared', provenance: loaded.outcomeProvenance, declarations: loaded.outcomeBindings },
    allObserved: totals(files.reduce((sum, file) => sum + file.observedLines, 0)),
    passedOnlyKnown: totals(files.reduce((sum, file) => sum + file.passedOnlyKnown.observedLines, 0)), files,
    outOfReferenceFiles: [...outOfReference.keys()].sort().map(path => ({ path, provenanceIds: [...outOfReference.get(path)] })),
    ...(actionSources && { actionSources }),
    ...(dispatchWindowSources && { dispatchWindowSources }),
    ...(recordedActions && { recordedActions }),
    ...(functions && { functions }),
    ...(extensionJourneys?.size && surroundingPassingIntervals(files, extensionRecords, referenceFilesByPath, functions)),
    ...(replayJourneys && { replaySources: replayPassingSources(store, files, referenceFilesByPath, loaded, replayJourneys, shared) }),
    ...(baseline && { comparison: {
      ...comparePassingEvidence(loaded, baseline, referenceFilesByPath, files),
      ...(baselineReferenceRoot && { referenceChange: compareReferenceScopes(baseline, baselineReferenceRoot, loaded, referenceRoot) }),
    } }) };
}

export function gapsSeries(root, { referenceRoot, series }) {
  const path = resolve(root, series), input = readInput(path), manifest = JSON.parse(input.content);
  keys(manifest, ['version', 'captureSets'], 'gap series');
  const sets = manifest.captureSets;
  if (manifest.version !== 1 || !Array.isArray(sets) || sets.length < 2 || sets.length > 32 || sets.some(set => !text(set))) {
    fail('Require gap series version 1 and 2-32 capture sets beginning with a baseline.');
  }
  const captureSets = sets.map(set => resolve(dirname(path), set)), shared = measurementSnapshot(256);
  const reports = captureSets.slice(1).map((captureSet, index) =>
    gapsMeasured(root, { referenceRoot, captureSet, baselineCaptureSet: captureSets[index] }, shared));
  return { kind: 'lcov-reference-gap-series', notice: MEASURED_NOTICE, series: { path, sha256: input.sha256 }, reports };
}

function fileEvidenceMismatch(record, captured, reference) {
  if (captured.sha256 !== reference.sha256) return 'source-mismatch';
  if (!record.validFiles.has(captured.path)) return 'snapshot-invalid';
  if (captured.rows.length !== reference.lines.length || captured.rows.some(([line], i) => line !== reference.lines[i])) return 'universe-mismatch';
  return null;
}

function compareReferenceScopes(previous, previousRoot, current, currentRoot) {
  const summarize = ({ scope, scopeId }, root) => ({ root, scopeId, buildSha256: scope.buildSha256,
    sourceManifestSha256: scope.sourceManifestSha256, files: scope.files.length,
    instrumentedLines: scope.files.reduce((sum, file) => sum + file.lines.length, 0) });
  const before = summarize(previous, previousRoot), after = summarize(current, currentRoot);
  const previousFiles = new Map(previous.scope.files.map(file => [file.path, file]));
  const currentFiles = new Map(current.scope.files.map(file => [file.path, file]));
  const changedFiles = [];
  for (const path of [...new Set([...previousFiles.keys(), ...currentFiles.keys()])].sort()) {
    const old = previousFiles.get(path), next = currentFiles.get(path);
    let change;
    if (!old) change = 'added-file';
    else if (!next) change = 'removed-file';
    else if (old.sha256 !== next.sha256) change = 'source-changed';
    else if (old.lines.length !== next.lines.length || old.lines.some((line, i) => line !== next.lines[i])) {
      change = 'instrumentation-changed';
    }
    if (change) changedFiles.push({ path, change, beforeInstrumentedLines: old?.lines.length ?? 0,
      afterInstrumentedLines: next?.lines.length ?? 0 });
  }
  return { before, after, instrumentedLinesDelta: after.instrumentedLines - before.instrumentedLines, changedFiles };
}

function comparePassingEvidence(current, baseline, referenceFiles, currentFiles) {
  if ([...baseline.origins, ...current.origins].some(origin => origin.status === 'missing')) fail('Comparison requires every listed measurement dataset.');
  const previousPassing = new Map(), outcomes = { passed: 0, failed: 0, unknown: 0 };
  for (const record of baseline.records.values()) {
    const now = current.records.get(record.id), beforeOutcome = baseline.declarations.get(record.id), afterOutcome = current.declarations.get(record.id);
    if (now && now.digest !== record.digest) fail(`Conflicting duplicate interval across comparison capture sets: ${record.id}`);
    if (beforeOutcome && afterOutcome && (beforeOutcome.status !== afterOutcome.status || beforeOutcome.journey !== afterOutcome.journey)) {
      fail(`Conflicting outcome declarations across comparison capture sets: ${record.id}`);
    }
    outcomes[beforeOutcome?.status ?? 'unknown']++;
    for (const captured of record.captureFiles) {
      const target = referenceFiles.get(captured.path);
      if (!target?.comparable || fileEvidenceMismatch(record, captured, target.file)) continue;
      if (!previousPassing.has(captured.path)) previousPassing.set(captured.path, new Set());
      if (beforeOutcome?.status !== 'passed') continue;
      const known = previousPassing.get(captured.path);
      for (const [line, before, after] of captured.rows) if (after > before) known.add(line);
    }
  }

  const totals = { gainedLines: 0, lostLines: 0, passingLinesWithoutComparableBaseline: 0, filesWithoutComparableBaseline: 0 };
  const files = [];
  for (const { path, status } of currentFiles) {
    if (status !== 'current') continue;
    const { file, observed: { passed } } = referenceFiles.get(path), before = previousPassing.get(path);
    const gained = before ? file.lines.filter(line => passed.has(line) && !before.has(line)) : [];
    const lost = before ? file.lines.filter(line => before.has(line) && !passed.has(line)) : [];
    const fresh = before ? [] : file.lines.filter(line => passed.has(line));
    totals.gainedLines += gained.length;
    totals.lostLines += lost.length;
    totals.passingLinesWithoutComparableBaseline += fresh.length;
    if (!before) totals.filesWithoutComparableBaseline++;
    if (gained.length || lost.length || fresh.length) files.push({ path, gainedLines: gained.length, gainedRanges: compactRanges(gained),
      lostLines: lost.length, lostRanges: compactRanges(lost), passingLinesWithoutComparableBaseline: fresh.length,
      passingRangesWithoutComparableBaseline: compactRanges(fresh) });
  }
  files.sort((a, b) => b.gainedLines - a.gainedLines || b.lostLines - a.lostLines || (a.path < b.path ? -1 : 1));
  return { ...totals, files, baseline: { captureSet: baseline.captureSet, origins: baseline.origins,
    provenanceGroups: [...baseline.provenance.values()].map(group => ({ ...group, origins: [...group.origins] })),
    intervals: { unique: baseline.records.size, duplicates: baseline.duplicates, outcomes },
    outcomes: { kind: 'producer-declared', provenance: baseline.outcomeProvenance, declarations: baseline.outcomeBindings } } };
}

function nativeBatchReceipt(path) {
  const { content, sha256 } = readInput(path), receipt = JSON.parse(content);
  const coverage = receipt?.coverage, analysis = coverage?.analysis, scenarioRows = receipt?.scenarios;
  if (receipt?.schemaVersion !== 1 || receipt.kind !== 'actual-app-cli-scenarios'
      || !['passed', 'failed'].includes(receipt.status) || receipt.sourceUnchanged !== true || receipt.appUnchanged !== true
      || coverage?.status !== 'imported' || analysis?.version !== 1 || analysis.kind !== 'scriv-external-coverage-analysis'
      || analysis.sourceUnchanged !== true || !object(receipt.selection) || !Array.isArray(scenarioRows)
      || !Array.isArray(coverage.intervals) || !coverage.intervals.length || coverage.imported !== coverage.intervals.length) {
    fail('Require a finished Scriv receipt with unchanged app and source and fully imported coverage.');
  }
  const directory = dirname(path), root = join(directory, 'coverage', 'analysis', 'source');
  if (analysis.root !== root || analysis.dataset !== join(root, MEASURED_PATH) || !hex(coverage.sourceManifestSHA256)
      || analysis.sourceManifestSHA256 !== coverage.sourceManifestSHA256 || !hex(coverage.probeSHA256)
      || !hex(receipt.app?.executableSHA256)) fail('Invalid native batch analysis path or source, probe and build identities.');
  const start = Date.parse(receipt.startedAt), end = Date.parse(receipt.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) fail('Invalid native batch receipt elapsed time.');

  const selections = receipt.selection.cases;
  const multiCase = selections !== undefined;
  if (multiCase && (receipt.selection.mode !== 'subset' || receipt.selection.group !== undefined
      || !Array.isArray(selections) || !selections.length || selections.length !== scenarioRows.length
      || receipt.selection.selectedScenarioCount !== selections.length || !text(coverage.invocationID))) {
    fail('Invalid native batch case selection.');
  }
  const caseKey = ({ scenario, group }) => scenario + (group ? `#${group}` : '');
  const scenarioOutcome = new Map();
  let priorEnd = start;
  for (const [index, row] of scenarioRows.entries()) {
    if (typeof row?.scenario !== 'string' || !/^tests\/e2e\/(?:journeys\/)?[A-Za-z0-9_-]+\.mjs$/.test(row.scenario)
        || scenarioOutcome.has(caseKey(row)) || (!multiCase && row.group !== receipt.selection.group)
        || (row.group !== undefined && (typeof row.group !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(row.group)))) {
      fail('Invalid native batch scenario identity or group.');
    }
    let elapsedSeconds = null;
    if (multiCase) {
      const selected = selections[index];
      keys(selected, ['scenario', 'group'], 'native batch case selection');
      if (row.scenario !== selected.scenario || row.group !== selected.group
          || !['passed', 'failed', 'not-run'].includes(row.status) || (receipt.status === 'passed' && row.status !== 'passed')) {
        fail('Native batch case selection disagrees with scenario results.');
      }
      if (row.status === 'not-run') {
        if (row.startedAt || row.endedAt) fail('An unstarted native batch case has elapsed time.');
      } else {
        const caseStart = Date.parse(row.startedAt), caseEnd = Date.parse(row.endedAt);
        if (!Number.isFinite(caseStart) || !Number.isFinite(caseEnd) || caseStart < priorEnd || caseEnd < caseStart || caseEnd > end) {
          fail('Invalid native batch case elapsed time.');
        }
        priorEnd = caseEnd;
        elapsedSeconds = (caseEnd - caseStart) / 1000;
      }
    }
    const { scenario, group, status } = row;
    scenarioOutcome.set(caseKey(row), { scenario, ...(group && { group }), status, elapsedSeconds, intervals: 0 });
  }
  if (realpathSync(root) !== root) fail('Native batch analysis root must be unsymlinked.');
  const store = new MeasuredStore(root), dataset = store.readMap({ withHash: true });
  if (dataset.data?.intervals.length !== coverage.intervals.length) fail('Native batch dataset and receipt list different numbers of intervals.');
  const imported = new Map(dataset.data.intervals.map(interval => [interval.id, interval]));
  const outcomes = [];
  for (const row of coverage.intervals) {
    if (typeof row?.runID !== 'string' || !/^[a-zA-Z0-9-]{1,200}$/.test(row.runID)
        || row.status !== 'imported' || row.imported !== true) fail('Invalid native batch interval import.');
    const selected = scenarioOutcome.get(caseKey(row)), status = selected?.status;
    if (!['passed', 'failed'].includes(status) || row.scenario !== selected.scenario || row.group !== selected.group
        || row.scenarioStatus !== status || (receipt.status === 'passed' && status !== 'passed')) {
      fail('Native batch interval and scenario outcome disagree.');
    }
    const sessionRoot = join(directory, 'coverage', 'sessions', row.runID);
    if (multiCase) {
      const session = JSON.parse(readInput(join(sessionRoot, 'session.json')).content);
      if (session?.version !== 1 || session.kind !== 'scriv-session-coverage' || session.status !== 'captured'
          || session.invocationID !== coverage.invocationID || session.runID !== row.runID
          || session.scenario !== row.scenario || session.group !== row.group
          || session.executableSHA256 !== receipt.app.executableSHA256 || session.executableUnchanged !== true
          || session.probeSHA256 !== coverage.probeSHA256 || session.sourceManifestSHA256 !== coverage.sourceManifestSHA256) {
        fail('Native batch session does not bind to the selected case.');
      }
    }
    const { id } = JSON.parse(readInput(join(sessionRoot, 'import.json')).content), manifest = imported.get(id)?.manifest;
    if (!manifest || manifest.runId !== row.runID || manifest.before.buildSha256 !== receipt.app.executableSHA256
        || manifest.probeSha256 !== coverage.probeSHA256 || manifest.sourceManifestSha256 !== coverage.sourceManifestSHA256) {
      fail('Native batch import receipt does not bind to the measured run, build, probe and source.');
    }
    imported.delete(id);
    selected.intervals++;
    outcomes.push({ id, journey: caseKey(row), status, evidence: { path, sha256 } });
  }
  const cases = multiCase ? [...scenarioOutcome.values()] : undefined;
  if (cases?.some(row => row.status !== 'not-run' && row.intervals === 0)) {
    fail('A completed native batch case has no imported sessions.');
  }
  const sourceRoots = [coverage.sourceProvenance?.buildSourceRoot, coverage.sourceProvenance?.journeySourceRoot].filter(text);
  return { root, sourceRoots, outcomes, path, sha256, status: receipt.status, elapsedSeconds: (end - start) / 1000,
    datasetSha256: dataset.datasetSha256, cases };
}

export function batchMeasured(root, { baselineCaptureSet, receiptPaths, referenceRoot, baselineReferenceRoot, output }) {
  const shared = measurementSnapshot();
  const baseline = measuredInputs(root, { captureSet: baselineCaptureSet }, false, shared.manifests);
  const baselineOutcomes = baseline.outcomes ? readMeasurementManifest(baseline.outcomes, shared.manifests).data : { version: 1, intervals: [] };
  if (baselineOutcomes.version !== 1 || !Array.isArray(baselineOutcomes.intervals)) fail('Invalid baseline outcome declarations.');
  const outcomes = baselineOutcomes.intervals.map(row => ({ ...row,
    evidence: { ...row.evidence, path: resolve(dirname(baseline.outcomes), row.evidence.path) } }));
  const inputRoots = baseline.inputRoots.map(path => realpathSync(path)), existing = new Set(inputRoots);
  const receipts = receiptPaths.map(path => nativeBatchReceipt(resolve(root, path)));
  for (const receipt of receipts) {
    if (existing.has(receipt.root)) fail('Native batch analysis is already in the capture set.');
    existing.add(receipt.root);
    inputRoots.push(receipt.root);
    outcomes.push(...receipt.outcomes);
  }
  const destination = resolve(root, output), parent = dirname(destination);
  if (realpathSync(parent) !== parent || !lstatSync(parent).isDirectory() || existsSync(destination)) {
    fail('Native batch output must be a new directory with an existing unsymlinked parent.');
  }
  const forbidden = [root, ...inputRoots, realpathSync(resolve(root, referenceRoot)), ...receipts.flatMap(receipt => receipt.sourceRoots)];
  if (forbidden.some(path => destination === path || destination.startsWith(path + sep))) fail('Native batch output must be outside all source roots.');

  const staging = mkdtempSync(join(parent, '.tracer-batch-'));
  const write = (name, value) => writeFileSync(join(staging, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    write('captures.json', { version: 1, scope: baseline.scopeMode, inputRoots, outcomes: 'outcomes.json' });
    write('outcomes.json', { version: 1, intervals: outcomes });
    const report = gapsMeasured(root, { referenceRoot, captureSet: join(staging, 'captures.json'), baselineCaptureSet, baselineReferenceRoot }, shared);
    for (const receipt of receipts) {
      const origin = report.origins.find(origin => origin.root === receipt.root);
      if (origin?.sha256 !== receipt.datasetSha256 || origin.invalidSnapshotFiles?.length) fail('Native batch source or dataset changed after receipt validation.');
    }
    report.captureSet.path = join(destination, 'captures.json');
    report.outcomes.provenance.path = join(destination, 'outcomes.json');
    const result = { kind: 'native-measurement-batch', version: 1, output: destination, captureSet: report.captureSet.path,
      passedOnlyKnown: report.passedOnlyKnown, comparison: report.comparison,
      receipts: receipts.map(({ path, sha256, status, elapsedSeconds, outcomes, cases }) => ({ path, sha256, status, elapsedSeconds,
        intervals: outcomes.length, ...(cases && { cases }) })) };
    write('report.json', report);
    write('batch.json', result);
    if (existsSync(destination)) fail('Native batch output already exists.');
    renameSync(staging, destination);
    return result;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
