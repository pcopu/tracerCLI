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
  for (const group of ['mapping', 'project', 'update', 'self-host']) {
    assert.ok(actions.actions.some(action => JSON.stringify(action.command) === JSON.stringify(['test', group])));
  }
  const help = run('app', '--', '--help'); assert.equal(help.status, 0); assert.match(help.stdout, /Run through Tracer/);
  assert.equal(run('app', '--', 'test', 'unknown-journey').status, 1);
  const check = run('check', '--json'); assert.equal(check.status, 0, check.stderr);
  const integrity = JSON.parse(check.stdout); assert.equal(integrity.valid, integrity.total); assert.deepEqual(integrity.invalid, []);
  const report = run('report', '--json'); assert.equal(report.status, 0);
  const mapping = JSON.parse(report.stdout); assert.equal(mapping.kind, 'manual-links'); assert.match(mapping.notice, /not observed execution/);
  assert.ok(mapping.files.some(file => file.path === 'bin/tracer.mjs'));
});
