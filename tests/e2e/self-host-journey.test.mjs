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
  for (const group of ['mapping', 'comments', 'ignore', 'measured', 'project', 'update', 'self-host']) {
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

const fixtureJourneys = ['measured', 'mapping', 'comment', 'ignore', 'project', 'update', 'self-host'];
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
  assert.match(all.stdout, /(?:#|ℹ) tests 7\n/); assert.match(all.stdout, /(?:#|ℹ) pass 7\n/); assert.match(all.stdout, /(?:#|ℹ) fail 0\n/);
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
