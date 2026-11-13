import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { safePath } from './tracer.mjs';
import { readProposal, inspectProposal } from './proposals.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
function object(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || required.some(key => !Object.hasOwn(value, key))
      || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('Invalid route catalog object.');
}
function text(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 16384 || /[\x00-\x1f\x7f]/.test(value)) fail('Invalid route catalog text.');
}
function list(value, empty = false) {
  if (!Array.isArray(value) || !empty && !value.length || value.length > 100000) fail('Invalid route catalog array.');
}
function regularFile(root, file) {
  safePath(file);
  if (file.split('/').includes('.git')) fail('Route paths cannot enter .git.');
  let path = root;
  const parts = file.split('/');
  for (const [index, part] of parts.entries()) {
    path = resolve(path, part);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || realpathSync(path) !== path
        || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) fail(`Route path must be a regular unsymlinked repository file: ${file}`);
  }
  return path;
}
function readRoutes(root, file) {
  text(file);
  const path = resolve(root, file), info = lstatSync(path);
  if (!info.isFile() || realpathSync(path) !== path) fail('Route catalog must be a regular unsymlinked file.');
  if (info.size > 32 * 1024 * 1024) fail('Route catalog exceeds 32 MiB.');
  const bytes = readFileSync(path);
  if (bytes.length > 32 * 1024 * 1024) fail('Route catalog exceeds 32 MiB.');
  const catalog = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  object(catalog, ['version', 'routes']);
  if (catalog.version !== 1) fail('Expected version-1 route catalog.');
  list(catalog.routes, true);
  const ids = new Map(), executions = new Map();
  for (const route of catalog.routes) {
    object(route, ['id', 'paths', 'argv'], ['restriction']);
    if (typeof route.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_/-]{0,255}$/.test(route.id)) fail('Invalid route id.');
    list(route.paths); list(route.argv);
    for (const path of route.paths) regularFile(root, path);
    for (const arg of route.argv) {
      if (typeof arg !== 'string' || arg.length > 16384 || /[\x00-\x1f\x7f]/.test(arg)) fail('Invalid route argv string.');
    }
    if (Object.hasOwn(route, 'restriction')) text(route.restriction);
    const argvKey = JSON.stringify(route.argv), identity = JSON.stringify([route.argv, route.restriction ?? null]);
    if (ids.has(route.id) && ids.get(route.id) !== identity) fail(`Ambiguous duplicate route id: ${route.id}`);
    ids.set(route.id, identity);
    // Aliases share an execution only when the complete ordered argv matches.
    // Any restriction on that execution remains effective across its aliases.
    let execution = executions.get(argvKey);
    if (!execution) {
      execution = { routeIds: [], argv: [...route.argv], paths: [], restrictions: [] };
      executions.set(argvKey, execution);
    }
    if (!execution.routeIds.includes(route.id)) execution.routeIds.push(route.id);
    for (const path of route.paths) if (!execution.paths.includes(path)) execution.paths.push(path);
    if (route.restriction && !execution.restrictions.includes(route.restriction)) execution.restrictions.push(route.restriction);
  }
  return { routesSha256: hash(bytes), executions: [...executions.values()] };
}

export function bindProposalRoutes(tracer, file, routesFile) {
  const proposal = readProposal(tracer.root, file, tracer.map);
  const inspected = inspectProposal(tracer.root, proposal.value, tracer.inventory());
  const catalog = readRoutes(tracer.root, routesFile);
  const bindings = [], plans = [];
  for (const execution of catalog.executions) {
    const matches = proposal.value.scenarios.map(plan => ({ planId: plan.id, paths: plan.existingPaths.filter(path => execution.paths.includes(path)) }))
      .filter(match => match.paths.length);
    if (!matches.length) continue;
    const planIds = matches.map(match => match.planId);
    bindings.push({ ...execution, selectable: execution.restrictions.length === 0, status: 'provisional', assertionMatch: 'unknown',
      planIds, matches, basis: 'exact-existing-path', measurementAdapter: 'unknown',
      predictedSources: inspected.candidates.filter(({ row }) => row.scenarioIds.some(id => planIds.includes(id)))
        .map(({ row, current, errors }) => ({ rangeId: row.rangeId, source: row.source,
          status: current ? 'provisional' : errors.every(error => error.startsWith('Stale ')) ? 'stale' : 'invalid',
          scoreEligible: current, issues: [...errors] })) });
  }
  for (const plan of proposal.value.scenarios) {
    const candidates = bindings.filter(binding => binding.planIds.includes(plan.id));
    const matched = new Set(candidates.flatMap(binding => binding.matches.find(match => match.planId === plan.id).paths));
    plans.push({ id: plan.id, state: plan.state, status: candidates.some(binding => binding.selectable) ? 'candidate' : candidates.length ? 'restricted' : 'unmatched',
      routeIds: candidates.flatMap(binding => binding.routeIds), unmatchedPaths: plan.existingPaths.filter(path => !matched.has(path)) });
  }
  return { version: 1, kind: 'provisional-plan-route-bindings', status: 'provisional', assertionMatch: 'unknown',
    notice: 'Exact path joins only. Source predictions and route candidates are provisional. No route is executed, assertion matched, manual link promoted or coverage observed.',
    proposalSha256: proposal.proposalSha256, routesSha256: catalog.routesSha256,
    proposalValidation: { valid: inspected.issues.length === 0, issues: inspected.issues }, bindings, plans,
    unmatchedRouteIds: catalog.executions.filter(execution => !bindings.some(binding => JSON.stringify(binding.argv) === JSON.stringify(execution.argv)))
      .flatMap(execution => execution.routeIds) };
}
