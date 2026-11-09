import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Tracer, validateMinimum } from './tracer.mjs';

export const PROJECT_FILE = 'tracer.json';
const fail = message => { throw new Error(message); };
function validateArgv(value, label) {
  if (!Array.isArray(value) || !value.length || value.some((argument, index) => typeof argument !== 'string'
      || (index === 0 && !argument.trim()) || /[\x00-\x1f\x7f]/.test(argument))) {
    fail(`${label} must be a nonempty JSON argv array of strings without control characters.`);
  }
  return value;
}
function projectPath(tracer) {
  // Reuse the sidecar path checks, but never read this file as a link map.
  const guard = new Tracer({ root: tracer.root, map: PROJECT_FILE });
  guard.validateMapPath();
  return guard.mapPath;
}
export function readProject(tracer, { required = true } = {}) {
  const path = projectPath(tracer);
  if (!existsSync(path)) {
    if (required) fail('No tracer.json found. Use tracer init --app-json to connect this project’s CLI.');
    return null;
  }
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (!data || Array.isArray(data) || data.version !== 1) fail('Expected tracer.json version 1.');
  if (Object.hasOwn(data, 'app')) validateArgv(data.app, 'app');
  if (Object.hasOwn(data, 'actions')) {
    validateArgv(data.actions, 'actions');
    if (!data.app) fail('tracer.json actions requires an app argv array.');
  }
  return data;
}
export function initialize(tracer, { app, actions, minimumTraces } = {}) {
  if (tracer.map === PROJECT_FILE || tracer.map.startsWith(`${PROJECT_FILE}/`)) fail('The link map must not replace tracer.json.');
  if (app !== undefined) validateArgv(app, 'app');
  if (actions !== undefined) validateArgv(actions, 'actions');
  if (minimumTraces !== undefined) validateMinimum(minimumTraces);
  const existing = readProject(tracer, { required: false });
  const map = tracer.readMap(); // Validate existing files before any writes.
  const requested = { version: 1, ...(app === undefined ? {} : { app }), ...(actions === undefined ? {} : { actions }) };
  if ((actions !== undefined || existing?.actions) && !(app ?? existing?.app)) fail('--actions-json requires an app argv array.');
  if (existing) for (const key of ['app', 'actions']) {
    if (Object.hasOwn(requested, key) && JSON.stringify(existing[key]) !== JSON.stringify(requested[key])) {
      fail(`Existing tracer.json ${key} differs. Inspect and edit it explicitly; init never overwrites configuration.`);
    }
  }
  if (existsSync(tracer.mapPath) && minimumTraces !== undefined && (map.minimumTraces ?? 1) !== minimumTraces) {
    fail('Existing map minimum differs. Use tracer config --minimum-traces after reviewing the change.');
  }
  // Initialize the sidecar under the same exclusive lock used by other writers.
  let mapCreated = false;
  tracer.mutate(data => {
    if (existsSync(tracer.mapPath)) {
      if (minimumTraces !== undefined && (data.minimumTraces ?? 1) !== minimumTraces) fail('Map minimum changed during init; retry after review.');
      return { changed: false };
    }
    if (minimumTraces !== undefined) data.minimumTraces = minimumTraces;
    mapCreated = true;
    return { changed: true };
  });
  let projectCreated = false;
  if (!existing) {
    const path = projectPath(tracer);
    mkdirSync(dirname(path), { recursive: true });
    try { writeFileSync(path, `${JSON.stringify(requested, null, 2)}\n`, { flag: 'wx', mode: 0o644 }); projectCreated = true; }
    catch (error) {
      if (error.code === 'EEXIST') fail('tracer.json appeared during init and was preserved. Review it and rerun init; the map may already be initialized.');
      throw error;
    }
  }
  return { project: PROJECT_FILE, map: tracer.map, projectCreated, mapCreated,
    appConfigured: !!(existing ?? requested).app, minimumTraces: minimumTraces ?? map.minimumTraces ?? 1 };
}
export function runApp(tracer, args, { discovery = false } = {}) {
  const project = readProject(tracer);
  if (!project.app) fail('tracer.json has no app argv array. Inspect and add your application CLI before running it.');
  const forwarded = discovery ? project.actions ?? ['--help'] : args;
  const [executable, ...prefix] = project.app;
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, [...prefix, ...forwarded], {
      cwd: tracer.root, stdio: 'inherit', shell: false,
    });
    let requestedSignal, settled = false;
    const handlers = new Map();
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    };
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => {
        // Wait for our owned child. A second cancellation escalates only that
        // child instead of abandoning a potentially running application action.
        child.kill(requestedSignal ? 'SIGKILL' : signal);
        requestedSignal ??= signal;
      };
      handlers.set(signal, handler); process.on(signal, handler);
    }
    child.once('error', error => {
      if (settled) return; settled = true; cleanup();
      reject(new Error(`Could not run configured app: ${error.message}`));
    });
    child.once('close', (status, childSignal) => {
      if (settled) return; settled = true; cleanup();
      const signal = childSignal ?? requestedSignal;
      resolveResult({ status, signal,
        fallbackStatus: signal ? 128 + (constants.signals?.[signal] ?? 1) : status ?? 1 });
    });
  });
}
