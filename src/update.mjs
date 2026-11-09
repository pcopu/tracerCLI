/**
 * Opt-in, per-user updates from the official public GitHub repository.
 * No shell, npm, fetched install scripts, credentials, project writes or daemons.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OFFICIAL_REPOSITORY = 'pcopu/tracerCLI';
const API = `https://api.github.com/repos/${OFFICIAL_REPOSITORY}`;
const LOCAL_ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_FILE = 1024 * 1024, MAX_TOTAL = 8 * MAX_FILE, MAX_FILES = 80;
const SHA = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_ID = /^\d+\.\d+\.\d+-[a-f0-9]{40}$/;
const AUTO_MODES = ['off', 'check', 'apply'];
const DEFAULT_INTERVAL = 24 * 60 * 60 * 1000;
const fail = message => { throw new Error(message); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const gitBlobHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const json = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const cleanError = error => String(error?.message ?? error).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);

export function updateHome(options = {}) {
  return resolve(options.updateHome ?? join(options.home ?? homedir(), '.local', 'share', 'tracer'));
}
function guard(path, type = 'directory') {
  const absolute = resolve(path), root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let stat;
    try { stat = lstatSync(current); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (stat.isSymbolicLink() || realpathSync(current) !== current ||
        (i === parts.length - 1 && type === 'file' ? !stat.isFile() : !stat.isDirectory())) {
      fail(`Update paths must be regular and unsymlinked: ${current}`);
    }
  }
  return absolute;
}
function readJSON(path, fallback) {
  guard(path, 'file');
  if (!existsSync(path)) return fallback;
  if (lstatSync(path).size > MAX_FILE) fail(`Update metadata is too large: ${path}`);
  try { return json(readFileSync(path)); } catch { fail(`Invalid update metadata: ${path}`); }
}
function atomicWrite(path, bytes, mode = 0o600) {
  guard(path, 'file'); guard(dirname(path));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.tracer-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), mode);
    writeFileSync(fd, bytes); closeSync(fd); fd = undefined;
    guard(path, 'file'); renameSync(temp, path);
  } finally { if (fd !== undefined) closeSync(fd); if (existsSync(temp)) rmSync(temp); }
}
function writeJSON(path, value) { atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`); }
function defaultSettings() { return { schemaVersion: 1, auto: 'off', lastCheckAt: null, lastResult: null, skills: [] }; }
function readSettings(options) {
  const data = readJSON(join(updateHome(options), 'settings.json'), defaultSettings());
  if (data?.schemaVersion !== 1 || !AUTO_MODES.includes(data.auto) || !Array.isArray(data.skills) || data.skills.length > 32 ||
      !(data.lastCheckAt === null || Number.isSafeInteger(data.lastCheckAt) && data.lastCheckAt >= 0)) fail('Invalid update settings; no files changed.');
  for (const skill of data.skills) {
    if (typeof skill?.path !== 'string' || !isAbsolute(skill.path) || resolve(skill.path) !== skill.path || !skill.path.endsWith(`${sep}tracer${sep}SKILL.md`) || !HASH.test(skill.sha256) || !SEMVER.test(skill.version)) fail('Invalid registered skill metadata; no files changed.');
  }
  return data;
}
function lock(options) {
  const home = guard(updateHome(options));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, '.update-lock');
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') fail(`Another update is running, or an interrupted update left ${path}. See docs/updates.md before removing a stale lock.`); throw error; }
  try { writeJSON(join(path, 'owner.json'), { pid: process.pid, startedAt: new Date().toISOString() }); }
  catch (error) { rmSync(path, { recursive: true }); throw error; }
  return () => rmSync(path, { recursive: true });
}
function activeState(options) {
  const active = readJSON(join(updateHome(options), 'active.json'), null);
  if (active === null) return null;
  if (active?.schemaVersion !== 1 || !RELEASE_ID.test(active.current) ||
      !(active.previous === null || RELEASE_ID.test(active.previous))) fail('Invalid managed installation pointer.');
  return active;
}
function currentVersion(options) {
  if (options.currentVersion !== undefined) {
    if (!SEMVER.test(options.currentVersion)) fail('Current version must be a stable numeric version.');
    return options.currentVersion;
  }
  const data = readJSON(join(options.installRoot ?? LOCAL_ROOT, 'package.json'), null);
  if (!SEMVER.test(data?.version)) fail('Cannot determine the current Tracer version.');
  return data.version;
}
function isNewer(a, b) {
  const av = a.split('.').map(BigInt), bv = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) { if (av[i] !== bv[i]) return av[i] > bv[i]; }
  return false;
}
function runtimePath(path) {
  return path === 'package.json' || path === 'README.md' || path === 'skills/tracer/SKILL.md' ||
    /^(bin|src)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(mjs|js|json)$/.test(path) ||
    /^docs\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(md|json)$/.test(path);
}
function safeRelative(path) {
  return typeof path === 'string' && path.length <= 240 && !path.startsWith('/') &&
    !path.includes('\\') && !path.split('/').some(part => !part || part === '.' || part === '..') &&
    !/[\u0000-\u001f\u007f:]/.test(path);
}

// The fetch seam is for offline tests/embedders only. CLI never accepts a server URL.
function client(options = {}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  return async path => {
    if (!path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.')) fail('Invalid GitHub API request.');
    const response = await fetcher(`${API}${path}`, {
      method: 'GET', redirect: 'error', credentials: 'omit',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'tracercli-updater' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
    });
    if (response.status === 404) return null;
    if (!response.ok) fail(`GitHub update request failed (${response.status}); no credentials are requested.`);
    if (response.url && !response.url.startsWith(`${API}/`)) fail('GitHub update response changed origin or repository.');
    const declared = Number(response.headers?.get?.('content-length'));
    if (declared > 2 * MAX_TOTAL) fail('GitHub update response is too large.');
    let bytes;
    if (response.body?.getReader) {
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 2 * MAX_TOTAL) { await reader.cancel(); fail('GitHub update response is too large.'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      bytes = Buffer.concat(chunks);
    } else { bytes = Buffer.from(await response.text()); if (bytes.length > 2 * MAX_TOTAL) fail('GitHub update response is too large.'); }
    try { return json(bytes); } catch { fail('GitHub returned invalid JSON.'); }
  };
}
async function resolveTag(tag, request) {
  let object = (await request(`/git/ref/tags/${encodeURIComponent(tag)}`))?.object;
  for (let depth = 0; depth < 5; depth++) {
    if (!object || !SHA.test(object.sha)) fail('Release tag has no valid immutable commit.');
    if (object.type === 'commit') return object.sha;
    if (object.type !== 'tag') fail('Release tag does not identify a commit.');
    const tagged = await request(`/git/tags/${object.sha}`);
    if (tagged?.sha !== object.sha) fail('Annotated tag checksum identity mismatch.');
    object = tagged.object;
  }
  fail('Release tag chain is too deep.');
}
async function packageAt(commit, request) {
  const item = await request(`/contents/package.json?ref=${commit}`);
  if (!item || item.type !== 'file') fail('Pinned commit has no package.json.');
  return json(decodeBlob(item));
}
function decodeBlob(item, expected) {
  if (!item || !SHA.test(item.sha) || item.encoding !== 'base64' || typeof item.content !== 'string' ||
      !Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_FILE) fail('Invalid or oversized GitHub source blob.');
  const encoded = item.content.replace(/\n/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail('Invalid source blob encoding.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== item.size || gitBlobHash(bytes) !== item.sha || expected && (item.sha !== expected.sha || item.size !== expected.size)) fail('Git source blob checksum mismatch.');
  return bytes;
}
function validatePackage(pkg, expectedVersion) {
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (pkg.name !== '@pcopu/tracercli' || !SEMVER.test(pkg.version) || expectedVersion && pkg.version !== expectedVersion ||
      ![`https://github.com/${OFFICIAL_REPOSITORY}.git`, `https://github.com/${OFFICIAL_REPOSITORY}`].includes(repository)) fail('Source package identity or release version does not match the official repository.');
  if (pkg.type !== 'module' || pkg.bin?.tracer !== 'bin/tracer.mjs' ||
      ['dependencies', 'optionalDependencies', 'peerDependencies'].some(key => Object.keys(pkg[key] ?? {}).length)) fail('Managed updates require the dependency-free Tracer package layout.');
  // No lifecycle execution is performed, and future lifecycle-based releases fail closed.
  if (['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly'].some(key => Object.hasOwn(pkg.scripts ?? {}, key))) fail('Managed updates reject package lifecycle hooks.');
}

/** Network-only inspection. No installation, settings writes or fetched execution. */
export async function checkForUpdate(options = {}) {
  if (options.version !== undefined && options.commit !== undefined) fail('Choose either an exact version or an exact commit, not both.');
  const current = currentVersion(options), request = client(options);
  let version, commit, tag = null, channel = 'release';
  if (options.commit !== undefined) {
    if (!SHA.test(options.commit)) fail('Commit must be a full, lowercase 40-character Git commit hash.');
    commit = options.commit; channel = 'commit';
    const source = await request(`/git/commits/${commit}`);
    if (source?.sha !== commit || !SHA.test(source.tree?.sha)) fail('Pinned commit was not found in the official repository.');
    const pkg = await packageAt(commit, request); validatePackage(pkg); version = pkg.version;
  } else {
    if (options.version !== undefined && !SEMVER.test(options.version)) fail('Version must be an exact stable version, such as 1.2.3.');
    const release = await request(options.version ? `/releases/tags/v${options.version}` : '/releases/latest');
    if (!release) {
      if (options.version) return { status: 'unavailable', repository: OFFICIAL_REPOSITORY, currentVersion: current, message: 'No matching stable GitHub release exists. Select an existing version or an explicitly reviewed full commit.' };
      // Bootstrap before the project's first release: official main, pinned immediately.
      const ref = await request('/git/ref/heads/main');
      if (ref?.object?.type !== 'commit' || !SHA.test(ref.object.sha)) return { status: 'unavailable', repository: OFFICIAL_REPOSITORY, currentVersion: current, message: 'No stable GitHub release or official main commit is available yet.' };
      commit = ref.object.sha; channel = 'main';
      const pkg = await packageAt(commit, request); validatePackage(pkg); version = pkg.version;
    } else {
      if (release.draft || release.prerelease || typeof release.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) fail('Only stable, v-prefixed official release tags are supported.');
      tag = release.tag_name; version = tag.slice(1);
      if (!SEMVER.test(version) || options.version && version !== options.version) fail('GitHub release version mismatch.');
      commit = await resolveTag(tag, request);
      const pkg = await packageAt(commit, request); validatePackage(pkg, version);
    }
  }
  const active = activeState(options);
  const changedMain = channel === 'main' && active && !active.current.endsWith(`-${commit}`) && version === current;
  return {
    status: isNewer(version, current) || changedMain ? 'available' : version === current ? 'current' : 'older',
    repository: OFFICIAL_REPOSITORY, currentVersion: current, version, commit, tag, channel,
    url: `https://github.com/${OFFICIAL_REPOSITORY}/commit/${commit}`,
    verification: 'Official GitHub HTTPS provenance, immutable commit and Git blob checksums; not an independent publisher signature.',
  };
}
// Reconstruct every tree object, not just trust the API's claimed tree ID.
// Git hashes filenames in byte order, treating a directory as name + '/'.
function verifyTree(tree) {
  if (tree.tree.length > 10000) fail('GitHub source tree has too many entries.');
  const directories = new Map([['', { sha: tree.sha, entries: [] }]]), seen = new Set();
  for (const entry of tree.tree) {
    if (!safeRelative(entry.path) || seen.has(entry.path) || !SHA.test(entry.sha) ||
        !(['100644', '100755', '120000'].includes(entry.mode) && entry.type === 'blob' || entry.mode === '040000' && entry.type === 'tree' || entry.mode === '160000' && entry.type === 'commit')) fail('Unsafe or malformed Git source tree.');
    seen.add(entry.path);
    if (entry.type === 'tree') directories.set(entry.path, { sha: entry.sha, entries: [] });
  }
  for (const entry of tree.tree) {
    const slash = entry.path.lastIndexOf('/'), parent = slash < 0 ? '' : entry.path.slice(0, slash);
    if (!directories.has(parent)) fail('Incomplete Git source tree.');
    directories.get(parent).entries.push({ ...entry, name: entry.path.slice(slash + 1) });
  }
  for (const directory of directories.values()) {
    const ordered = directory.entries.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.type === 'tree' ? '/' : '')), Buffer.from(b.name + (b.type === 'tree' ? '/' : ''))));
    const bytes = Buffer.concat(ordered.flatMap(entry => [Buffer.from(`${entry.mode.replace(/^0+/, '')} ${entry.name}\0`), Buffer.from(entry.sha, 'hex')]));
    const digest = createHash('sha1').update(`tree ${bytes.length}\0`).update(bytes).digest('hex');
    if (digest !== directory.sha) fail('Git source tree checksum mismatch.');
  }
}

