import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = fileURLToPath(new URL('../../bin/tracer.mjs', import.meta.url));

test('self-host journey: discover Tracer project actions, delegate help, reject unknown journeys, inspect current manual map', () => {
  const run = (...args) => spawnSync(process.execPath, [cli, '--root', root, ...args], {
    encoding: 'utf8', env: { ...process.env, TRACER_NO_UPDATE: '1' },
  });
  const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }); assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
  const discovery = run('actions'); assert.equal(discovery.status, 0, discovery.stderr);
  const actions = JSON.parse(discovery.stdout);
  assert.equal(actions.application, 'tracercli-self-host');
  assert.ok(actions.actions.some(action => JSON.stringify(action.command) === '["test"]'));
  for (const group of ['scenarios', 'mapping', 'comments', 'ignore', 'measured', 'project', 'update', 'self-host']) {
    assert.ok(actions.actions.some(action => JSON.stringify(action.command) === JSON.stringify(['test', group])));
  }
  const help = run('app', '--', '--help'); assert.equal(help.status, 0); assert.match(help.stdout, /Run through Tracer/);
  assert.equal(run('app', '--', 'test', 'unknown-journey').status, 1);
  const check = run('check', '--json'); assert.equal(check.status, 0, check.stderr);
  const integrity = JSON.parse(check.stdout); assert.equal(integrity.valid, integrity.total); assert.deepEqual(integrity.invalid, []);
  const report = run('report', '--json'); assert.equal(report.status, 0);
  const mapping = JSON.parse(report.stdout); assert.equal(mapping.kind, 'manual-links'); assert.match(mapping.notice, /not observed execution/);
  assert.ok(mapping.files.some(file => file.path === 'bin/tracer.mjs'));
  for (const path of ['src/tracer.mjs', 'scripts/project-cli.mjs', 'package.json']) assert.ok(mapping.files.some(file => file.path === path));
  assert.equal(mapping.files.some(file => file.path.startsWith('tests/')), false);
  assert.ok(mapping.ignoredFiles.some(file => file.path.startsWith('tests/e2e/')));
  assert.deepEqual(integrity.ignoredFiles, mapping.ignoredFiles.map(file => file.path));
  assert.equal(integrity.ignoredSources.find(rule => rule.path === 'tests/').matchedFiles, mapping.ignoredTotals.files);
});

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

