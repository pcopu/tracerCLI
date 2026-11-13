import { progress } from './catalog.mjs';
import { proposalProgress, proposalCommand } from './proposals.mjs'; import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve, sep } from 'node:path';

export const VERSION = '0.3.0';
export const NOTICE = 'MANUAL LINKS ONLY. A current link is not observed execution, test coverage or proof of correctness.';
export const DEFAULT_MAP = 'docs/testing/code-e2e-links.json';
export const SOURCE_EXTENSIONS = ('.swift .ts .tsx .mts .cts .js .jsx .mjs .cjs .m .mm .h .hpp .hxx .c .cc .cpp .cxx '
  + '.py .sh .bash .zsh .sql .css .scss .sass .html .htm .vue .svelte .rs .go .java .kt .kts .rb .php .cs .ps1 .lua .metal .proto').split(' ');
const configExtensions = new Set(['.yaml', '.yml', '.json', '.jsonc', '.toml', '.ini', '.xml', '.tf', '.tfvars']);
const configRoots = new Set(['src', 'app', 'apps', 'lib', 'config', 'configs', 'cloud', 'cli', '.github']);
const configArtifacts = new Set(['docs', 'test', 'tests', '__tests__', 'fixtures', 'test-data', 'artifacts']);
const rootConfigs = new Set(['package.json', 'pyproject.toml', 'Cargo.toml', 'composer.json', 'deno.json', 'deno.jsonc',
  'biome.json', 'biome.jsonc', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
  'wrangler.toml', 'wrangler.json', 'wrangler.jsonc']);
const sourceNames = new Set(['Makefile', 'Dockerfile', 'CMakeLists.txt', 'Gemfile', 'Rakefile']);
const excludedDirectories = new Set(['.git', 'node_modules', '.build', '.swiftpm', '.wrangler', 'build', 'dist',
  'coverage', 'target', 'Pods', 'Carthage', 'vendor', 'vendors', 'third_party', 'generated', '__generated__',
  'DerivedData', 'test-results', 'playwright-report', '__pycache__']);
const digest = text => createHash('sha256').update(text).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const location = range => `${range.path}:${range.start}${range.end === range.start ? '' : `-${range.end}`}`;
function fail(message) { throw new Error(message); }
export function safePath(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || /^[a-z]:/i.test(path)
      || /[\x00-\x1f\x7f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) {
    fail(`Expected a repository-relative path: ${JSON.stringify(path)}`);
  }
  return path;
}
export function parseRange(input, required = true) {
  const match = /^(.*):([1-9]\d*)(?:-([1-9]\d*))?$/.exec(input ?? '');
  if (!match) {
    if (!required && input) return { path: safePath(input) };
    fail('Use a repository-relative path:line or path:start-end (1-based, inclusive).');
  }
  const range = { path: safePath(match[1]), start: Number(match[2]), end: Number(match[3] ?? match[2]) };
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start > range.end) fail('Invalid line range.');
  return range;
}
export function validateMinimum(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('Minimum traces must be a positive safe integer.');
  return value;
}
export function validateActions(actions) {
  if (!Array.isArray(actions) || !actions.length) fail('Provide at least one ordered CLI action.');
  for (const action of actions) if (typeof action !== 'string' || !action.trim() || action !== action.trim()
      || /[\x00-\x1f\x7f]/.test(action)) fail('CLI actions must be nonempty single-line descriptions.');
}
function isConfigSource(parts) {
  const name = parts.at(-1);
  if (!configExtensions.has(extname(name).toLowerCase()) || /(?:^|[.-])lock(?:[.-]|$)/i.test(name)) return false;
  if (parts.length === 1) return rootConfigs.has(name) || /^tsconfig(?:\.[^.]+)*\.json$/.test(name);
  return configRoots.has(parts[0]) && !parts.slice(0, -1).some(part => configArtifacts.has(part));
}
export function compactRanges(numbers) {
  const result = [];
  for (const n of numbers) {
    const last = result.at(-1);
    if (last && last[1] + 1 === n) last[1] = n;
    else result.push([n, n]);
  }
  return result;
}