async function fetchRelease(candidate, options) {
  const request = client(options), commit = await request(`/git/commits/${candidate.commit}`);
  if (commit?.sha !== candidate.commit || !SHA.test(commit.tree?.sha)) fail('GitHub commit identity mismatch.');
  const tree = await request(`/git/trees/${commit.tree.sha}?recursive=1`);
  if (tree?.sha !== commit.tree.sha || tree.truncated || !Array.isArray(tree.tree)) fail('Incomplete or mismatched GitHub source tree.');
  verifyTree(tree);
  const entries = tree.tree.filter(item => runtimePath(item.path));
  if (!entries.length || entries.length > MAX_FILES) fail('Release has an unsupported number of runtime files.');
  const seen = new Set(); let total = 0;
  for (const entry of entries) {
    if (!safeRelative(entry.path) || seen.has(entry.path.toLowerCase()) || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) ||
        !SHA.test(entry.sha) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE) fail('Release contains an unsafe, duplicate, symlinked or oversized runtime entry.');
    seen.add(entry.path.toLowerCase()); total += entry.size;
  }
  if (total > MAX_TOTAL || !['package.json', 'bin/tracer.mjs', 'src/tracer.mjs', 'skills/tracer/SKILL.md'].every(path => entries.some(entry => entry.path === path))) fail('Release runtime is incomplete or too large.');
  const files = [];
  for (const entry of entries) {
    const bytes = decodeBlob(await request(`/git/blobs/${entry.sha}`), entry);
    files.push({ path: entry.path, bytes, sha256: sha256(bytes), gitBlob: entry.sha });
  }
  validatePackage(json(files.find(file => file.path === 'package.json').bytes), candidate.version);
  return files;
}
function manifestAt(path) {
  const manifest = readJSON(join(path, '.tracer-release.json'), null);
  if (manifest?.schemaVersion !== 1 || manifest.repository !== OFFICIAL_REPOSITORY || !SHA.test(manifest.commit) || !SEMVER.test(manifest.version) ||
      !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES || manifest.files.length < 4) fail('Invalid managed release manifest.');
  const paths = new Set();
  for (const file of manifest.files) {
    if (!safeRelative(file.path) || !runtimePath(file.path) || paths.has(file.path.toLowerCase()) || !HASH.test(file.sha256) || !SHA.test(file.gitBlob)) fail('Invalid managed release file record.');
    paths.add(file.path.toLowerCase());
  }
  if (!['package.json', 'bin/tracer.mjs', 'src/tracer.mjs', 'skills/tracer/SKILL.md'].every(file => manifest.files.some(entry => entry.path === file))) fail('Managed release manifest is incomplete.');
  return manifest;
}
function verifyRelease(path, expectedId) {
  guard(path);
  const manifest = manifestAt(path);
  if (`${manifest.version}-${manifest.commit}` !== expectedId) fail('Managed release directory identity mismatch.');
  const expected = new Set(manifest.files.map(file => file.path));
  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`, full = join(dir, entry.name);
      if (entry.isSymbolicLink()) fail('Managed installation contains a symlink; preserved without updating.');
      if (entry.isDirectory()) walk(full, `${relative}/`);
      else if (!entry.isFile() || relative !== '.tracer-release.json' && !expected.has(relative)) fail('Managed installation has unrecognized files; preserved without updating.');
    }
  };
  walk(path);
  for (const file of manifest.files) {
    const full = guard(join(path, file.path), 'file');
    if (!existsSync(full) || lstatSync(full).size > MAX_FILE || sha256(readFileSync(full)) !== file.sha256) fail(`Managed file changed or is missing; preserved without updating: ${file.path}`);
  }
  return manifest;
}
// This stable launcher executes only on the user's NEXT invocation, never during update.
function launcherText() {
  return `#!/usr/bin/env node\n'use strict';\n(async () => {\n  const fs = await import('node:fs');\n  const path = await import('node:path');\n  const { pathToFileURL } = await import('node:url');\n  const home = path.resolve(path.dirname(fs.realpathSync(process.argv[1])), '..');\n  const pointer = path.join(home, 'active.json');\n  if (fs.lstatSync(pointer).isSymbolicLink()) throw new Error('Unsafe Tracer update pointer.');\n  const state = JSON.parse(fs.readFileSync(pointer, 'utf8'));\n  if (state.schemaVersion !== 1 || !/^\\d+\\.\\d+\\.\\d+-[a-f0-9]{40}$/.test(state.current)) throw new Error('Invalid Tracer update pointer.');\n  const entry = path.join(home, 'releases', state.current, 'bin', 'tracer.mjs');\n  if (fs.realpathSync(entry) !== entry || !fs.lstatSync(entry).isFile()) throw new Error('Unsafe Tracer release path.');\n  await import(pathToFileURL(entry).href);\n})().catch(error => { console.error('Tracer: ' + error.message); process.exitCode = 1; });\n`;
}
function ensureLauncher(options) {
  const path = join(updateHome(options), 'bin', 'tracer');
  guard(path, 'file');
  const content = launcherText();
  if (existsSync(path) && readFileSync(path, 'utf8') !== content) fail('Managed launcher was edited; preserved without updating.');
  if (!existsSync(path)) atomicWrite(path, content, 0o755);
  return path;
}
function runningManaged(options, active) {
  return !!active && resolve(options.installRoot ?? LOCAL_ROOT) === join(updateHome(options), 'releases', active.current);
}

