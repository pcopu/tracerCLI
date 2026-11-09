// Fixture construction only. All product behavior is driven through CLI subprocesses.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

export const REPOSITORY = fileURLToPath(new URL('../../..', import.meta.url));
const CLI = join(REPOSITORY, 'bin/tracer.mjs');
const PRELOAD = fileURLToPath(new URL('./preload.mjs', import.meta.url));
const API = 'https://api.github.com/repos/pcopu/tracerCLI';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const gitHash = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');

export function releaseFixture(version = '0.2.0', extra = {}) {
  const pkg = { name: '@pcopu/tracercli', version, type: 'module', repository: { url: 'https://github.com/pcopu/tracerCLI.git' }, bin: { tracer: 'bin/tracer.mjs' }, scripts: { test: 'node --test' }, ...extra.package };
  const files = {
    'package.json': JSON.stringify(pkg),
    'bin/tracer.mjs': readFileSync(CLI, 'utf8'),
    'skills/tracer/SKILL.md': `# Tracer ${version}\nMaintain manual source links.\n`,
    'docs/updates.md': '# Synthetic update journey documentation\n',
  };
  for (const name of readdirSync(join(REPOSITORY, 'src')).filter(name => name.endsWith('.mjs'))) {
    files[`src/${name}`] = readFileSync(join(REPOSITORY, 'src', name), 'utf8');
  }
  files['src/tracer.mjs'] = files['src/tracer.mjs'].replace(/export const VERSION = '[^']+'/, `export const VERSION = '${version}'`);
  Object.assign(files, extra.files);
  const objects = new Map(), directories = new Map([['', []]]);
  for (const [path, content] of Object.entries(files)) {
    const bytes = Buffer.from(content), sha = gitHash('blob', bytes), slash = path.lastIndexOf('/'), parent = slash < 0 ? '' : path.slice(0, slash);
    objects.set(sha, { sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') });
    let directory = parent;
    while (directory) {
      if (!directories.has(directory)) directories.set(directory, []);
      const at = directory.lastIndexOf('/'); directory = at < 0 ? '' : directory.slice(0, at);
    }
    directories.get(parent).push({ path, mode: extra.modes?.[path] ?? '100644', type: 'blob', sha, size: bytes.length });
  }
  const tree = []; let rootSHA;
  for (const directory of [...directories.keys()].sort((a, b) => b.split('/').length - a.split('/').length || b.length - a.length)) {
    const entries = directories.get(directory).sort((a, b) => Buffer.compare(Buffer.from(a.path.split('/').at(-1) + (a.type === 'tree' ? '/' : '')), Buffer.from(b.path.split('/').at(-1) + (b.type === 'tree' ? '/' : ''))));
    const bytes = Buffer.concat(entries.flatMap(entry => [Buffer.from(`${entry.mode.replace(/^0+/, '')} ${entry.path.split('/').at(-1)}\0`), Buffer.from(entry.sha, 'hex')]));
    const sha = gitHash('tree', bytes); tree.push(...entries);
    if (!directory) rootSHA = sha;
    else {
      const slash = directory.lastIndexOf('/'), parent = slash < 0 ? '' : directory.slice(0, slash);
      directories.get(parent).push({ path: directory, mode: '040000', type: 'tree', sha });
    }
  }
  const commit = gitHash('commit', Buffer.from(`tree ${rootSHA}\nauthor Tracer <test@example.invalid> 0 +0000\ncommitter Tracer <test@example.invalid> 0 +0000\n\nSynthetic CLI journey release.\n`));
  const packageBlob = objects.get(tree.find(entry => entry.path === 'package.json').sha);
  const routes = {
    '/releases/latest': { tag_name: `v${version}`, prerelease: false, draft: false },
    [`/releases/tags/v${version}`]: { tag_name: `v${version}`, prerelease: false, draft: false },
    [`/git/ref/tags/v${version}`]: { object: { type: 'commit', sha: commit } },
    '/git/ref/heads/main': { object: { type: 'commit', sha: commit } },
    [`/git/commits/${commit}`]: { sha: commit, tree: { sha: rootSHA } },
    [`/git/trees/${rootSHA}?recursive=1`]: { sha: rootSHA, truncated: false, tree },
    [`/contents/package.json?ref=${commit}`]: { ...packageBlob, type: 'file' },
  };
  for (const [sha, blob] of objects) routes[`/git/blobs/${sha}`] = blob;
  return { version, files, commit, tree, rootSHA, routes, package: pkg };
}
export function mainChannel(release) { delete release.routes['/releases/latest']; return release; }

export function journey(t, release = releaseFixture()) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tracer-update-e2e-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'project'), home = join(dir, 'home');
  mkdirSync(root); mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const dataFile = join(dir, 'github-fixture.json'), managedHome = join(home, '.local/share/tracer');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'),
    CI: '', TRACER_NO_UPDATE: '1', NODE_OPTIONS: '', TRACER_E2E_UPDATE_FIXTURE: dataFile };
  const put = (path, bytes) => { const full = join(root, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, bytes); return full; };
  put('src/example.mjs', 'export const answer = 42;\n');
  put('app.mjs', `const args = process.argv.slice(2); console.log(JSON.stringify({ args, cwd: process.cwd() }));\n`);
  let data = { routes: release.routes, now: 100000000 };
  const save = () => writeFileSync(dataFile, JSON.stringify(data));
  save();
  const run = (args, options = {}) => spawnSync(process.execPath,
    ['--import', PRELOAD, options.managed ? join(managedHome, 'bin/tracer') : CLI, ...args],
    { cwd: root, encoding: 'utf8', env: { ...env, ...options.env }, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  const ok = (args, options) => {
    const result = run(args, options); assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}\n${result.stdout}`); return result;
  };
  const bad = (args, expected, options) => {
    const result = run(args, options); assert.equal(result.error, undefined, String(result.error));
    assert.notEqual(result.status, 0, `${args.join(' ')} unexpectedly succeeded: ${result.stdout}`);
    if (expected) assert.match(result.stderr, expected); return result;
  };
  const output = (args, options) => JSON.parse(ok(args, options).stdout);
  const requests = () => existsSync(`${dataFile}.requests`) ? readFileSync(`${dataFile}.requests`, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return {
    dir, root, home, managedHome, env, put, run, ok, bad, output, requests,
    sourceRelease: release,
    use: (next, changes = {}) => { data = { routes: next.routes, now: data.now, ...changes }; save(); },
    transport: changes => { Object.assign(data, changes); save(); },
    init: (extra = []) => ok(['init', '--app-json', JSON.stringify([process.execPath, 'app.mjs']), ...extra]),
    install: (extra = []) => output(['update', '--install-managed', ...extra, '--json']),
    status: options => output(['update', '--status', '--json'], options),
    active: () => JSON.parse(readFileSync(join(managedHome, 'active.json'), 'utf8')),
    settings: () => JSON.parse(readFileSync(join(managedHome, 'settings.json'), 'utf8')),
    skill: agent => join(home, agent === 'codex' ? '.codex' : '.claude', 'skills/tracer/SKILL.md'),
  };
}
export function assertOfficialRequests(f) {
  for (const request of f.requests()) {
    assert.ok(request.url.startsWith(`${API}/`)); assert.equal(request.method, 'GET');
  }
}