// Count distinct exact sequences at interval boundaries, not once per source line.
// Occurrence counts keep overlapping copies from removing a still-active sequence.
function countIntervals(links, start, end, minimumTraces, sourceLines, comments) {
  const events = new Map(), active = new Map(), witnessed = new Map();
  const result = { lines: 0, linked: 0, withStep: 0, unlinked: 0,
    linkedRanges: [], unlinkedRanges: [], traceCounts: [], belowMinimum: 0, belowMinimumRanges: [],
    physicalLines: Math.max(0, end - start + 1), blankLines: 0, blankRanges: [], commentLines: 0, commentRanges: [] };
  if (start > end) return result;
  // Count physical whitespace-only lines without interpreting any language syntax.
  // Original bytes and coordinates, including blanks, remain in every link hash.
  const blankBoundaries = new Map();
  for (let line = start; line <= end; line++) {
    if (sourceLines[line - 1].trim() !== '') continue;
    const previous = result.blankRanges.at(-1);
    if (previous && previous[1] + 1 === line) previous[1] = line;
    else result.blankRanges.push([line, line]);
  }
  for (const [first, last] of result.blankRanges) {
    blankBoundaries.set(first, true); blankBoundaries.set(last + 1, false);
    events.set(first, []); events.set(last + 1, []);
  }
  const commentChanges = new Map();
  for (const comment of comments) {
    const first = Math.max(start, comment.source.start), after = Math.min(end, comment.source.end) + 1;
    commentChanges.set(first, (commentChanges.get(first) ?? 0) + 1);
    commentChanges.set(after, (commentChanges.get(after) ?? 0) - 1);
    if (!events.has(first)) events.set(first, []);
    if (!events.has(after)) events.set(after, []);
  }
  const event = (line, key, step, delta) => {
    let entries = events.get(line);
    if (!entries) { entries = []; events.set(line, entries); }
    entries.push({ key, step, delta });
  };
  for (const link of links) {
    const key = JSON.stringify(link.actions), step = Boolean(link.step);
    event(Math.max(start, link.source.start), key, step, 1);
    event(Math.min(end, link.source.end) + 1, key, step, -1);
  }
  if (!events.has(start)) events.set(start, []);
  if (!events.has(end + 1)) events.set(end + 1, []);
  const boundaries = [...events.keys()].sort((a, b) => a - b);
  const change = (counts, key, delta) => {
    const count = (counts.get(key) ?? 0) + delta;
    if (count) counts.set(key, count); else counts.delete(key);
  };
  const append = (ranges, first, last) => {
    const previous = ranges.at(-1);
    if (previous && previous[1] + 1 === first) previous[1] = last;
    else ranges.push([first, last]);
  };
  let blank = false, commentCount = 0;
  for (let index = 0; index < boundaries.length - 1; index++) {
    const first = boundaries[index], last = boundaries[index + 1] - 1;
    blank = blankBoundaries.get(first) ?? blank;
    commentCount += commentChanges.get(first) ?? 0;
    for (const { key, step, delta } of events.get(first)) {
      change(active, key, delta);
      if (step) change(witnessed, key, delta);
    }
    const count = active.size, withStepCount = witnessed.size, length = last - first + 1;
    if (blank) result.blankLines += length;
    else if (commentCount) { result.commentLines += length; append(result.commentRanges, first, last); }
    else {
      result.lines += length;
      if (count) { result.linked += length; append(result.linkedRanges, first, last); }
      else { result.unlinked += length; append(result.unlinkedRanges, first, last); }
      if (withStepCount) result.withStep += length;
      if (count < minimumTraces) { result.belowMinimum += length; append(result.belowMinimumRanges, first, last); }
    }
    const previous = result.traceCounts.at(-1);
    if (previous && previous.count === count && previous.withStepCount === withStepCount) previous.end = last;
    else result.traceCounts.push({ start: first, end: last, count, withStepCount });
  }
  return result;
}

