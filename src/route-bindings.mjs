import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { safePath } from './tracer.mjs';
import { readProposal, inspectProposal } from './proposals.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
const actionSlug = /^[a-z][a-z0-9-]{0,79}$/;
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
function nativeActionSpan(span, label) {
  object(span, ['path', 'start', 'end', 'sha256']);
  safePath(span.path);
  const { start, end, sha256 } = span;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start
      || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) fail(`Invalid native group action ${label}.`);
}

function addNativeCaseActions(actionCases, entries, selector, journey) {
  list(entries);
  const declared = new Set();
  for (const entry of entries) {
    object(entry, ['id', 'command', 'condition'], ['trigger', 'entryPoint', 'branch']);
    const { id, command, condition, trigger, entryPoint, branch } = entry;
    if (![id, command, condition].every(part => typeof part === 'string' && actionSlug.test(part))) fail('Invalid native group action.');
    if (trigger !== undefined) { text(trigger); if (trigger.length > 128) fail('Invalid native group action trigger.'); }
    if (entryPoint !== undefined) nativeActionSpan(entryPoint, 'entry point');
    if (branch !== undefined) {
      if (entryPoint === undefined) fail('Native group action branch requires an entry point.');
      nativeActionSpan(branch, 'branch');
    }
    const key = JSON.stringify([id, condition]);
    if (declared.has(key)) fail('Duplicate native group action condition.');
    declared.add(key);
    if (!actionCases.has(id)) actionCases.set(id, { id, command, trigger, cases: [] });
    const action = actionCases.get(id);
    if (action.command !== command || action.trigger !== trigger) fail('Conflicting native group action definition.');
    action.cases.push({ condition, selector, journey, ...(entryPoint && { entryPoint }), ...(branch && { branch }) });
  }
}

function nativeScenarioRoutes(discovery, actionCases) {
  object(discovery, ['schemaVersion', 'kind', 'selection', 'scenarios'], ['launchModes']);
  if (discovery.schemaVersion !== 1) fail('Expected version-1 native CLI scenario discovery.');
  list(discovery.scenarios, true);
  const { launchModes } = discovery;
  if (launchModes !== undefined) {
    list(launchModes, true);
    if (new Set(launchModes).size !== launchModes.length || launchModes.some(mode =>
      typeof mode !== 'string' || !/^--[a-z][a-z0-9-]{0,63}$/.test(mode))) fail('Invalid or duplicate native launch mode.');
  }
  const { selection } = discovery;
  object(selection, ['mode', 'availableScenarioCount', 'selectedScenarioCount']);
  const { mode, availableScenarioCount, selectedScenarioCount } = selection;
  if (!['all', 'subset'].includes(mode) || !Number.isSafeInteger(availableScenarioCount)
      || selectedScenarioCount !== discovery.scenarios.length || availableScenarioCount < selectedScenarioCount
      || (mode === 'all' && availableScenarioCount !== selectedScenarioCount)) fail('Invalid native scenario selection counts.');

  const ids = new Set(), routes = [];
  for (const scenario of discovery.scenarios) {
    object(scenario, ['id', 'path'], ['groups', 'restriction', 'groupWitnessPaths', 'groupActions']);
    const { id, path } = scenario;
    if (typeof id !== 'string' || !/^(?:journeys\/)?[A-Za-z0-9_-]+$/.test(id)
        || ids.has(id) || path !== `tests/e2e/${id}.mjs`) fail('Invalid or duplicate native scenario identity.');
    ids.add(id);
    const argv = ['test', '--scenario', id];
    const route = { id, paths: [path], argv, journeys: [path] };
    if (Object.hasOwn(scenario, 'restriction')) {
      const restriction = scenario.restriction;
      object(restriction, ['status', 'reason', 'detail']);
      if (restriction.status !== 'blocked' || Object.hasOwn(scenario, 'groups')) fail('Invalid native scenario restriction.');
      text(restriction.reason); text(restriction.detail);
      route.restriction = `${restriction.reason} (${restriction.detail})`;
    }
    routes.push(route);
    const { groupWitnessPaths, groupActions } = scenario;
    if (Object.hasOwn(scenario, 'groupWitnessPaths')) {
      if (!Array.isArray(scenario.groups)) fail('Native group witnesses require listed groups.');
      object(groupWitnessPaths, [], scenario.groups);
      for (const paths of Object.values(groupWitnessPaths)) {
        list(paths);
        if (new Set(paths).size !== paths.length || paths.some(path => typeof path !== 'string'
          || !/^tests\/e2e\/(?:journeys\/)?support\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.mjs$/.test(path))) {
          fail('Invalid or duplicate native group witness path.');
        }
      }
    }
    if (groupActions !== undefined) {
      if (!Array.isArray(scenario.groups)) fail('Native group actions require listed groups.');
      object(groupActions, [], scenario.groups);
    }
    if (Object.hasOwn(scenario, 'groups')) {
      list(scenario.groups);
      if (new Set(scenario.groups).size !== scenario.groups.length) fail('Duplicate native scenario group.');
      for (const group of scenario.groups) {
        if (typeof group !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(group)) fail('Invalid native scenario group.');
        const witnesses = groupWitnessPaths && Object.hasOwn(groupWitnessPaths, group) ? groupWitnessPaths[group] : [];
        routes.push({ id: `${id}/group/${group}`, paths: [path, ...witnesses], argv: [...argv, '--group', group], journeys: [`${path}#${group}`] });
        if (groupActions && Object.hasOwn(groupActions, group)) {
          addNativeCaseActions(actionCases, groupActions[group], `${id}#${group}`, `${path}#${group}`);
        }
      }
    }
  }
  return { version: 1, routes, ...(launchModes && { actions: launchModes.map(id => ({ id })) }) };
}

