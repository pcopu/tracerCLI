import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve, sep } from 'node:path';

export const VERSION = '0.1.2';
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

export class Tracer {
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
    const lines = state.files.get(range.path) ?? (step && state.candidates.has(range.path) ? this.readLines(range.path) : undefined);
    if (!lines) fail(`File is outside the current ${step ? 'eligible repository text files' : 'source inventory'}: ${range.path}`);
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
        || range.start < 1 || range.end < range.start || range.end > lines.length) {
      fail(`Invalid range ${location(range)}; file has ${lines.length} lines.`);
    }
    return { path: range.path, start: range.start, end: range.end, sha256: digest(lines.slice(range.start - 1, range.end).join('')) };
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
  readMap() {
    this.validateMapPath();
    if (!existsSync(this.mapPath)) return { version: 1, links: [] };
    const data = JSON.parse(readFileSync(this.mapPath, 'utf8'));
    if (!data || data.version !== 1 || !Array.isArray(data.links)) fail('Expected sidecar version 1 and links array.');
    validateMinimum(Object.hasOwn(data, 'minimumTraces') ? data.minimumTraces : 1);
    return data;
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
        writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
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
  config(minimumTraces) {
    if (minimumTraces === undefined) return { minimumTraces: this.readMap().minimumTraces ?? 1 };
    validateMinimum(minimumTraces);
    this.mutate(data => { data.minimumTraces = minimumTraces; return { changed: true }; });
    return { minimumTraces };
  }
  check({ requireMinimum = false, minimumTraces } = {}) {
    const inspected = this.inspect(this.readMap(), this.inventory());
    const invalid = inspected.filter(row => row.errors.length);
    const result = { kind: 'manual-link-integrity', notice: NOTICE, total: inspected.length,
      valid: inspected.length - invalid.length, invalid };
    if (requireMinimum) {
      const report = this.report(undefined, { minimumTraces });
      result.minimumTraces = report.minimumTraces; result.belowMinimum = report.totals.belowMinimum;
    }
    return result;
  }
  report(query, { minimumTraces } = {}) {
    const state = this.inventory(), data = this.readMap(), inspected = this.inspect(data, state);
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
    const matches = link => {
      if (!query || sourceFilter) return true;
      if (query.kind === 'action') return link.actions.includes(query.value);
      if (query.kind === 'sequence') return JSON.stringify(link.actions) === JSON.stringify(query.value);
      return link.step?.path === stepFilter.path && (!stepFilter.start
        || link.step.end >= stepFilter.start && link.step.start <= stepFilter.end);
    };
    const valid = inspected.filter(row => !row.errors.length).map(row => row.link).filter(matches);
    const files = [], totals = { files: 0, lines: 0, linked: 0, withStep: 0, unlinked: 0, belowMinimum: 0 };
    const traceKey = link => JSON.stringify(link.actions);
    for (const [path, lines] of state.files) {
      if (sourceFilter && sourceFilter.path !== path) continue;
      if (query && !sourceFilter && !valid.some(link => link.source.path === path)) continue;
      const start = sourceFilter?.start ?? 1, end = sourceFilter?.end ?? lines.length;
      const links = valid.filter(link => link.source.path === path && link.source.end >= start && link.source.start <= end);
      const linked = [], unlinked = [], withStep = [], traceCounts = [], belowMinimum = [];
      for (let line = start; line <= end; line++) {
        const atLine = links.filter(link => link.source.start <= line && line <= link.source.end);
        const count = new Set(atLine.map(traceKey)).size;
        const withStepCount = new Set(atLine.filter(link => link.step).map(traceKey)).size;
        (count ? linked : unlinked).push(line);
        if (withStepCount) withStep.push(line);
        if (count < minimumTraces) belowMinimum.push(line);
        const last = traceCounts.at(-1);
        if (last && last.count === count && last.withStepCount === withStepCount) last.end = line;
        else traceCounts.push({ start: line, end: line, count, withStepCount });
      }
      files.push({ path, start, end, lines: linked.length + unlinked.length, linked: linked.length,
        withStep: withStep.length, unlinked: unlinked.length, linkedRanges: compactRanges(linked),
        unlinkedRanges: compactRanges(unlinked), traceCounts, belowMinimum: belowMinimum.length,
        belowMinimumRanges: compactRanges(belowMinimum), links });
      totals.files++; totals.lines += linked.length + unlinked.length; totals.linked += linked.length;
      totals.withStep += withStep.length; totals.unlinked += unlinked.length; totals.belowMinimum += belowMinimum.length;
    }
    return { kind: 'manual-links', notice: NOTICE, minimumTraces, traceIdentity: 'exact-ordered-action-sequence', query: query ?? null, totals, files,
      excluded: state.excluded, invalid: inspected.filter(row => row.errors.length) };
  }
}