export class Tracer {
  // Caches belong to one inventory snapshot, never to a later command or stat key.
  #snapshots = new WeakMap();
  constructor({ root, map = DEFAULT_MAP, extensions = [] } = {}) {
    const directory = realpathSync(resolve(root ?? process.cwd()));
    this.root = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'],
      { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
    if (root && this.root !== directory) fail('--root must name the Git repository root, not a subdirectory.');
    this.map = safePath(map);
    if (this.map.split('/').includes('.git')) fail('The sidecar cannot be stored inside .git.');
    this.mapPath = resolve(this.root, this.map);
    this.extensions = new Set(SOURCE_EXTENSIONS);
    for (const extension of extensions) {
      if (!/^\.[a-z0-9][a-z0-9_+-]*$/i.test(extension)) fail(`Invalid source extension: ${extension}; use .zig, for example.`);
      this.extensions.add(extension.toLowerCase());
    }
  }
  readLines(path) {
    const absolute = resolve(this.root, safePath(path));
    if (!lstatSync(absolute).isFile() || realpathSync(absolute) !== absolute
        || !absolute.startsWith(this.root + sep)) fail(`Not a regular unsymlinked repository file: ${path}`);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(absolute));
    if (text.includes('\0')) fail(`Not a text file (NUL byte): ${path}`);
    // Preserve BOM and CRLF. A final newline does not invent an extra line.
    return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  }
  inventory() {
    const paths = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: this.root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
      .split('\0').filter(Boolean))].sort(compare);
    const files = new Map(), candidates = new Set(), excluded = [];
    for (const path of paths) {
      safePath(path);
      const parts = path.split('/'), name = parts.at(-1), absolute = resolve(this.root, path);
      const source = this.extensions.has(extname(name).toLowerCase()) || sourceNames.has(name) || isConfigSource(parts);
      let reason;
      if (path === this.map || path.startsWith(`${this.map}.`) || path === 'docs/testing/code-e2e-measurements.json' || path.startsWith('docs/testing/code-e2e-measurements.json.')) reason = 'Tracer sidecar or working file';
      else if (parts.slice(0, -1).some(p => excludedDirectories.has(p))) reason = 'dependency/build/generated directory';
      else if (/(?:\.generated\.|_generated\.)/i.test(name)) reason = 'generated filename';
      else if (!existsSync(absolute)) reason = 'missing tracked file or dangling symlink';
      else if (!lstatSync(absolute).isFile() || realpathSync(absolute) !== absolute) reason = 'symlink or nonregular file';
      if (reason) { if (source) excluded.push({ path, reason }); }
      else { candidates.add(path); if (source) files.set(path, this.readLines(path)); }
    }
    return { files, candidates, excluded };
  }
  snapshot(range, state, step = false) {
    if (!range || typeof range !== 'object') fail('Missing range object.');
    safePath(range.path);
    let cache = this.#snapshots.get(state);
    if (!cache) { cache = { witnesses: new Map(), hashes: new Map() }; this.#snapshots.set(state, cache); }
    let lines = state.files.get(range.path);
    if (!lines && step && state.candidates.has(range.path)) {
      lines = cache.witnesses.get(range.path);
      if (!lines) { lines = this.readLines(range.path); cache.witnesses.set(range.path, lines); }
    }
    if (!lines) fail(`File is outside the current ${step ? 'eligible repository text files' : 'source inventory'}: ${range.path}`);
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
        || range.start < 1 || range.end < range.start || range.end > lines.length) {
      fail(`Invalid range ${location(range)}; file has ${lines.length} lines.`);
    }
    let hashes = cache.hashes.get(range.path);
    if (!hashes) { hashes = new Map(); cache.hashes.set(range.path, hashes); }
    const key = `${range.start}:${range.end}`;
    let sha256 = hashes.get(key);
    if (sha256 === undefined) { sha256 = digest(lines.slice(range.start - 1, range.end).join('')); hashes.set(key, sha256); }
    return { path: range.path, start: range.start, end: range.end, sha256 };
  }
  validateMapPath() {
    const parts = this.map.split('/');
    for (let index = 0; index < parts.length; index++) {
      const path = parts.slice(0, index + 1).join('/'), absolute = resolve(this.root, path);
      let info;
      try { info = lstatSync(absolute); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
      if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())
          || realpathSync(absolute) !== absolute) fail(`Sidecar path must stay unsymlinked inside the repository: ${path}`);
    }
  }
  readMap({ withHash = false } = {}) {
    this.validateMapPath();
    const present = existsSync(this.mapPath), bytes = present ? readFileSync(this.mapPath) : Buffer.alloc(0);
    const data = present ? JSON.parse(bytes.toString('utf8')) : { version: 1, links: [] };
    if (!data || data.version !== 1 || !Array.isArray(data.links)) fail('Expected sidecar version 1 and links array.');
    if (Object.hasOwn(data, 'deadCode') && !Array.isArray(data.deadCode)) fail('Expected deadCode to be an array.'); if (Object.hasOwn(data, 'commentExclusions') && !Array.isArray(data.commentExclusions)) fail('Expected commentExclusions to be an array.');
    validateMinimum(Object.hasOwn(data, 'minimumTraces') ? data.minimumTraces : 1); validateIgnoredSources(data);
    return withHash ? { data, mapSha256: digest(bytes) } : data;
  }
  inspect(data, state) {
    const counts = new Map();
    for (const link of data.links) if (typeof link?.id === 'string') counts.set(link.id, (counts.get(link.id) ?? 0) + 1);
    return data.links.map(link => {
      const errors = [];
      if (!link || typeof link !== 'object' || Array.isArray(link)) return { link: {}, errors: ['Invalid link object'] };
      if (typeof link.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(link.id) || counts.get(link.id) > 1) errors.push('Missing, invalid or duplicate link id');
      if (typeof link.why !== 'string' || !link.why.trim() || /[\x00-\x1f\x7f]/.test(link.why)) errors.push('Missing or invalid single-line explanation');
      try { validateActions(link.actions); } catch (error) { errors.push(error.message); }
      for (const key of ['source', 'step']) {
        if (key === 'step' && link.step === undefined) continue;
        try {
          const current = this.snapshot(link[key], state, key === 'step');
          if (current.sha256 !== link[key].sha256) errors.push(`${key} snippet is stale: ${location(current)}`);
        } catch (error) { errors.push(`${key}: ${error.message}`); }
      }
      return { link, errors };
    });
  }
  inspectComments(data, state) {
    const comments = data.commentExclusions ?? [], counts = new Map();
    for (const comment of comments) if (typeof comment?.id === 'string') counts.set(comment.id, (counts.get(comment.id) ?? 0) + 1);
    return comments.map(comment => {
      const errors = [];
      if (!comment || typeof comment !== 'object' || Array.isArray(comment)) return { comment: {}, errors: ['Invalid comment declaration'] };
      if (typeof comment.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(comment.id) || counts.get(comment.id) > 1) errors.push('Missing, invalid or duplicate comment id');
      if (typeof comment.source?.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(comment.source.sha256)) errors.push('Missing or invalid comment snippet hash');
      if (typeof comment.fileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(comment.fileSha256)) errors.push('Missing or invalid source file hash');
      try {
        const current = this.snapshot(comment.source, state);
        if (current.sha256 !== comment.source.sha256) errors.push(`comment snippet is stale: ${location(current)}`);
        const file = this.snapshot({ path: current.path, start: 1, end: state.files.get(current.path).length }, state);
        if (file.sha256 !== comment.fileSha256) errors.push(`comment source file is stale: ${current.path}`);
      } catch (error) { errors.push(`source: ${error.message}`); }
      return { comment, errors };
    });
  }
  serializeMap(data) { return `${JSON.stringify(data, null, 2)}\n`; }
  mutate(callback) {
    this.validateMapPath();
    mkdirSync(dirname(this.mapPath), { recursive: true });
    const lock = `${this.mapPath}.lock`, temporary = `${this.mapPath}.${randomUUID()}.tmp`;
    try { writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code === 'EEXIST') fail(`Another writer or stale lock exists: ${this.map}.lock. Check the writer before removing it.`);
      throw error;
    }
    try {
      const data = this.readMap(), result = callback(data);
      if (result.changed) {
        this.validateMapPath();
        writeFileSync(temporary, this.serializeMap(data), { flag: 'wx', mode: 0o644 });
        renameSync(temporary, this.mapPath);
      }
      return result;
    } finally {
      try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      unlinkSync(lock);
    }
  }
  link({ source, actions, step, why }) {
    validateActions(actions);
    if (typeof why !== 'string' || !why.trim() || /[\x00-\x1f\x7f]/.test(why)) fail('link requires --why with a nonempty single-line explanation.');
    const state = this.inventory();
    const candidate = { source: this.snapshot(parseRange(source), state), actions,
      ...(step ? { step: this.snapshot(parseRange(step), state, true) } : {}) };
    const identity = value => JSON.stringify([location(value.source), value.actions, value.step ? location(value.step) : null]);
    return this.mutate(data => {
      const invalid = this.inspect(data, state).filter(row => row.errors.some(error => !error.includes('snippet is stale')));
      if (invalid.length) fail('Sidecar contains invalid links. Run check and repair invalid entries before adding a link.');
      const existing = data.links.find(value => identity(value) === identity(candidate));
      const id = existing?.id ?? digest(identity(candidate)).slice(0, 16);
      const link = { id, ...candidate, why: why.trim() };
      const previous = data.links.find(value => value.id === id);
      if (previous) {
        // Compare known fields independently of JSON object key order.
        const same = previous.why === link.why && previous.source.sha256 === link.source.sha256
          && previous.step?.sha256 === link.step?.sha256 && identity(previous) === identity(link);
        if (!same) fail(`Link ${id} already exists with different content. Review it, then unlink and relink; hashes are never silently refreshed.`);
        return { changed: false, link: previous };
      }
      data.links.push(link); data.links.sort((a, b) => compare(a.id, b.id));
      return { changed: true, link };
    });
  }
  unlink(id) {
    if (typeof id !== 'string' || !id) fail('unlink requires an exact link id.');
    return this.mutate(data => {
      const matches = data.links.filter(link => link?.id === id);
      if (!matches.length) fail(`Unknown link id: ${id}`);
      if (matches.length > 1) fail(`Duplicate link id: ${id}; repair the sidecar explicitly.`);
      data.links = data.links.filter(link => link?.id !== id);
      return { changed: true, id };
    });
  }
  comment(source) {
    const state = this.inventory(), range = this.snapshot(parseRange(source), state);
    const file = this.snapshot({ path: range.path, start: 1, end: state.files.get(range.path).length }, state);
    return this.mutate(data => {
      if (this.inspectComments(data, state).some(row => row.errors.some(error => !error.includes(' is stale')))) {
        fail('Sidecar contains invalid comment declarations. Run check and repair invalid entries before marking comments.');
      }
      const comments = data.commentExclusions ?? [], identity = value => location(value.source);
      const existing = comments.find(value => identity(value) === location(range));
      const id = existing?.id ?? digest(JSON.stringify(['comment', location(range)])).slice(0, 16);
      if (existing) {
        if (existing.source.sha256 !== range.sha256 || existing.fileSha256 !== file.sha256) {
          fail(`Comment ${id} already exists with different source. Review it, then uncomment and mark again; hashes are never silently refreshed.`);
        }
        return { changed: false, comment: existing };
      }
      if (comments.some(value => value.id === id)) fail(`Comment id collision: ${id}; review the sidecar explicitly.`);
      const comment = { id, source: range, fileSha256: file.sha256 };
      data.commentExclusions = [...comments, comment].sort((a, b) => compare(a.id, b.id));
      return { changed: true, comment };
    });
  }
  uncomment(id) {
    if (typeof id !== 'string' || !id) fail('uncomment requires an exact comment id.');
    return this.mutate(data => {
      const comments = data.commentExclusions ?? [], matches = comments.filter(comment => comment?.id === id);
      if (!matches.length) fail(`Unknown comment id: ${id}`);
      if (matches.length > 1) fail(`Duplicate comment id: ${id}; repair the sidecar explicitly.`);
      data.commentExclusions = comments.filter(comment => comment?.id !== id);
      return { changed: true, id };
    });
  }
  config(minimumTraces) {
    if (minimumTraces === undefined) return { minimumTraces: this.readMap().minimumTraces ?? 1 };
    validateMinimum(minimumTraces);
    this.mutate(data => { data.minimumTraces = minimumTraces; return { changed: true }; });
    return { minimumTraces };
  }
  check({ requireMinimum = false, minimumTraces } = {}) {
    const data = this.readMap(), state = this.inventory(), inspected = this.inspect(data, state), comments = this.inspectComments(data, state);
    const ignoredSources = ignoredScope(data, state), dead = this.inspectDeadCode(data, state);
    const invalid = inspected.filter(row => row.errors.length);
    const result = { kind: 'manual-link-integrity', notice: NOTICE, total: inspected.length,
      valid: inspected.length - invalid.length, invalid, commentTotal: comments.length,
      commentValid: comments.filter(row => !row.errors.length).length, invalidComments: comments.filter(row => row.errors.length),
      deadCodeTotal: dead.length, invalidDeadCode: dead.filter(row => row.errors.length), ignoredSources, ignoredFiles: [...state.files.keys()].filter(path => ignoredSources.some(rule => matchesIgnored(path, rule.path))), scopeNotice: IGNORE_NOTICE };
    if (requireMinimum) {
      const report = this.#report(undefined, minimumTraces, state, data, inspected, comments);
      result.minimumTraces = report.minimumTraces; result.belowMinimum = report.totals.belowMinimum;
      result.lineBasis = report.lineBasis; result.physicalLines = report.totals.physicalLines; result.blankLines = report.totals.blankLines;
      result.commentLines = report.totals.commentLines; result.ignoredTotals = report.ignoredTotals;
    }
    return result;
  }
  report(query, { minimumTraces } = {}) {
    const state = this.inventory(), data = this.readMap(), inspected = this.inspect(data, state);
    return this.#report(query, minimumTraces, state, data, inspected, this.inspectComments(data, state));
  }
  proposal(file, options) {
    const state = this.inventory();
    return proposalCommand(this, file, options, { state, report: () => {
      const { data, mapSha256 } = this.readMap({ withHash: true }), inspected = this.inspect(data, state);
      return { ...this.#report(undefined, undefined, state, data, inspected, this.inspectComments(data, state), false), mapSha256 };
    }, witness: range => state.files.get(range.path) ?? this.#snapshots.get(state)?.witnesses.get(range.path) });
  }
  #report(query, minimumTraces, state, data, inspected, inspectedComments, includeProposal = true) {
    minimumTraces = validateMinimum(minimumTraces ?? data.minimumTraces ?? 1);
    const sourceFilter = query?.kind === 'source' ? parseRange(query.value, false) : null;
    const stepFilter = query?.kind === 'step' ? parseRange(query.value, false) : null;
    if (query && !['source', 'step', 'action', 'sequence'].includes(query.kind)) fail('Unknown report selector.');
    if (query?.kind === 'sequence') validateActions(query.value);
    if (query?.kind === 'action') validateActions([query.value]);
    for (const [range, step] of [[sourceFilter, false], [stepFilter, true]]) {
      if (!range) continue;
      const lines = state.files.get(range.path) ?? (step && state.candidates.has(range.path) ? this.readLines(range.path) : undefined);
      if (!lines) fail(`File is outside the current ${step ? 'eligible repository text files' : 'source inventory'}: ${range.path}`);
      if (range.start) this.snapshot(range, state, step);
    }
    const sequence = query?.kind === 'sequence' ? JSON.stringify(query.value) : null;
    const matches = link => {
      if (!query || sourceFilter) return true;
      if (query.kind === 'action') return link.actions.includes(query.value);
      if (query.kind === 'sequence') return JSON.stringify(link.actions) === sequence;
      return link.step?.path === stepFilter.path && (!stepFilter.start
        || link.step.end >= stepFilter.start && link.step.start <= stepFilter.end);
    };
    const valid = inspected.filter(row => !row.errors.length).map(row => row.link).filter(matches);
    const byFile = new Map();
    for (const link of valid) {
      let links = byFile.get(link.source.path);
      if (!links) { links = []; byFile.set(link.source.path, links); }
      links.push(link);
    }
    const commentsByFile = new Map();
    for (const { comment, errors } of inspectedComments) {
      if (errors.length) continue;
      let comments = commentsByFile.get(comment.source.path);
      if (!comments) { comments = []; commentsByFile.set(comment.source.path, comments); }
      comments.push(comment);
    }
    const files = [], ignoredFiles = [], totals = { files: 0, lines: 0, linked: 0, withStep: 0, unlinked: 0, belowMinimum: 0, physicalLines: 0, blankLines: 0, commentLines: 0 };
    const ignoredTotals = Object.fromEntries(Object.keys(totals).map(key => [key, 0])), ignoredSources = ignoredScope(data, state);
    for (const [path, lines] of state.files) {
      if (sourceFilter && sourceFilter.path !== path) continue;
      if (query && !sourceFilter && !byFile.has(path)) continue;
      const start = sourceFilter?.start ?? 1, end = sourceFilter?.end ?? lines.length;
      const links = (byFile.get(path) ?? []).filter(link => link.source.end >= start && link.source.start <= end);
      const comments = (commentsByFile.get(path) ?? []).filter(comment => comment.source.end >= start && comment.source.start <= end);
      const counts = countIntervals(links, start, end, minimumTraces, lines, comments);
      const ignoredBy = ignoredSources.filter(rule => matchesIgnored(path, rule.path)).map(rule => rule.path);
      (ignoredBy.length ? ignoredFiles : files).push({ path, start, end, ...counts, links, comments, ...(ignoredBy.length ? { ignoredBy } : {}) });
      const aggregate = ignoredBy.length ? ignoredTotals : totals;
      aggregate.files++;
      for (const key of ['lines', 'linked', 'withStep', 'unlinked', 'belowMinimum', 'physicalLines', 'blankLines', 'commentLines']) aggregate[key] += counts[key];
    }
    return { kind: 'manual-links', notice: NOTICE, progress: { ...progress(this.root, state, files, totals),
      proposed: includeProposal ? proposalProgress(this.root, state, files, totals, this.map) : undefined,
      reviewed: { status: 'operator-declared-manual-links', lines: totals.linked, denominator: totals.lines, percent: totals.lines ? totals.linked * 100 / totals.lines : null, withWitnessLines: totals.withStep, notice: 'Current manual links reflect operator declarations; Tracer checks integrity, not semantic review or execution.' },
      executed: { status: 'not-derived-from-mapping', lines: null, denominator: null, percent: null, notice: 'Execution is unknown here, not zero. Consult real scenario outcomes and measure report for separately scoped evidence; never infer execution from proposals or links.' },
      deadCode: this.deadCodeProgress(data, state, commentsByFile, ignoredSources, minimumTraces) }, minimumTraces, traceIdentity: 'exact-ordered-action-sequence', query: query ?? null, totals, files,
      lineBasis: 'nonblank-undeclared-comment-lines', commentNotice: 'Comment exclusions are declarations, not verified syntax or execution evidence.',
      ignoredFiles, ignoredTotals, ignoredSources, scopeNotice: IGNORE_NOTICE,
      excluded: state.excluded, invalid: inspected.filter(row => row.errors.length), invalidComments: inspectedComments.filter(row => row.errors.length) };
  }
  ignore(path, why) {
    const requested = ignoredPath(path), plain = requested.replace(/\/$/, ''), absolute = resolve(this.root, plain);
    if (typeof why !== 'string' || !why.trim() || /[\x00-\x1f\x7f]/.test(why)) fail('ignore requires --why with a nonempty single-line explanation.');
    let stat;
    try { stat = lstatSync(absolute); } catch { fail(`Ignore target must exist inside the repository: ${requested}`); }
    if (stat.isSymbolicLink() || realpathSync(absolute) !== absolute || !stat.isFile() && !stat.isDirectory()) fail(`Ignore target must be a regular, unsymlinked file or directory: ${requested}`);
    if (requested.endsWith('/') && !stat.isDirectory()) fail(`Ignore path ending in / must name a directory: ${requested}`);
    const canonical = stat.isDirectory() ? `${plain}/` : plain;
    return this.mutate(data => {
      const rules = data.ignoredSources ?? [], previous = rules.find(rule => rule.path === canonical);
      if (previous) {
        if (previous.why !== why.trim()) fail(`Ignore rule already has a different reason: ${canonical}. Review it, then unignore and add it again.`);
        return { changed: false, ignored: previous };
      }
      const ignored = { path: canonical, why: why.trim() };
      data.ignoredSources = [...rules, ignored].sort((a, b) => compare(a.path, b.path));
      return { changed: true, ignored };
    });
  }
  unignore(path) {
    const exact = ignoredPath(path);
    return this.mutate(data => {
      const rules = data.ignoredSources ?? [];
      if (!rules.some(rule => rule.path === exact)) fail(`Unknown exact ignore path: ${exact}. Use the saved path, including a directory's trailing slash.`);
      data.ignoredSources = rules.filter(rule => rule.path !== exact);
      return { changed: true, path: exact };
    });
  }
  inspectDeadCode(data, state) {
    const rows = data.deadCode ?? [], counts = new Map();
    for (const mark of rows) if (typeof mark?.id === 'string') counts.set(mark.id, (counts.get(mark.id) ?? 0) + 1);
    return rows.map(mark => {
      const errors = [];
      if (!mark || typeof mark !== 'object' || Array.isArray(mark)) return { mark: {}, errors: ['Invalid dead-code declaration'] };
      if (typeof mark.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(mark.id) || counts.get(mark.id) > 1) errors.push('Missing, invalid or duplicate dead-code id');
      for (const key of ['why', 'evidence']) if (typeof mark[key] !== 'string' || !mark[key].trim() || /[\x00-\x1f\x7f]/.test(mark[key])) errors.push(`Missing or invalid ${key}`);
      if (!/^[a-f0-9]{64}$/.test(mark.source?.sha256 ?? '') || !/^[a-f0-9]{64}$/.test(mark.fileSha256 ?? '')) errors.push('Missing or invalid source hashes');
      try {
        const current = this.snapshot(mark.source, state);
        if (current.sha256 !== mark.source.sha256) errors.push(`dead-code snippet is stale: ${location(current)}`);
        const file = this.snapshot({ path: current.path, start: 1, end: state.files.get(current.path).length }, state);
        if (file.sha256 !== mark.fileSha256) errors.push(`dead-code source file is stale: ${current.path}`);
      } catch (error) { errors.push(`source: ${error.message}`); }
      return { mark, errors };
    });
  }
  deadCode(source, why, evidence) {
    for (const [key, value] of [['why', why], ['evidence', evidence]]) if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) fail(`dead-code requires --${key} with nonempty single-line text.`);
    const state = this.inventory(), range = this.snapshot(parseRange(source), state);
    const file = this.snapshot({ path: range.path, start: 1, end: state.files.get(range.path).length }, state);
    return this.mutate(data => {
      if (this.inspectDeadCode(data, state).some(row => row.errors.some(error => !error.includes(' is stale')))) fail('Sidecar contains invalid dead-code declarations. Repair them before marking.');
      const marks = data.deadCode ?? [], id = digest(JSON.stringify(['dead-code', location(range)])).slice(0, 16), existing = marks.find(value => value.id === id);
      if (existing) {
        if (location(existing.source) !== location(range) || existing.source.sha256 !== range.sha256 || existing.fileSha256 !== file.sha256 || existing.why !== why.trim() || existing.evidence !== evidence.trim()) fail('Existing declaration differs. Review, remove and add it again; hashes are never silently refreshed.');
        return { changed: false, mark: existing };
      }
      const mark = { id, source: range, fileSha256: file.sha256, why: why.trim(), evidence: evidence.trim() };
      data.deadCode = [...marks, mark].sort((a, b) => compare(a.id, b.id));
      return { changed: true, mark };
    });
  }
  undeadCode(id) {
    if (typeof id !== 'string' || !id) fail('undead-code requires an exact id.');
    return this.mutate(data => {
      const marks = data.deadCode ?? [], matches = marks.filter(mark => mark?.id === id);
      if (matches.length !== 1) fail(`Unknown or duplicate dead-code id: ${id}`);
      data.deadCode = marks.filter(mark => mark?.id !== id); return { changed: true, id };
    });
  }
  deadCodeProgress(data, state, commentsByFile, ignoredSources, minimumTraces) {
    const dead = this.inspectDeadCode(data, state), marked = new Map();
    for (const { mark, errors } of dead) {
      if (errors.length || ignoredSources.some(rule => matchesIgnored(mark.source.path, rule.path))) continue;
      let set = marked.get(mark.source.path); if (!set) { set = new Set(); marked.set(mark.source.path, set); }
      const lines = state.files.get(mark.source.path), comments = commentsByFile.get(mark.source.path) ?? [];
      for (let n = mark.source.start; n <= mark.source.end; n++) if (lines[n - 1].trim() && !comments.some(c => n >= c.source.start && n <= c.source.end)) set.add(n);
    }
    let whole = 0;
    for (const [path, lines] of state.files) {
      if (ignoredSources.some(rule => matchesIgnored(path, rule.path))) continue;
      whole += countIntervals([], 1, lines.length, minimumTraces, lines, commentsByFile.get(path) ?? []).lines;
    }
    const deadLines = [...marked.values()].reduce((sum, set) => sum + set.size, 0);
    return { lines: deadLines, denominator: whole, percent: whole ? deadLines * 100 / whole : null,
      marks: dead.filter(row => !row.errors.length).map(row => row.mark), invalid: dead.filter(row => row.errors.length),
      notice: 'Declared dead code requires review; it is not deleted or excluded from mapping and is not proof of unreachability.' };

  }
}