/** Persist opt-in behavior. No network, shell configuration or scheduler changes. */
export function configureUpdates(mode, options = {}) {
  if (!AUTO_MODES.includes(mode)) fail('Update mode must be off, check or apply.');
  const release = lock(options);
  try { const data = readSettings(options); data.auto = mode; writeJSON(join(updateHome(options), 'settings.json'), data); }
  finally { release(); }
  return updateStatus(options);
}
/** Local-only, read-only status. */
export function updateStatus(options = {}) {
  const settings = readSettings(options), active = activeState(options);
  return {
    repository: OFFICIAL_REPOSITORY, currentVersion: currentVersion(options), home: updateHome(options),
    auto: settings.auto, lastCheckAt: settings.lastCheckAt, lastResult: settings.lastResult,
    managed: !!active, runningManaged: runningManaged(options, active), current: active?.current ?? null, previous: active?.previous ?? null,
    launcher: active ? join(updateHome(options), 'bin', 'tracer') : null,
    registeredSkills: settings.skills.map(skill => ({ path: skill.path, version: skill.version })),
  };
}

/**
 * Explicit managed install/update. Never modifies the invoking npm/Git checkout.
 * Existing managed runtime modifications are preserved by refusing replacement.
 */
export async function updateCLI(options = {}) {
  const before = activeState(options);
  if (!before && !options.installManaged) return { status: 'unmanaged', message: 'This installation is not managed. Use tracer update --install-managed to create a separate per-user launcher; the npm/Git installation is left unchanged.' };
  if (options.automatic && !runningManaged(options, before)) return { status: 'unmanaged', message: 'Automatic application is limited to the managed launcher. Run the managed launcher, or update your existing npm/Git installation explicitly.' };
  const releaseLock = lock(options); let staging;
  try {
    const active = activeState(options), home = updateHome(options);
    const installed = active ? verifyRelease(join(home, 'releases', active.current), active.current) : null;
    const candidate = await checkForUpdate({ ...options, currentVersion: installed?.version ?? currentVersion(options) });
    if (!candidate.commit) return candidate;
    if (candidate.status === 'older') fail('Downgrades are refused. Use the local --rollback command to select a previously installed version.');
    const id = `${candidate.version}-${candidate.commit}`;
    if (active?.current === id) return { ...candidate, status: 'current', launcher: join(home, 'bin', 'tracer'), skills: [] };
    // Same-version release retags need an explicit pin. Before the first release,
    // main may advance at the same package version, with ancestry required for auto apply.
    if (active && candidate.version === active.current.split('-')[0] && !options.commit && candidate.channel !== 'main') {
      return { ...candidate, status: 'current', message: 'A same-version release cannot replace the current installation. Publish a newer version, or explicitly review and pin a commit.' };
    }
    if (active && options.automatic) {
      const previousCommit = active.current.slice(active.current.lastIndexOf('-') + 1);
      const comparison = await client(options)(`/compare/${previousCommit}...${candidate.commit}`);
      if (comparison?.status !== 'ahead' || comparison.base_commit?.sha !== previousCommit || comparison.merge_base_commit?.sha !== previousCommit) {
        fail('Automatic update requires the new official commit to descend from the installed commit. Review divergent history and use an explicit update.');
      }
    }
    const files = await fetchRelease(candidate, options);
    const releases = guard(join(home, 'releases')); mkdirSync(releases, { recursive: true, mode: 0o700 });
    const destination = join(releases, id);
    if (existsSync(destination)) verifyRelease(destination, id);
    else {
      staging = join(releases, `.stage-${randomUUID()}`); mkdirSync(staging, { mode: 0o700 });
      for (const file of files) atomicWrite(join(staging, file.path), file.bytes, file.path.startsWith('bin/') ? 0o755 : 0o644);
      writeJSON(join(staging, '.tracer-release.json'), {
        schemaVersion: 1, repository: OFFICIAL_REPOSITORY, version: candidate.version, commit: candidate.commit, tag: candidate.tag,
        files: files.map(({ path, sha256, gitBlob }) => ({ path, sha256, gitBlob })),
      });
      verifyRelease(staging, id);
      renameSync(staging, destination); staging = undefined;
    }
    const launcher = ensureLauncher(options);
    // Last commit point: failure before this atomic rename leaves the old runtime active.
    writeJSON(join(home, 'active.json'), { schemaVersion: 1, current: id, previous: active?.current ?? null });
    let skills;
    try { skills = refreshSkillsUnlocked({ ...options, source: join(destination, 'skills/tracer/SKILL.md'), version: candidate.version }); }
    catch (error) { skills = [{ status: 'preserved', message: cleanError(error) }]; }
    return { ...candidate, status: 'updated', launcher, previous: active?.current ?? null, skills, message: 'Managed installation is ready. The new CLI runs on the next managed-launcher invocation; no downloaded code was executed during installation.' };
  } finally { if (staging && existsSync(staging)) rmSync(staging, { recursive: true }); releaseLock(); }
}
/** Local pointer rollback; leaves all versions and registered skills intact. */
export function rollbackUpdate(options = {}) {
  const release = lock(options);
  try {
    const active = activeState(options);
    if (!active?.previous) fail('No previous managed installation is available for rollback.');
    verifyRelease(join(updateHome(options), 'releases', active.previous), active.previous);
    ensureLauncher(options);
    writeJSON(join(updateHome(options), 'active.json'), { schemaVersion: 1, current: active.previous, previous: active.current });
    return { status: 'rolled-back', current: active.previous, previous: active.current, message: 'Managed CLI rolled back. Installed agent skills and project instructions were left unchanged.' };
  } finally { release(); }
}