function runnerProject(t) {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'tracer-project-runner-')));
  const home = join(fixture, 'home'), project = join(fixture, 'project');
  mkdirSync(home); mkdirSync(project);
  const owned = new Set();
  t.after(() => {
    for (const pid of owned) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    rmSync(fixture, { recursive: true, force: true });
  });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'),
    NODE_OPTIONS: '', TRACER_NO_UPDATE: '1', FORCE_COLOR: '0' };
  // A nested public runner must not inherit the outer node:test worker's private IPC mode.
  delete env.NODE_TEST_CONTEXT;
  execFileSync('git', ['init', '-q'], { cwd: project, env });
  const put = (path, text) => {
    const target = join(project, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, text);
  };
  const read = path => readFileSync(join(project, path), 'utf8');
  // Copy the shipped runner without editing it; synthetic test files prevent recursive real-suite launches.
  put('scripts/project-cli.mjs', readFileSync(new URL('../../scripts/project-cli.mjs', import.meta.url)));
  put('observe-runner.mjs', "import { writeFileSync } from 'node:fs'; writeFileSync('runner.pid', String(process.pid));\n");
  const run = (args, status = 0) => {
    const result = spawnSync(process.execPath, [cli, '--root', project, ...args], { cwd: home, env, encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error); assert.equal(result.signal, null);
    assert.equal(result.status, status, `${JSON.stringify(args)}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  run(['init', '--app-json', JSON.stringify([process.execPath, '--import', './observe-runner.mjs', 'scripts/project-cli.mjs'])]);
  return { root: project, home, env, owned, put, read, run };
}

const fixtureJourneys = ['scenario', 'measured', 'mapping', 'comment', 'ignore', 'project', 'update', 'self-host'];
function passingRunnerFixtures(f) {
  for (const name of fixtureJourneys) f.put(`tests/e2e/${name}-journeys.test.mjs`, `import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
test('synthetic ${name}', () => {
  assert.equal(process.cwd(), ${JSON.stringify(f.root)});
  assert.equal(process.env.TRACER_NO_UPDATE, '1');
  appendFileSync('executed.jsonl', JSON.stringify('${name}') + '\\n');
});\n`);
  // The advertised self-host file has a singular name.
  f.put('tests/e2e/self-host-journey.test.mjs', f.read('tests/e2e/self-host-journeys.test.mjs'));
}

test('self-host runner journey: named and all test dispatch execute only reviewed files and preserve failure exits', t => {
  const f = runnerProject(t); passingRunnerFixtures(f);
  const named = f.run(['app', '--', 'test', 'mapping']);
  assert.deepEqual(f.read('executed.jsonl').trim().split('\n').map(JSON.parse), ['mapping']);
  assert.match(named.stdout, /(?:#|ℹ) tests 1\n/); assert.match(named.stdout, /(?:#|ℹ) pass 1\n/); assert.match(named.stdout, /(?:#|ℹ) fail 0\n/);
  rmSync(join(f.root, 'executed.jsonl'));
  const all = f.run(['app', '--', 'test']);
  assert.deepEqual(f.read('executed.jsonl').trim().split('\n').map(JSON.parse).sort(), [...fixtureJourneys].sort());
  assert.match(all.stdout, /(?:#|ℹ) tests 8\n/); assert.match(all.stdout, /(?:#|ℹ) pass 8\n/); assert.match(all.stdout, /(?:#|ℹ) fail 0\n/);
  const recorded = f.read('executed.jsonl');
  for (const args of [['test', 'mapping', 'unexpected'], ['test', '../outside'], ['test', '; touch NEVER']]) {
    const rejected = f.run(['app', '--', ...args], 1);
    assert.equal(rejected.stdout, '');
    assert.equal(rejected.stderr, 'Unknown project action. Use tracer actions or tracer app -- --help.\n');
    assert.equal(f.read('executed.jsonl'), recorded);
  }
  assert.equal(existsSync(join(f.root, 'NEVER')), false);
  f.put('tests/e2e/mapping-journeys.test.mjs', "import test from 'node:test'; import assert from 'node:assert/strict'; test('synthetic failure', () => assert.equal(1, 2));\n");
  const failed = f.run(['app', '--', 'test', 'mapping'], 1);
  assert.match(failed.stdout, /(?:not ok 1 -|✖) synthetic failure/);
  assert.match(failed.stdout, /(?:#|ℹ) tests 1\n/); assert.match(failed.stdout, /(?:#|ℹ) pass 0\n/); assert.match(failed.stdout, /(?:#|ℹ) fail 1\n/);
  assert.equal(f.read('executed.jsonl'), recorded, 'a named failing journey must not execute other groups');
});

async function waitForRunnerFile(f, path) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (existsSync(join(f.root, path))) return f.read(path);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Owned runner did not create ${path}`);
}

function launchRunner(f) {
  const child = spawn(process.execPath, [cli, '--root', f.root, 'app', '--', 'test', 'mapping'], { cwd: f.home, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  f.owned.add(child.pid);
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })); });
  return { child, closed };
}

test('self-host runner journey: wrapper cancellation reaps the owned test runner and its test worker', { skip: process.platform === 'win32', timeout: 15000 }, async t => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const f = runnerProject(t);
    f.put('tests/e2e/mapping-journeys.test.mjs', `import test from 'node:test';
import { writeFileSync } from 'node:fs';
writeFileSync('test-pids.json', JSON.stringify({ test: process.pid, runner: process.ppid }));
test('synthetic waiting test', async () => { await new Promise(() => { setInterval(() => {}, 1000); }); });\n`);
    const running = launchRunner(f);
    const pids = JSON.parse(await waitForRunnerFile(f, 'test-pids.json'));
    const runner = Number(await waitForRunnerFile(f, 'runner.pid'));
    for (const pid of [pids.test, pids.runner, runner]) f.owned.add(pid);
    running.child.kill(signal);
    const result = await running.closed;
    assert.equal(result.signal, signal); assert.equal(result.code, null);
    for (const pid of [pids.runner, runner]) assert.throws(() => process.kill(pid, 0), /ESRCH/);
    assert.throws(() => process.kill(pids.test, 0), /ESRCH/, 'cancelled test worker must not survive its runner');
    f.owned.clear();
  }
});