const IGNORE_NOTICE = 'Project ignores exclude files only from manual mapping totals and minimum thresholds, not from tests, link integrity or measured evidence. An empty included scope is not full coverage.';
function ignoredPath(path) {
  if (typeof path !== 'string') fail('Ignore path must be a repository-relative file or directory.');
  const plain = safePath(path.endsWith('/') ? path.slice(0, -1) : path);
  if (plain.split('/').includes('.git') || /[*?\[\]]/.test(plain)) fail('Ignore paths cannot target .git or use glob patterns.');
  return path;
}
function validateIgnoredSources(data) {
  if (!Object.hasOwn(data, 'ignoredSources')) return;
  if (!Array.isArray(data.ignoredSources)) fail('Expected ignoredSources to be an array.');
  const paths = new Set();
  for (const rule of data.ignoredSources) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) fail('Invalid ignoredSources rule.');
    const path = ignoredPath(rule.path);
    if (paths.has(path)) fail(`Duplicate ignoredSources path: ${path}`);
    if (typeof rule.why !== 'string' || !rule.why.trim() || rule.why !== rule.why.trim() || /[\x00-\x1f\x7f]/.test(rule.why)) fail(`Invalid ignoredSources reason: ${path}`);
    paths.add(path);
  }
}
function matchesIgnored(path, rule) { return rule.endsWith('/') ? path.startsWith(rule) : path === rule; }
function ignoredScope(data, state) {
  return (data.ignoredSources ?? []).map(rule => ({ ...rule, matchedFiles: [...state.files.keys()].filter(path => matchesIgnored(path, rule.path)).length }));
}