function readCatalogDocument(root, file) {
  text(file);
  const path = resolve(root, file), info = lstatSync(path);
  if (!info.isFile() || realpathSync(path) !== path) fail('Route catalog must be a regular unsymlinked file.');
  if (info.size > 32 * 1024 * 1024) fail('Route catalog exceeds 32 MiB.');
  const bytes = readFileSync(path);
  if (bytes.length > 32 * 1024 * 1024) fail('Route catalog exceeds 32 MiB.');
  return { input: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), sha256: hash(bytes) };
}

function nativeActionIds(input) {
  if (input?.protocol !== 1 || input.driver !== 'UIKit controls') fail('Expected Scriv UIKit CLI capabilities protocol 1.');
  list(input.commands);
  const ids = new Set(), measurementActions = new Map();
  for (const key of ['commands', 'publicDelegateCommands', 'publicTextInputCommands', 'semanticApplicationCommands',
    'semanticGestureCommands', 'semanticMenuActionScopes', 'syntheticFixtureCommands']) {
    if (!Object.hasOwn(input, key)) continue;
    list(input[key], true);
    for (const id of input[key]) {
      text(id);
      ids.add(id);
      if (key !== 'semanticMenuActionScopes') measurementActions.set(id, `scriv ${id}`);
    }
  }
  if (measurementActions.has('menu-action')) {
    for (const scope of input.semanticMenuActionScopes ?? []) {
      if (/^[a-z][a-z0-9-]{0,63}$/.test(scope) && !measurementActions.has(scope)) {
        measurementActions.set(scope, `scriv menu-action --scope ${scope}`);
      }
    }
  }
  const semanticActionIds = new Set([...input.semanticApplicationCommands ?? [], ...input.semanticGestureCommands ?? []]);
  return { ids, measurementActions, semanticActionIds };
}

export function readRoutes(root, file, { capabilitiesFile } = {}) {
  const { input, sha256: routesSha256 } = readCatalogDocument(root, file);
  const native = input?.kind === 'native-cli-scenario-catalog';
  const actionCases = new Map();
  const catalog = native ? nativeScenarioRoutes(input, actionCases) : input;
  object(catalog, ['version', 'routes'], ['actions']);
  if (catalog.version !== 1) fail('Expected version-1 route catalog.');
  list(catalog.routes, true);
  const ids = new Map(), executions = new Map(), journeys = new Map();
  for (const route of catalog.routes) {
    object(route, ['id', 'paths', 'argv'], ['restriction', 'journeys']);
    if (!native && (typeof route.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_/-]{0,255}$/.test(route.id))) fail('Invalid route id.');
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
    if (Object.hasOwn(route, 'journeys')) {
      list(route.journeys);
      for (const journey of route.journeys) {
        text(journey);
        if (journeys.has(journey) && journeys.get(journey) !== execution) fail(`Ambiguous recorded journey: ${journey}`);
        journeys.set(journey, execution);
      }
    }
  }
  let actions;
  if (Object.hasOwn(catalog, 'actions')) {
    list(catalog.actions, true);
    actions = new Map();
    for (const action of catalog.actions) {
      object(action, ['id'], ['restriction']);
      text(action.id);
      if (Object.hasOwn(action, 'restriction')) text(action.restriction);
      if (actions.has(action.id)) fail(`Duplicate CLI action id: ${action.id}`);
      actions.set(action.id, action);
    }
  }
  let capabilitiesSha256, measurementActions, semanticActionIds;
  if (capabilitiesFile !== undefined) {
    const { input: capabilities, sha256 } = readCatalogDocument(root, capabilitiesFile);
    capabilitiesSha256 = sha256;
    const discovered = nativeActionIds(capabilities);
    actions = new Map([...discovered.ids, ...(native ? input.launchModes ?? [] : [])].map(id => [id, actions?.get(id) ?? { id }]));
    ({ measurementActions, semanticActionIds } = discovered);
  }
  return { routesSha256, executions: [...executions.values()], actions, journeys, actionCases, capabilitiesSha256, measurementActions, semanticActionIds,
    ...(native && { launchActions: ['launch isolated Scriv through the CLI', 'scriv capabilities'] }) };
}

