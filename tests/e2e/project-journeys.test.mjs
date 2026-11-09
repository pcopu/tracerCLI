import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync, spawn } from 'node:child_process';

// This suite interacts only with the actual CLI. It imports no implementation API.
const cli = fileURLToPath(new URL('../../bin/tracer.mjs', import.meta.url));
const mapPath = 'docs/testing/code-e2e-links.json';
function project(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tracer-project-journey-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const home = join(root, 'fake-home'); mkdirSync(home);
  const env = { ...process.env, HOME: home, CODEX_HOME: '', USERPROFILE: home, TRACER_NO_UPDATE: '1' };
  const put = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  const read = path => readFileSync(join(root, path), 'utf8');
  put('src/example.js', 'export const value = 1;\n');
  put('app.mjs', `import { writeFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--help') { console.log('Example app help'); process.exit(0); }
if (args[0] === 'actions') { console.log(JSON.stringify({actions:['read','write']})); process.exit(0); }
if (args[0] === 'exit') { console.error('application stderr'); process.exit(Number(args[1])); }
if (args[0] === 'signal') process.kill(process.pid, 'SIGTERM');
if (args[0] === 'stdin') { process.stdout.write(readFileSync(0)); process.exit(0); }
writeFileSync('app-ran.json', JSON.stringify({args,cwd:process.cwd()}));
console.log(JSON.stringify({args,cwd:process.cwd()}));
`);
  const run = (...args) => spawnSync(process.execPath, [cli, '--root', root, ...args], { encoding: 'utf8', env });
  const ok = (...args) => { const result = run(...args); assert.equal(result.status, 0, result.stderr); return result; };
  const app = JSON.stringify([process.execPath, 'app.mjs']);
  return { root, home, env, put, read, run, ok, app };
}

test('project lifecycle: initialize, preserve existing work, connect discovery, and reject conflicting setup', t => {
  const p = project(t);
  p.put('AGENTS.md', 'Existing project instructions\n');
  p.ok('init', '--app-json', p.app, '--actions-json', '["actions","--json"]', '--minimum-traces', '2');
  const config = p.read('tracer.json'), map = p.read(mapPath);
  assert.equal(existsSync(join(p.root, 'app-ran.json')), false);
  assert.equal(p.read('AGENTS.md'), 'Existing project instructions\n');
  p.ok('init', '--app-json', p.app, '--actions-json', '["actions","--json"]', '--minimum-traces', '2');
  assert.equal(p.read('tracer.json'), config); assert.equal(p.read(mapPath), map);
  assert.equal(JSON.parse(p.ok('config', '--json').stdout).minimumTraces, 2);
  assert.deepEqual(JSON.parse(p.ok('actions').stdout), { actions: ['read', 'write'] });
  p.ok('link', 'src/example.js:1', '--action', 'app read', '--why', 'Read example.');
  const linked = p.read(mapPath);
  const extended = { ...JSON.parse(config), custom: 'preserve' }; p.put('tracer.json', JSON.stringify(extended));
  p.ok('init'); assert.deepEqual(JSON.parse(p.read('tracer.json')), extended); assert.equal(p.read(mapPath), linked);
  assert.notEqual(p.run('init', '--app-json', '["different"]') .status, 0);
  assert.notEqual(p.run('init', '--minimum-traces', '3').status, 0);
  assert.deepEqual(JSON.parse(p.read('tracer.json')), extended); assert.equal(p.read(mapPath), linked);
});