test('packaged install journey: offline npm package, both installed bins, mapping and separately consented agent setup', { skip: process.platform === 'win32', timeout: 60000 }, t => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'tracer-package-journey-')));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const home = join(temp, 'home'), cache = join(temp, 'cache'), work = join(temp, 'tmp');
  const prefix = join(temp, 'prefix'), project = join(temp, 'project'), packs = join(temp, 'packs');
  for (const path of [home, cache, work, prefix, project, packs]) mkdirSync(path);
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: cache, XDG_DATA_HOME: join(home, '.local/share'),
    TMPDIR: work, TMP: work, TEMP: work, TRACER_NO_UPDATE: '1', CI: '1', FORCE_COLOR: '0',
    npm_config_cache: cache, npm_config_userconfig: join(home, '.npmrc'), npm_config_globalconfig: join(home, 'global-npmrc') };
  const run = (command, args, cwd = project, status = 0) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 45000 });
    assert.ifError(result.error); assert.equal(result.signal, null);
    assert.equal(result.status, status, `${command} ${JSON.stringify(args)}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const npmFlags = ['--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache];
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', packs, ...npmFlags], root).stdout);
  assert.equal(packed.length, 1); assert.equal(packed[0].name, '@pcopu/tracercli');
  const listed = packed[0].files.map(file => file.path);
  for (const path of ['package.json', 'README.md', 'bin/tracer.mjs', 'src/tracer.mjs', 'src/measured.mjs',
    'src/audit-queue.mjs', 'docs/audit-queue.md', 'src/proposals.mjs', 'docs/proposals.md', 'src/scenarios.mjs', 'src/scenario-runtime.mjs', 'docs/scenarios.md', 'src/project.mjs', 'src/agent-setup.mjs', 'src/update.mjs', 'skills/tracer/SKILL.md', 'docs/measured.md']) assert.ok(listed.includes(path), path);
  assert.equal(listed.some(path => /^(?:tests|scripts|node_modules)\//.test(path)), false);
  const tarball = join(packs, packed[0].filename); assert.equal(existsSync(tarball), true);
  run('npm', ['install', '--prefix', prefix, '--no-save', '--no-package-lock', ...npmFlags, tarball]);
  const installed = join(prefix, 'node_modules/@pcopu/tracercli');
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  const sourceManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@pcopu/tracercli'); assert.equal(manifest.version, sourceManifest.version);
  assert.equal(packed[0].version, manifest.version); assert.equal(manifest.type, 'module');
  assert.deepEqual(manifest.bin, { tracer: 'bin/tracer.mjs', tracercli: 'bin/tracer.mjs' });
  assert.deepEqual(manifest.exports, {'.':'./src/tracer.mjs', './scenario-runtime':'./src/scenario-runtime.mjs'}); assert.equal(manifest.engines.node, '>=20');
  assert.deepEqual(manifest.files, ['bin', 'src', 'skills', 'README.md', 'docs']);
  assert.equal(manifest.license, 'UNLICENSED');
  assert.equal(manifest.description, 'Language-neutral source/action/test navigation with separate provenance-bound LCOV interval evidence.');
  assert.deepEqual(manifest.repository, { type: 'git', url: 'https://github.com/pcopu/tracerCLI.git' });
  assert.equal(manifest.scripts.test, 'node bin/tracer.mjs app -- test');
  assert.equal(manifest.scripts.check, 'node --check bin/tracer.mjs && node --check src/tracer.mjs && node --check src/catalog.mjs && node --check src/proposals.mjs && node --check src/audit-queue.mjs && node --check src/scenarios.mjs && node --check src/scenario-runtime.mjs && node --check src/measured.mjs && node --check src/project.mjs && node --check src/agent-setup.mjs && node --check src/update.mjs && node --check scripts/project-cli.mjs && npm test && node bin/tracer.mjs check');
  for (const path of ['bin/tracer.mjs', ...Object.values(manifest.exports), 'skills/tracer/SKILL.md', 'docs/measured.md', 'docs/scenarios.md']) assert.equal(existsSync(join(installed, path)), true, path);
  assert.equal(existsSync(join(installed, 'tests')), false); assert.equal(existsSync(join(installed, 'scripts')), false);
  const tracer = join(prefix, 'node_modules/.bin/tracer'), tracercli = join(prefix, 'node_modules/.bin/tracercli');
  for (const bin of [tracer, tracercli]) {
    assert.equal(run(bin, ['--version']).stdout.trim(), manifest.version);
    const help = run(bin, ['--help']).stdout;
    assert.match(help, /Usage: tracer/); assert.match(help, /Skill installation and project guidance require separate consent/);
    assert.match(help, /MANUAL LINKS ONLY/);
  }
  const exported = run(process.execPath, ['--input-type=module', '-e', "import {createScenarioRun} from '@pcopu/tracercli/scenario-runtime'; console.log(typeof createScenarioRun)"], prefix);
  assert.equal(exported.stdout.trim(), 'function');
  run('git', ['init', '-q']);
  writeFileSync(join(project, 'example.js'), 'export const answer = 42;\n');
  writeFileSync(join(project, 'witness.txt'), 'assert answer\n');
  writeFileSync(join(project, 'AGENTS.md'), 'Keep these instructions.\n');
  const skill = join(home, '.codex/skills/tracer/SKILL.md');
  run(tracer, ['init']);
  assert.equal(existsSync(skill), false); assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), 'Keep these instructions.\n');
  run(tracercli, ['init', '--agent', 'codex', '--install-skill']);
  assert.equal(readFileSync(skill, 'utf8'), readFileSync(join(installed, 'skills/tracer/SKILL.md'), 'utf8'));
  assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), 'Keep these instructions.\n');
  run(tracer, ['init', '--agent', 'codex', '--add-instruction']);
  assert.match(readFileSync(join(project, 'AGENTS.md'), 'utf8'), /installed tracer skill and tracer CLI/);
  run(tracercli, ['link', 'example.js:1', '--action', 'example read', '--action', 'example read', '--step', 'witness.txt:1', '--why', 'Read the synthetic example.']);
  const mapPath = join(project, 'docs/testing/code-e2e-links.json');
  const map = JSON.parse(readFileSync(mapPath, 'utf8')); assert.equal(map.version, 1); assert.equal(map.links.length, 1);
  assert.deepEqual(map.links[0].actions, ['example read', 'example read']);
  assert.equal(map.links[0].source.path, 'example.js'); assert.equal(map.links[0].step.path, 'witness.txt');
  const report = JSON.parse(run(tracer, ['report', '--source', 'example.js:1', '--json']).stdout);
  assert.equal(report.kind, 'manual-links'); assert.equal(report.totals.linked, 1); assert.equal(report.totals.withStep, 1);
  assert.equal(JSON.parse(run(tracercli, ['check', '--json']).stdout).valid, 1);
  writeFileSync(join(project, 'example.js'), 'export const answer = 43;\n');
  const stale = JSON.parse(run(tracer, ['check', '--json'], project, 1).stdout);
  assert.equal(stale.valid, 0); assert.equal(stale.invalid.length, 1);
  run(tracercli, ['unlink', map.links[0].id]);
  assert.equal(JSON.parse(readFileSync(mapPath, 'utf8')).links.length, 0);
  assert.equal(JSON.parse(run(tracer, ['check', '--json']).stdout).valid, 0);
});
