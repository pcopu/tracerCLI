#!/usr/bin/env node
// Tracer's own project CLI. Every test journey drives the public Tracer CLI.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const journeys = {
  scenarios: { file: 'tests/e2e/scenario-journeys.test.mjs', description: 'Reusable named steps, source/assertion pins, atomic reviewed linking and explicit runtime outcomes.' },
  measured: { file: 'tests/e2e/measured-journeys.test.mjs', description: 'Pinned LCOV pair import, interval lookup, provenance, staleness and atomic rejection.' },
  mapping: { file: 'tests/e2e/mapping-journeys.test.mjs', description: 'Code/action/witness lifecycle, per-line traces, bytes, inventory and safe writes.' },
  comments: { file: 'tests/e2e/comment-journeys.test.mjs', description: 'Explicit comment declarations, excluded manual counts, exact hashes, staleness and recovery.' },
  ignore: { file: 'tests/e2e/ignore-journeys.test.mjs', description: 'Explicit project mapping scope, ignored source/witness integrity, restoration and unchanged test execution.' },
  project: { file: 'tests/e2e/project-journeys.test.mjs', description: 'Project init, app discovery/forwarding/cancellation, agent consent and preservation.' },
  update: { file: 'tests/e2e/update-journeys.test.mjs', description: 'Official update integrity, managed activation/rollback, automatic mode and skill preservation.' },
  'self-host': { file: 'tests/e2e/self-host-journey.test.mjs', description: 'Tracer discovers and delegates to its own project CLI and checks its reviewed map.' },
};
const args = process.argv.slice(2);
if (args[0] === 'actions' && args.length === 2 && args[1] === '--json') {
  console.log(JSON.stringify({ version: 1, application: 'tracercli-self-host', actions: [
    { command: ['test'], description: 'Run every real CLI E2E journey.' },
    ...Object.entries(journeys).map(([name, value]) => ({ command: ['test', name], description: value.description })),
  ] }, null, 2));
} else if (!args.length || args.length === 1 && ['--help', 'help'].includes(args[0])) {
  console.log('Tracer self-host project CLI\n  actions --json\n  test [scenarios|mapping|comments|ignore|measured|project|update|self-host]\nRun through Tracer: tracer app -- test');
} else if (args[0] === 'test' && args.length <= 2 && (!args[1] || Object.hasOwn(journeys, args[1]))) {
  const files = args[1] ? [journeys[args[1]].file] : Object.values(journeys).map(value => value.file);
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
    cwd: root, stdio: 'inherit', shell: false,
    env: { ...process.env, TRACER_NO_UPDATE: '1' },
  });
  let stopping;
  const forward = signal => { child.kill(stopping ? 'SIGKILL' : signal); stopping ??= signal; };
  const int = () => forward('SIGINT'), term = () => forward('SIGTERM');
  process.on('SIGINT', int); process.on('SIGTERM', term);
  const result = await new Promise(resolve => {
    child.once('error', error => { console.error(error.message); resolve({ status: 1 }); });
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
  process.removeListener('SIGINT', int); process.removeListener('SIGTERM', term);
  process.exitCode = result.status ?? 1;
  if (result.signal || stopping) process.kill(process.pid, result.signal ?? stopping);
} else {
  console.error('Unknown project action. Use tracer actions or tracer app -- --help.'); process.exitCode = 1;
}