test('app journey: discover safely, forward literal argv and stdin, preserve exits, and isolate mapping', t => {
  const p = project(t); p.ok('init', '--app-json', p.app);
  assert.equal(p.ok('actions').stdout, 'Example app help\n');
  const args = ['read', '', 'space here', 'a,b:1', '; touch NEVER', '$(touch NEVER)', '*', '--help'];
  const forwarded = p.ok('app', '--', ...args);
  assert.deepEqual(JSON.parse(forwarded.stdout), { args, cwd: p.root }); assert.equal(forwarded.stderr, '');
  assert.equal(existsSync(join(p.root, 'NEVER')), false);
  assert.notEqual(p.run('app', 'exit', '7').status, 0);
  const failure = p.run('app', '--', 'exit', '7'); assert.equal(failure.status, 7);
  assert.equal(failure.stdout, ''); assert.equal(failure.stderr, 'application stderr\n');
  const stdin = spawnSync(process.execPath, [cli, '--root', p.root, 'app', '--', 'stdin'], { input: 'literal input\n', encoding: 'utf8', env: p.env });
  assert.equal(stdin.status, 0); assert.equal(stdin.stdout, 'literal input\n');
  p.put('tracer.json', JSON.stringify({ version: 1, app: JSON.parse(p.app), actions: ['exit', '9'] }));
  const discoveryFailure = p.run('actions'); assert.equal(discoveryFailure.status, 9); assert.equal(discoveryFailure.stdout, '');
  rmSync(join(p.root, 'app-ran.json'));
  for (const config of [JSON.stringify({ version: 1, app: JSON.parse(p.app) }), '{not json']) {
    p.put('tracer.json', config); p.ok('report', '--json'); p.ok('check');
    p.ok('link', 'src/example.js:1', '--action', 'read', '--why', 'Read example.');
    assert.equal(existsSync(join(p.root, 'app-ran.json')), false);
  }
  p.put('tracer.json', JSON.stringify({ version: 1, app: ['this-program-does-not-exist-abc'] }));
  assert.match(p.run('actions').stderr, /Could not run configured app/);
});

