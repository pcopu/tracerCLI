import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
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
  readMap() {
    this.validateMapPath();
    if (!existsSync(this.mapPath)) return { version: 1, kind: 'lcov-intervals', intervals: [] };
    const file = readInput(this.mapPath), data = JSON.parse(file.content);
    keys(data, ['version', 'kind', 'intervals'], 'measurement dataset');
    if (data.version !== 1 || data.kind !== 'lcov-intervals' || !Array.isArray(data.intervals)) fail('Expected measurement dataset version 1.');
    const ids = new Set();
    for (const interval of data.intervals) {
      validateInterval(interval);
      if (ids.has(interval.id)) fail('Duplicate measured interval identity.');
      ids.add(interval.id);
    }
    return data;
  }
}
function intervalId(value) {
  return sha(JSON.stringify([value.manifest.before.sha256, value.manifest.after.sha256,
    value.manifest.before.buildSha256]));
}
function validateInterval(value) {
  keys(value, ['id', 'manifest', 'manifestSha256', 'stripPrefix', 'files', 'payloadSha256'], 'interval');
  validateManifest(value.manifest); validatePrefix(value.stripPrefix || undefined);
  if (!hex(value.manifestSha256) || value.id !== intervalId(value) || !Array.isArray(value.files) || !value.files.length) fail('Invalid interval identity or files.');
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
    const existing = data.intervals.find(item => item.id === interval.id);
    if (existing) {
      if (existing.payloadSha256 !== interval.payloadSha256) fail('This LCOV pair already exists with conflicting provenance or labels. Never relabel captured evidence silently.');
      return { changed: false, id: interval.id, notice: MEASURED_NOTICE };
    }
    data.intervals.push(interval);
    if (Buffer.byteLength(JSON.stringify(data, null, 2)) > 64 * 1024 * 1024) fail('Measurement dataset exceeds 64 MiB.');
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