/** Call ONLY immediately after an explicitly authorized installation of this skill. */
export function registerInstalledSkill(path, options = {}) {
  const version = options.version ?? currentVersion(options);
  if (!SEMVER.test(version) || !isAbsolute(path) || !path.endsWith(`${sep}tracer${sep}SKILL.md`)) fail('Register an absolute installed tracer/SKILL.md path and stable version.');
  path = guard(path, 'file');
  if (!existsSync(path) || lstatSync(path).size > MAX_FILE) fail('Installed Tracer skill is missing or too large.');
  const release = lock(options);
  try {
    const settings = readSettings(options);
    const hash = sha256(readFileSync(path)), existing = settings.skills.find(skill => skill.path === path);
    if (existing) {
      if (existing.sha256 !== hash) return { status: 'modified', path, message: 'Edited registered skill was preserved; its trusted checksum was not reset.' };
      return { status: 'registered', path };
    }
    if (settings.skills.length >= 32) fail('Too many registered skill locations.');
    settings.skills.push({ path, sha256: hash, version });
    writeJSON(join(updateHome(options), 'settings.json'), settings);
    return { status: 'registered', path };
  } finally { release(); }
}
function refreshSkillsUnlocked(options) {
  const settings = readSettings(options), source = guard(options.source, 'file');
  if (!SEMVER.test(options.version) || lstatSync(source).size > MAX_FILE) fail('Invalid replacement skill.');
  const bytes = readFileSync(source), hash = sha256(bytes), results = [];
  for (const record of settings.skills) {
    try {
      const path = guard(record.path, 'file');
      if (!existsSync(path)) { results.push({ path, status: 'missing' }); continue; }
      if (lstatSync(path).size > MAX_FILE || sha256(readFileSync(path)) !== record.sha256) { results.push({ path, status: 'modified', message: 'Local edits preserved; review and merge the bundled skill manually.' }); continue; }
      if (hash === record.sha256) { results.push({ path, status: 'current' }); continue; }
      const mode = lstatSync(path).mode & 0o777;
      atomicWrite(path, bytes, mode);
      record.sha256 = hash; record.version = options.version;
      results.push({ path, status: 'updated' });
    } catch (error) { results.push({ path: record.path, status: 'preserved', message: cleanError(error) }); }
  }
  // A failed metadata write is reported, not mistaken for a failed runtime swap.
  try { writeJSON(join(updateHome(options), 'settings.json'), settings); }
  catch (error) { results.push({ status: 'metadata-error', message: cleanError(error) }); }
  return results;
}
export function refreshRegisteredSkills(options = {}) {
  const release = lock(options);
  try { return refreshSkillsUnlocked(options); } finally { release(); }
}