test('cancellation journey: child signals, wrapper-only cancellation, cleanup and escalation', { skip: process.platform === 'win32' }, async t => {
  const p = project(t); p.ok('init', '--app-json', p.app);
  assert.equal(p.run('app', '--', 'signal').signal, 'SIGTERM');
  for (const signal of ['SIGTERM', 'SIGINT']) {
    p.put('app.mjs', `import { writeFileSync } from 'node:fs';
process.on('${signal}', () => { setTimeout(() => { writeFileSync('child-cleaned', 'yes'); process.exit(0); }, 80); });
writeFileSync('child.pid', String(process.pid));
setInterval(() => {}, 1000);\n`);
    const wrapper = spawn(process.execPath, [cli, '--root', p.root, 'app', '--'], { env: p.env, stdio: 'ignore' });
    let pid; t.after(() => { try { wrapper.kill('SIGKILL'); } catch {} if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
    for (let i = 0; i < 100 && !existsSync(join(p.root, 'child.pid')); i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(existsSync(join(p.root, 'child.pid')), true); pid = Number(p.read('child.pid'));
    const closed = new Promise(resolve => wrapper.once('close', (code, received) => resolve({ code, signal: received })));
    wrapper.kill(signal); const result = await closed;
    assert.equal(result.signal, signal); assert.equal(p.read('child-cleaned'), 'yes');
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    rmSync(join(p.root, 'child.pid')); rmSync(join(p.root, 'child-cleaned'));
  }
  p.put('app.mjs', `import { writeFileSync } from 'node:fs'; process.on('SIGTERM', () => {}); writeFileSync('child.pid', String(process.pid)); setInterval(() => {}, 1000);\n`);
  const stubborn = spawn(process.execPath, [cli, '--root', p.root, 'app', '--'], { env: p.env, stdio: 'ignore' });
  let pid; t.after(() => { try { stubborn.kill('SIGKILL'); } catch {} if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  for (let i = 0; i < 100 && !existsSync(join(p.root, 'child.pid')); i++) await new Promise(r => setTimeout(r, 20));
  pid = Number(p.read('child.pid')); const closed = new Promise(resolve => stubborn.once('close', (code, signal) => resolve({ code, signal })));
  stubborn.kill('SIGTERM'); await new Promise(r => setTimeout(r, 50)); stubborn.kill('SIGTERM');
  const escalated = await closed; assert.equal(escalated.signal, 'SIGKILL'); assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('agent consent journey: detect, opt in separately, preserve custom skills, append one generic pointer', t => {
  const p = project(t); mkdirSync(join(p.home, '.codex'));
  p.put('AGENTS.md', 'Original\r\nKeep this\r\n');
  p.ok('init'); assert.equal(existsSync(join(p.home, '.codex/skills/tracer')), false);
  assert.equal(p.read('AGENTS.md'), 'Original\r\nKeep this\r\n');
  p.ok('init', '--agent', 'codex', '--install-skill');
  assert.equal(existsSync(join(p.home, '.codex/skills/tracer/SKILL.md')), true);
  assert.equal(p.read('AGENTS.md'), 'Original\r\nKeep this\r\n');
  let settings = JSON.parse(p.read('fake-home/.local/share/tracer/settings.json'));
  assert.equal(settings.skills.length, 1); assert.match(settings.skills[0].sha256, /^[a-f0-9]{64}$/); assert.equal(settings.auto, 'off');
  p.ok('init', '--agent', 'codex', '--add-instruction'); const first = p.read('AGENTS.md');
  assert.ok(first.startsWith('Original\r\nKeep this\r\n')); assert.match(first, /installed tracer skill and tracer CLI/);
  p.ok('init', '--agent', 'codex', '--add-instruction'); assert.equal(p.read('AGENTS.md'), first);
  writeFileSync(join(p.home, '.codex/skills/tracer/SKILL.md'), 'custom skill\n');
  p.ok('init', '--agent', 'codex', '--install-skill'); assert.equal(p.read('fake-home/.codex/skills/tracer/SKILL.md'), 'custom skill\n');
  p.ok('init', '--agent', 'claude', '--install-skill', '--add-instruction');
  assert.equal(existsSync(join(p.home, '.claude/skills/tracer/SKILL.md')), true); assert.equal(existsSync(join(p.root, 'CLAUDE.md')), true);
  assert.equal(p.read('AGENTS.md'), first); assert.notEqual(p.run('init', '--install-skill').status, 0); // Ambiguous agent.
  settings = JSON.parse(p.read('fake-home/.local/share/tracer/settings.json')); assert.equal(settings.skills.length, 2);
});

test('setup safety journey: invalid configuration, paths and agent choices cannot overwrite user files', t => {
  const p = project(t);
  assert.notEqual(p.run('init', '--agent', 'invalid-agent').status, 0);
  assert.equal(existsSync(join(p.root, 'tracer.json')), false); assert.equal(existsSync(join(p.root, mapPath)), false);
  assert.notEqual(p.run('init', '--agent', 'codex', '--add-instruction').status, 0); assert.equal(existsSync(join(p.root, 'AGENTS.md')), false);
  assert.match(p.run('actions').stderr, /no app argv/);
  for (const data of [null, [], { version: 2 }, { version: 1, app: 'node app.mjs' }, { version: 1, app: [] },
    { version: 1, app: [''] }, { version: 1, app: ['node', 42] }, { version: 1, app: ['node\0'] },
    { version: 1, actions: ['actions'] }, { version: 1, app: ['node'], actions: [] }]) {
    p.put('tracer.json', JSON.stringify(data)); assert.notEqual(p.run('init').status, 0); assert.notEqual(p.run('actions').status, 0);
  }
  rmSync(join(p.root, 'tracer.json')); p.put(mapPath, '{bad');
  assert.notEqual(p.run('init').status, 0); assert.equal(existsSync(join(p.root, 'tracer.json')), false);
  p.put(mapPath, '{"version":1,"links":[]}'); p.put('target.json', '{}');
  symlinkSync(join(p.root, 'target.json'), join(p.root, 'tracer.json'));
  assert.notEqual(p.run('init').status, 0); assert.equal(p.read('target.json'), '{}');
  rmSync(join(p.root, 'tracer.json'));
  assert.notEqual(p.run('--map', 'tracer.json', 'init').status, 0);
  mkdirSync(join(p.home, '.codex/skills'), { recursive: true }); mkdirSync(join(p.root, 'outside'));
  symlinkSync(join(p.root, 'outside'), join(p.home, '.codex/skills/tracer'));
  assert.notEqual(p.run('init', '--agent', 'codex', '--install-skill').status, 0); assert.equal(existsSync(join(p.root, 'outside/SKILL.md')), false);
  rmSync(join(p.home, '.codex/skills/tracer')); p.ok('init', '--agent', 'codex', '--install-skill');
  p.put('elsewhere.txt', 'unchanged'); symlinkSync(join(p.root, 'elsewhere.txt'), join(p.root, 'AGENTS.md'));
  assert.notEqual(p.run('init', '--agent', 'codex', '--add-instruction').status, 0); assert.equal(p.read('elsewhere.txt'), 'unchanged');
});

test('local update settings journey: status outside Git, explicit opt-in, deterministic reads and invalid-mode safety', t => {
  const p = project(t);
  const result = spawnSync(process.execPath, [cli, 'update', '--status', '--json'], { cwd: p.home, env: p.env, encoding: 'utf8' });
  assert.equal(result.status, 0); const status = JSON.parse(result.stdout); assert.equal(status.auto, 'off'); assert.equal(status.managed, false);
  assert.equal(existsSync(join(p.home, '.local/share/tracer')), false);
  for (const args of [['--status', '--check'], ['--auto', 'yes'], ['--rollback', '--commit', 'abc'], ['--version', '1.0.0', '--commit', 'abc'], ['--force']]) {
    assert.notEqual(p.run('update', ...args).status, 0);
  }
  assert.equal(existsSync(join(p.home, '.local/share/tracer/settings.json')), false);
  p.ok('update', '--auto', 'apply'); const before = p.read('fake-home/.local/share/tracer/settings.json');
  // Remove the override here: these commands must skip auto checks on their own.
  delete p.env.TRACER_NO_UPDATE;
  p.ok('report', '--json'); p.ok('check'); assert.equal(p.read('fake-home/.local/share/tracer/settings.json'), before);
  p.ok('update', '--auto', 'off'); assert.equal(JSON.parse(p.ok('update', '--status', '--json').stdout).auto, 'off');
});

test('skill parity journey: install the checked-in prerequisite and maintenance guidance without replacing user content', t => {
  const p = project(t), source = readFileSync(new URL('../../skills/tracer/SKILL.md', import.meta.url), 'utf8');
  p.put('AGENTS.md', 'Keep Codex project instructions.\r\n'); p.put('CLAUDE.md', 'Keep Claude project instructions.\n');
  for (const agent of ['codex', 'claude']) {
    p.ok('init', '--agent', agent, '--install-skill');
    const installed = readFileSync(join(p.home, `.${agent}/skills/tracer/SKILL.md`), 'utf8');
    assert.equal(installed, source);
    assert.match(installed, /Before starting application coverage or new link-mapping work, first audit every supported application feature/);
    assert.match(installed, /exposes every authorized application feature, building it if missing and extending it wherever routes are absent/);
    assert.match(installed, /CLI feature parity is a prerequisite/);
    assert.match(installed, /A mapping-only request does not authorize application changes/);
    assert.match(installed, /Preserve authentication, consent, safety checks, input-route semantics and user data/);
    assert.match(installed, /List unimplemented routes, platform constraints and deliberately restricted actions honestly/);
    assert.match(installed, /Keep the app CLI at feature parity whenever application features are added, changed or removed/);
    assert.match(installed, /update commands, discovery\/help, CLI behavior and E2E journeys to reflect the current app, then update the related map/);
    assert.match(installed, /a manual link is not proof of execution/);
  }
  const custom = `${source}\nKeep my project-specific skill additions.\n`;
  writeFileSync(join(p.home, '.codex/skills/tracer/SKILL.md'), custom);
  p.ok('init', '--agent', 'codex', '--install-skill');
  assert.equal(readFileSync(join(p.home, '.codex/skills/tracer/SKILL.md'), 'utf8'), custom);
  assert.equal(p.read('AGENTS.md'), 'Keep Codex project instructions.\r\n');
  assert.equal(p.read('CLAUDE.md'), 'Keep Claude project instructions.\n');
});

test('setup prerequisite journey: explain an unconnected CLI without guessing, executing or granting agent consent', t => {
  for (const existing of [false, true]) {
    const p = project(t); mkdirSync(join(p.home, '.codex'));
    p.put('AGENTS.md', 'Preserve instructions exactly.\r\n');
    p.put('app.mjs', "import {writeFileSync} from 'node:fs'; writeFileSync('app-ran.json', 'executed');\n");
    if (existing) p.put('tracer.json', '{"version":1,"custom":"keep mapping-only configuration"}\n');
    const priorConfig = existing ? p.read('tracer.json') : undefined, app = p.read('app.mjs'), source = p.read('src/example.js');
    const first = p.ok('init').stdout, config = p.read('tracer.json'), map = p.read(mapPath);
    if (existing) assert.equal(config, priorConfig);
    for (const output of [first, p.ok('init').stdout]) {
      assert.match(output, /An application CLI lets agents and tests operate your app through commands/);
      assert.match(output, /Before coverage work, inspect its features and build or extend that CLI to expose every authorized app feature/);
      assert.match(output, /No application CLI is connected\. This does not prove the app has no CLI: inspect the repository first/);
      assert.match(output, /If none exists, one must be built with your authorization; Tracer does not create it automatically/);
      assert.match(output, /ask your agent to inspect the app and explain what needs connecting or building/);
      assert.match(output, /review and add its app executable\/arguments to tracer.json explicitly; init preserves existing configuration/);
      assert.match(output, /tracer init --app-json/);
      assert.match(output, /Preserve consent, authentication and safety checks/);
      assert.match(output, /manual links do not prove execution or complete coverage/);
      assert.doesNotMatch(output, /An application CLI is configured/);
    }
    const attempted = p.run('init', '--app-json', p.app);
    assert.notEqual(attempted.status, 0); assert.match(attempted.stderr, /Inspect and edit it explicitly; init never overwrites configuration/);
    assert.equal(p.read('tracer.json'), config); assert.equal(p.read(mapPath), map);
    assert.equal(p.read('app.mjs'), app); assert.equal(p.read('src/example.js'), source);
    assert.equal(existsSync(join(p.root, 'app-ran.json')), false);
    assert.equal(existsSync(join(p.home, '.codex/skills/tracer')), false);
    assert.equal(existsSync(join(p.home, '.local/share/tracer/settings.json')), false);
    assert.equal(p.read('AGENTS.md'), 'Preserve instructions exactly.\r\n');
    assert.equal(existsSync(join(p.root, 'CLAUDE.md')), false);
  }
});

test('configured setup journey: explain unverified CLI parity on new and repeated init without executing the app', t => {
  const p = project(t); mkdirSync(join(p.home, '.codex'));
  p.put('AGENTS.md', 'Preserve existing agent guidance.\n');
  p.put('app.mjs', "import {writeFileSync} from 'node:fs'; writeFileSync('app-ran.json', 'executed');\n");
  const app = p.read('app.mjs');
  const first = p.ok('init', '--app-json', p.app, '--actions-json', '["actions","--json"]').stdout;
  const config = p.read('tracer.json'), map = p.read(mapPath);
  for (const output of [first, p.ok('init').stdout]) {
    assert.match(output, /An application CLI is configured, but setup has not run it or verified its features/);
    assert.match(output, /Review tracer.json before using tracer actions; check for missing routes before claiming full CLI coverage/);
    assert.match(output, /Keep the CLI and its tests current whenever app features change/);
    assert.match(output, /report missing or restricted features honestly/);
    assert.doesNotMatch(output, /No application CLI is connected/);
  }
  assert.deepEqual(JSON.parse(config).app, JSON.parse(p.app));
  assert.equal(p.read('tracer.json'), config); assert.equal(p.read(mapPath), map);
  assert.equal(p.read('app.mjs'), app); assert.equal(existsSync(join(p.root, 'app-ran.json')), false);
  assert.equal(existsSync(join(p.home, '.codex/skills/tracer')), false);
  assert.equal(existsSync(join(p.home, '.local/share/tracer/settings.json')), false);
  assert.equal(p.read('AGENTS.md'), 'Preserve existing agent guidance.\n');
});

// Terminal-only journeys need the standard Linux util-linux script utility.
// Other platforms keep the ordinary Node/Git suite and report these cases skipped.
function terminalAvailable(t) {
  if (process.platform !== 'linux') { t.skip('Real TTY journeys require util-linux script on Linux.'); return false; }
  const probe = spawnSync('script', ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0 || !/util-linux/.test(probe.stdout ?? '')) {
    t.skip('Real TTY journeys require the optional util-linux script test utility.'); return false;
  }
  return true;
}
async function terminalInit(t, p, args, dialogue) {
  // script supplies real stdin/stdout TTYs. Only fixed CLI argv is shell-quoted;
  // terminal answers are written to stdin after the actual prompt is observed.
  const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
  const command = [process.execPath, cli, '--root', p.root, 'init', ...args].map(quote).join(' ');
  const child = spawn('script', ['-q', '-e', '-f', '-c', command, '/dev/null'], {
    cwd: p.root, env: { ...p.env, TERM: 'dumb' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '', error, ended, cursor = 0;
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  child.on('error', value => { error = value; });
  child.on('close', (code, signal) => { ended = { code, signal }; });
  const text = () => output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replaceAll('\r', '');
  const wait = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (error) throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for terminal interaction:\n${text()}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const stop = async () => {
    if (ended || !child.pid) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, 1000);
    try { await wait(() => ended); } finally { clearTimeout(timer); }
  };
  t.after(stop);
  try {
    for (const { prompt, answer, beforeAnswer } of dialogue) {
      await wait(() => text().indexOf(prompt, cursor) !== -1 || ended);
      const transcript = text(), index = transcript.indexOf(prompt, cursor);
      assert.notEqual(index, -1, `CLI ended before expected prompt ${JSON.stringify(prompt)}:\n${transcript}`);
      cursor = index + prompt.length;
      beforeAnswer?.();
      child.stdin.write(`${answer}\n`);
    }
    await wait(() => ended);
    assert.deepEqual(ended, { code: 0, signal: null }, text());
    return text();
  } finally { await stop(); }
}

test('terminal consent journey: blank, skip and unsupported agent choices never grant consent', { timeout: 20000 }, async t => {
  if (!terminalAvailable(t)) return;
  for (const answer of ['', 'skip', 'unsupported-agent']) {
    const p = project(t); p.put('AGENTS.md', 'Keep Codex instructions.\r\n'); p.put('CLAUDE.md', 'Keep Claude instructions.\n');
    const source = p.read('src/example.js'), app = p.read('app.mjs');
    const output = await terminalInit(t, p, [], [{
      prompt: 'Agent setup: codex, claude, or skip? [skip] ', answer,
      beforeAnswer: () => {
        assert.equal(existsSync(join(p.home, '.codex')), false); assert.equal(existsSync(join(p.home, '.claude')), false);
      },
    }]);
    assert.match(output, /Agent setup is optional/);
    if (answer === 'unsupported-agent') assert.match(output, /Unsupported agent; no agent files changed/);
    else assert.doesNotMatch(output, /Unsupported agent/);
    assert.doesNotMatch(output, /Install the Tracer skill|Append Tracer guidance/);
    assert.equal(existsSync(join(p.home, '.codex')), false); assert.equal(existsSync(join(p.home, '.claude')), false);
    assert.equal(existsSync(join(p.home, '.local/share/tracer')), false);
    assert.equal(p.read('AGENTS.md'), 'Keep Codex instructions.\r\n'); assert.equal(p.read('CLAUDE.md'), 'Keep Claude instructions.\n');
    assert.equal(p.read('src/example.js'), source); assert.equal(p.read('app.mjs'), app);
    assert.equal(existsSync(join(p.root, 'app-ran.json')), false);
  }
});

test('terminal consent journey: choose among detected agents and authorize skill and instructions separately', { timeout: 20000 }, async t => {
  if (!terminalAvailable(t)) return;
  const p = project(t); mkdirSync(join(p.home, '.codex')); mkdirSync(join(p.home, '.claude'));
  p.put('AGENTS.md', 'Keep Codex instructions.\r\n'); p.put('CLAUDE.md', 'Keep Claude instructions.\r\n');
  const skill = join(p.home, '.claude/skills/tracer/SKILL.md'), expected = readFileSync(new URL('../../skills/tracer/SKILL.md', import.meta.url), 'utf8');
  const expectedHash = (await import('node:crypto')).createHash('sha256').update(expected).digest('hex');
  const output = await terminalInit(t, p, [], [
    { prompt: 'Agent setup (multiple configurations found): codex, claude, or skip? [skip] ', answer: '  ClAuDe  ' },
    { prompt: `Install the Tracer skill for claude at ${join(p.home, '.claude/skills/tracer')}? [y/N] `, answer: ' YES ', beforeAnswer: () => {
      assert.equal(existsSync(skill), false); assert.equal(p.read('CLAUDE.md'), 'Keep Claude instructions.\r\n');
    } },
    { prompt: `Append Tracer guidance to ${join(p.root, 'CLAUDE.md')}, preserving existing content? [y/N] `, answer: 'no', beforeAnswer: () => {
      assert.equal(readFileSync(skill, 'utf8'), expected); assert.equal(p.read('CLAUDE.md'), 'Keep Claude instructions.\r\n');
      const settings = JSON.parse(p.read('fake-home/.local/share/tracer/settings.json'));
      assert.equal(settings.skills.length, 1); assert.equal(settings.skills[0].path, skill); assert.equal(settings.skills[0].sha256, expectedHash); assert.equal(settings.auto, 'off');
    } },
  ]);
  assert.match(output, /No project instruction changed/); assert.equal(p.read('CLAUDE.md'), 'Keep Claude instructions.\r\n');
  assert.equal(p.read('AGENTS.md'), 'Keep Codex instructions.\r\n'); assert.equal(existsSync(join(p.home, '.codex/skills')), false);
  const config = p.read('tracer.json'), map = p.read(mapPath), settings = p.read('fake-home/.local/share/tracer/settings.json');
  const approved = await terminalInit(t, p, ['--agent', 'claude'], [{
    prompt: `Append Tracer guidance to ${join(p.root, 'CLAUDE.md')}, preserving existing content? [y/N] `, answer: 'y',
    beforeAnswer: () => assert.equal(p.read('CLAUDE.md'), 'Keep Claude instructions.\r\n'),
  }]);
  assert.doesNotMatch(approved, /Agent setup.*skip|Install the Tracer skill/);
  const instruction = p.read('CLAUDE.md'); assert.ok(instruction.startsWith('Keep Claude instructions.\r\n'));
  assert.equal(instruction.split('<!-- tracer:agent-guidance -->').length - 1, 1);
  assert.match(instruction, /installed tracer skill and tracer CLI/); assert.equal(instruction.replaceAll('\r\n', '').includes('\n'), false);
  await terminalInit(t, p, ['--agent', 'claude'], [{
    prompt: `Append Tracer guidance to ${join(p.root, 'CLAUDE.md')}, preserving existing content? [y/N] `, answer: 'yes',
  }]);
  assert.equal(p.read('CLAUDE.md'), instruction); assert.equal(p.read('AGENTS.md'), 'Keep Codex instructions.\r\n');
  assert.equal(p.read('tracer.json'), config); assert.equal(p.read(mapPath), map);
  assert.equal(p.read('fake-home/.local/share/tracer/settings.json'), settings); assert.equal(readFileSync(skill, 'utf8'), expected);
  assert.equal(existsSync(join(p.root, 'app-ran.json')), false);
});

test('terminal consent journey: one detected agent still needs affirmative skill consent', { timeout: 20000 }, async t => {
  if (!terminalAvailable(t)) return;
  for (const answer of ['', 'n', 'not-yes']) {
    const p = project(t); mkdirSync(join(p.home, '.codex')); p.put('AGENTS.md', 'Preserve without consent.\n');
    const output = await terminalInit(t, p, [], [{
      prompt: `Install the Tracer skill for codex at ${join(p.home, '.codex/skills/tracer')}? [y/N] `, answer,
      beforeAnswer: () => {
        assert.equal(existsSync(join(p.home, '.codex/skills')), false); assert.equal(p.read('AGENTS.md'), 'Preserve without consent.\n');
      },
    }]);
    assert.doesNotMatch(output, /Agent setup.*skip|Append Tracer guidance/);
    assert.match(output, /Tracer skill is missing for codex/); assert.match(output, /No project instruction was added/);
    assert.equal(existsSync(join(p.home, '.codex/skills')), false); assert.equal(existsSync(join(p.home, '.local/share/tracer')), false);
    assert.equal(p.read('AGENTS.md'), 'Preserve without consent.\n');
  }
});

test('terminal consent journey: preserve customized skills and default-deny instruction changes', { timeout: 20000 }, async t => {
  if (!terminalAvailable(t)) return;
  const p = project(t); p.put('fake-home/.codex/skills/tracer/SKILL.md', '# Customized skill\nKeep my workflow.\n');
  p.put('AGENTS.md', 'Keep my exact instructions.\r\n');
  const output = await terminalInit(t, p, [], [{
    prompt: `Append Tracer guidance to ${join(p.root, 'AGENTS.md')}, preserving existing content? [y/N] `, answer: '',
  }]);
  assert.doesNotMatch(output, /Agent setup.*skip|Install the Tracer skill/); assert.match(output, /No project instruction changed/);
  assert.equal(p.read('AGENTS.md'), 'Keep my exact instructions.\r\n');
  assert.equal(p.read('fake-home/.codex/skills/tracer/SKILL.md'), '# Customized skill\nKeep my workflow.\n');
  assert.equal(existsSync(join(p.home, '.local/share/tracer/settings.json')), false, 'An unregistered customized skill is not adopted by a prompt.');
  const approved = await terminalInit(t, p, ['--agent', 'codex', '--install-skill'], [{
    prompt: `Append Tracer guidance to ${join(p.root, 'AGENTS.md')}, preserving existing content? [y/N] `, answer: 'YES',
  }]);
  assert.match(approved, /Preserved existing skill/); assert.match(approved, /Added Tracer guidance/);
  assert.ok(p.read('AGENTS.md').startsWith('Keep my exact instructions.\r\n'));
  assert.equal(p.read('fake-home/.codex/skills/tracer/SKILL.md'), '# Customized skill\nKeep my workflow.\n');
  assert.equal(existsSync(join(p.home, '.local/share/tracer/settings.json')), false);
});