function sourcePrediction({ row, current, errors }) {
  return { rangeId: row.rangeId, source: row.source,
    status: current ? 'provisional' : errors.every(error => error.startsWith('Stale ')) ? 'stale' : 'invalid',
    scoreEligible: current, issues: [...errors] };
}

function matchBehavior(plan, actions, candidates) {
  const hasRoute = candidates.some(binding => binding.selectable);
  const actionIds = plan.actionIds ?? [];
  const missingActionIds = actionIds.filter(id => !actions.has(id));
  const restrictions = [...new Set([
    plan.restriction, ...actionIds.map(id => actions.get(id)?.restriction),
    ...(hasRoute ? [] : candidates.flatMap(binding => binding.restrictions))
  ].filter(Boolean))];
  let next;
  if (restrictions.length) next = 'blocked';
  else if (!plan.entryPoint && !hasRoute) next = 'review-runtime-path';
  else if (!plan.entryPoint || plan.actionIds === undefined) next = 'review-cli-match';
  else if (!actionIds.length || missingActionIds.length) next = 'needs-cli-action';
  else if (!hasRoute || plan.state !== 'existing') next = 'needs-scenario';
  else next = 'action-and-scenario';
  return { entryPoint: plan.entryPoint ?? null, actionIds: plan.actionIds ?? null, missingActionIds, restrictions, next,
    ...(plan.captureMode && { captureMode: plan.captureMode }) };
}

export function bindProposalRoutes(tracer, file, routesFile) {
  return bindCatalogPlans(tracer, file, readRoutes(tracer.root, routesFile));
}

export function bindCatalogPlans(tracer, file, catalog) {
  const proposal = readProposal(tracer.root, file, tracer.map);
  const inspected = inspectProposal(tracer.root, proposal.value, tracer.inventory());
  const bindings = [], plans = [], unmatchedRouteIds = [], byPlan = new Map();
  for (const execution of catalog.executions) {
    const matches = proposal.value.scenarios
      .filter(plan => !plan.routeIds || plan.routeIds.some(id => execution.routeIds.includes(id)))
      .map(plan => ({ planId: plan.id, paths: plan.existingPaths.filter(path => execution.paths.includes(path)) }))
      .filter(match => match.paths.length);
    if (!matches.length) {
      unmatchedRouteIds.push(...execution.routeIds);
      continue;
    }
    const planIds = matches.map(match => match.planId);
    const planIdSet = new Set(planIds);
    const binding = { ...execution, selectable: execution.restrictions.length === 0, status: 'provisional', assertionMatch: 'unknown',
      planIds, matches, basis: 'exact-existing-path', measurementAdapter: 'unknown',
      predictedSources: inspected.candidates.filter(({ row }) => row.scenarioIds.some(id => planIdSet.has(id)))
        .map(sourcePrediction) };
    bindings.push(binding);
    for (const id of planIds) {
      if (!byPlan.has(id)) byPlan.set(id, []);
      byPlan.get(id).push(binding);
    }
  }
  for (const plan of proposal.value.scenarios) {
    const candidates = byPlan.get(plan.id) ?? [];
    const matched = new Set(candidates.flatMap(binding => binding.matches.find(match => match.planId === plan.id).paths));
    const routeIds = candidates.flatMap(binding => binding.routeIds).filter(id => !plan.routeIds || plan.routeIds.includes(id));
    plans.push({ id: plan.id, state: plan.state, status: candidates.some(binding => binding.selectable) ? 'candidate' : candidates.length ? 'restricted' : 'unmatched',
      routeIds, unmatchedPaths: plan.existingPaths.filter(path => !matched.has(path)),
      ...(plan.routeIds && { unmatchedRouteIds: plan.routeIds.filter(id => !routeIds.includes(id)) }),
      ...(catalog.actions && { title: plan.title, featureId: plan.featureId, behavior: matchBehavior(plan, catalog.actions, candidates) }) });
  }
  return { version: 1, kind: 'provisional-plan-route-bindings', status: 'provisional', assertionMatch: 'unknown',
    notice: 'Exact path joins only. Source predictions and route candidates are provisional. No route is executed, assertion matched, manual link promoted or coverage observed.',
    proposalSha256: proposal.proposalSha256, routesSha256: catalog.routesSha256,
    proposalValidation: { valid: inspected.issues.length === 0, issues: inspected.issues }, bindings, plans,
    ...(catalog.actions && { behaviorRanges: inspected.candidates.map(candidate => ({
      ...sourcePrediction(candidate), featureId: candidate.row.featureId, planIds: candidate.row.scenarioIds
    })) }),
    unmatchedRouteIds };
}