/**
 * Throttled launch-time work, not a daemon. Call AFTER the requested command.
 * Deterministic/read-only commands always skip it. CLI should log errors to stderr,
 * never replace command output or exit status. Disabled by default and in CI.
 */
export async function maybeAutoUpdate(options = {}) {
  const env = options.env ?? process.env;
  if (env.TRACER_NO_UPDATE === '1' || env.CI || !['init', 'link', 'unlink', 'app', 'actions'].includes(options.command)) return { status: 'skipped' };
  let settings;
  try { settings = readSettings(options); } catch (error) { return { status: 'error', message: cleanError(error) }; }
  if (settings.auto === 'off') return { status: 'disabled' };
  const now = options.now ?? Date.now(), interval = options.intervalMs ?? DEFAULT_INTERVAL;
  if (settings.lastCheckAt !== null && now - settings.lastCheckAt < interval) return { status: 'throttled' };
  let release;
  try {
    release = lock(options);
    settings = readSettings(options);
    if (settings.auto === 'off') return { status: 'disabled' };
    if (settings.lastCheckAt !== null && now - settings.lastCheckAt < interval) return { status: 'throttled' };
    settings.lastCheckAt = now; writeJSON(join(updateHome(options), 'settings.json'), settings);
  } catch (error) { return { status: 'error', message: cleanError(error) }; }
  finally { if (release) { release(); release = undefined; } }
  let result;
  try {
    const active = activeState(options);
    result = settings.auto === 'apply' && runningManaged(options, active)
      ? await updateCLI({ ...options, automatic: true }) : await checkForUpdate(options);
    if (settings.auto === 'apply' && !runningManaged(options, active)) result = { ...result, autoApplySkipped: 'Unmanaged installation; only checked. Use the managed launcher for automatic application.' };
  } catch (error) { result = { status: 'error', message: cleanError(error) }; }
  try {
    release = lock(options); settings = readSettings(options);
    settings.lastResult = { status: result.status, version: result.version ?? null, commit: result.commit ?? null, message: result.message ?? null };
    writeJSON(join(updateHome(options), 'settings.json'), settings);
  } catch { /* Main command succeeds even when update metadata cannot be written. */ }
  finally { if (release) { release(); release = undefined; } }
  return result;
}
