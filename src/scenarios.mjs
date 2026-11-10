import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { location, safePath, validateActions } from './tracer.mjs';

export const SCENARIO_NOTICE = 'DECLARED SCENARIO MAPPINGS ONLY. Actions and expectations are author descriptions, never executed by these commands. Links and witness hashes are not observed execution, passing assertions, test coverage or proof of correctness.';
const hash = value => createHash('sha256').update(value).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = message => { throw new Error(message); };
const MAX_BYTES = 8 * 1024 * 1024, MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const identity = link => JSON.stringify([location(link.source), link.actions, link.step ? location(link.step) : null]);
const sameLink = (a, b) => identity(a) === identity(b) && a.source.sha256 === b.source.sha256
  && a.step?.sha256 === b.step?.sha256 && a.why === b.why;
function object(value, required, optional, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))
      || required.some(key => !Object.hasOwn(value, key))) fail(`Invalid ${label}: expected exactly ${required.join(', ')}${optional.length ? `, optionally ${optional.join(', ')}` : ''}.`);
}
function list(value, label, minimum = 1, maximum = 1000) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(`${label} must contain ${minimum}-${maximum} entries.`);
}
function text(value, label, maximum = 4096) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maximum
      || /[\x00-\x1f\x7f]/.test(value)) fail(`${label} must be nonempty trimmed single-line text, at most ${maximum} characters.`);
}
function identifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) fail(`Invalid ${label}: use 1-128 letters, numbers, underscores or hyphens, beginning with a letter or number.`);
}
function range(value, label, requireHashes) {
  object(value, ['path', 'start', 'end'], ['sha256'], label);
  safePath(value.path);
  if (value.path.length > 4096 || value.path.split('/').includes('.git')) fail(`Invalid ${label} path.`);
  if (!Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end) || value.start < 1 || value.end < value.start) fail(`Invalid ${label} line range.`);
  if ((requireHashes || Object.hasOwn(value, 'sha256')) && !sha(value.sha256)) fail(`${label} requires an exact lowercase SHA-256 hash; use scenario prepare to pin missing hashes.`);
}

// Shared structural validation also lets explicit runtime adapters reject unpinned plans.
// This function does not read a repository or establish that a witness is an assertion.
export function validateScenarioCatalog(catalog, { requireHashes = true } = {}) {
  object(catalog, ['version', 'kind', 'steps', 'scenarios'], [], 'scenario catalog');
  if (catalog.version !== 1 || catalog.kind !== 'scenario-step-catalog') fail('Expected version 1, kind scenario-step-catalog.');
  list(catalog.steps, 'Catalog steps'); list(catalog.scenarios, 'Catalog scenarios');
  const steps = new Map(), scenarios = new Set();
  let declarations = 0, occurrences = 0;
  for (const step of catalog.steps) {
    object(step, ['id', 'title', 'preconditions', 'actions', 'expectations', 'mappings'], [], 'named step');
    identifier(step.id, 'step id'); text(step.title, 'Step title');
    if (steps.has(step.id)) fail(`Duplicate step id: ${step.id}`);
    steps.set(step.id, step);
    list(step.preconditions, `Step ${step.id} preconditions`);
    list(step.actions, `Step ${step.id} actions`);
    list(step.expectations, `Step ${step.id} expectations`);
    list(step.mappings, `Step ${step.id} mappings`, 0);
    for (const value of step.preconditions) text(value, 'Precondition');
    for (const value of step.actions) text(value, 'Action', 16384);
    validateActions(step.actions);
    const expectations = new Set();
    for (const expectation of step.expectations) {
      object(expectation, ['id', 'description', 'witness'], [], 'expectation');
      identifier(expectation.id, 'expectation id'); text(expectation.description, 'Expectation description');
      if (expectations.has(expectation.id)) fail(`Duplicate expectation id in step ${step.id}: ${expectation.id}`);
      expectations.add(expectation.id); range(expectation.witness, 'Expectation witness', requireHashes);
    }
    for (const mapping of step.mappings) {
      object(mapping, ['source', 'expectation', 'why'], [], 'source mapping');
      range(mapping.source, 'Mapping source', requireHashes); identifier(mapping.expectation, 'mapping expectation');
      text(mapping.why, 'Mapping explanation', 16384);
      if (!expectations.has(mapping.expectation)) fail(`Unknown expectation ${mapping.expectation} in step ${step.id}.`);
    }
    declarations += step.preconditions.length + step.actions.length + step.expectations.length + step.mappings.length;
    if (declarations > 20000) fail('Scenario catalog exceeds 20000 declared preconditions, actions, expectations and mappings.');
  }
  for (const scenario of catalog.scenarios) {
    object(scenario, ['id', 'title', 'steps'], [], 'scenario');
    identifier(scenario.id, 'scenario id'); text(scenario.title, 'Scenario title');
    if (scenarios.has(scenario.id)) fail(`Duplicate scenario id: ${scenario.id}`);
    scenarios.add(scenario.id); list(scenario.steps, `Scenario ${scenario.id} steps`);
    for (const id of scenario.steps) {
      identifier(id, 'scenario step reference');
      if (!steps.has(id)) fail(`Unknown step ${id} in scenario ${scenario.id}.`);
    }
    occurrences += scenario.steps.length;
    if (occurrences > 10000) fail('Scenario catalog exceeds 10000 step occurrences.');
  }
  if (Buffer.byteLength(JSON.stringify(catalog)) > MAX_BYTES) fail('Scenario catalog exceeds 8 MiB.');
  return catalog;
}

function catalogPath(tracer, file) {
  safePath(file);
  if (file.split('/').includes('.git') || file === tracer.map || file.startsWith(`${tracer.map}.`)) fail('Scenario catalog must be separate from .git, the sidecar and its working files.');
  let absolute = tracer.root;
  for (const [index, part] of file.split('/').entries()) {
    absolute = resolve(absolute, part);
    const stat = lstatSync(absolute), last = index === file.split('/').length - 1;
    if (stat.isSymbolicLink() || realpathSync(absolute) !== absolute || (last ? !stat.isFile() : !stat.isDirectory())) fail(`Scenario catalog must be a regular unsymlinked repository file: ${file}`);
    if (last && stat.size > MAX_BYTES) fail('Scenario catalog exceeds 8 MiB.');
  }
  return absolute;
}
function readCatalog(tracer, file) {
  const bytes = readFileSync(catalogPath(tracer, file));
  if (bytes.length > MAX_BYTES) fail('Scenario catalog exceeds 8 MiB.');
  const exact = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (exact.includes('\0')) fail('Scenario catalog must be text without NUL bytes.');
  return { catalog: JSON.parse(exact), catalogSha256: hash(bytes) };
}
function pinCatalog(tracer, catalog, state, prepare) {
  validateScenarioCatalog(catalog, { requireHashes: !prepare });
  for (const step of catalog.steps) {
    for (const [range, witness] of [...step.expectations.map(value => [value.witness, true]), ...step.mappings.map(value => [value.source, false])]) {
      const current = tracer.snapshot(range, state, witness);
      if (range.sha256 !== undefined && range.sha256 !== current.sha256) fail(`Scenario ${witness ? 'witness' : 'source'} snippet is stale: ${location(range)}. Review it; supplied hashes are never silently refreshed.`);
      range.sha256 = current.sha256;
    }
  }
  return catalog;
}
function selectedScenarios(catalog, scenarioId) {
  if (scenarioId === undefined) return catalog.scenarios;
  identifier(scenarioId, 'scenario selector');
  const scenario = catalog.scenarios.find(value => value.id === scenarioId);
  if (!scenario) fail(`Unknown scenario id: ${scenarioId}`);
  return [scenario];
}
function compile(catalog, scenarioId) {
  const named = new Map(catalog.steps.map(step => [step.id, step])), links = new Map(), ids = new Map();
  const uniqueSteps = new Set(), sourceRanges = new Set(), witnesses = new Set(), sequences = new Set();
  const totals = { scenarios: 0, uniqueSteps: 0, occurrences: 0, actions: 0, expectations: 0, mappings: 0, uniqueSourceRanges: 0, uniqueWitnessRanges: 0, uniqueActionSequences: 0, proposedLinks: 0 };
  let expandedBytes = 0, expandedActions = 0, mappingActions = 0;
  const consume = value => {
    expandedBytes += Buffer.byteLength(JSON.stringify(value));
    if (expandedBytes > MAX_EXPANDED_BYTES) fail('Expanded scenario plan exceeds 64 MiB; select a smaller scenario.');
  };
  const scenarios = selectedScenarios(catalog, scenarioId).map(scenario => {
    const actions = scenario.steps.flatMap(stepId => named.get(stepId).actions);
    if (actions.length > 10000) fail('Expanded scenario exceeds 10000 actions; split distinct scenarios explicitly.');
    sequences.add(JSON.stringify(actions));
    const prefix = [], occurrences = [];
    for (const [index, stepId] of scenario.steps.entries()) {
      const step = named.get(stepId), expected = new Map(step.expectations.map(value => [value.id, value]));
      prefix.push(...step.actions); expandedActions += prefix.length;
      if (prefix.length > 10000 || expandedActions > 1000000) fail('Expanded scenario plan exceeds the action-prefix limit; select a smaller scenario.');
      const occurrence = { occurrence: index + 1, stepId, title: step.title, preconditions: step.preconditions,
        actions: step.actions, actionPrefix: [...prefix], expectations: step.expectations, mappings: step.mappings };
      consume(occurrence); occurrences.push(occurrence); uniqueSteps.add(stepId);
      totals.occurrences++; totals.actions += step.actions.length; totals.expectations += step.expectations.length; totals.mappings += step.mappings.length;
      if (totals.mappings > 100000) fail('Expanded scenario plan exceeds 100000 mappings; select a smaller scenario.');
      for (const expectation of step.expectations) witnesses.add(location(expectation.witness));
      for (const mapping of step.mappings) {
        mappingActions += actions.length;
        if (mappingActions > 1000000) fail('Expanded scenario mappings exceed the action-sequence limit; select a smaller scenario.');
        sourceRanges.add(location(mapping.source));
        // Step boundaries are review context, never extra distinct manual traces.
        // Every mapping uses this scenario's complete ordered action sequence.
        const candidate = { source: mapping.source, actions, step: expected.get(mapping.expectation).witness, why: mapping.why };
        const key = identity(candidate), id = hash(key).slice(0, 16), previous = links.get(key);
        if (previous && !sameLink(previous, candidate)) fail(`Conflicting scenario mappings for ${location(candidate.source)} and the same action sequence and witness.`);
        if (ids.has(id) && ids.get(id) !== key) fail(`Scenario link id collision: ${id}`);
        if (!previous) { consume(candidate); links.set(key, { id, ...candidate }); ids.set(id, key); }
      }
    }
    return { id: scenario.id, title: scenario.title, actions, occurrences };
  });
  Object.assign(totals, { scenarios: scenarios.length, uniqueSteps: uniqueSteps.size, uniqueSourceRanges: sourceRanges.size,
    uniqueWitnessRanges: witnesses.size, uniqueActionSequences: sequences.size, proposedLinks: links.size });
  return { scenarios, totals, links: [...links.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
}
function load(tracer, file, scenarioId) {
  const input = readCatalog(tracer, file), state = tracer.inventory();
  pinCatalog(tracer, input.catalog, state, false);
  return { ...input, state, ...compile(input.catalog, scenarioId) };
}
function mapBytes(tracer) {
  tracer.validateMapPath();
  return existsSync(tracer.mapPath) ? readFileSync(tracer.mapPath) : Buffer.alloc(0);
}
export function prepareScenarios(tracer, file) {
  const { catalog } = readCatalog(tracer, file);
  pinCatalog(tracer, catalog, tracer.inventory(), true);
  compile(catalog);
  return catalog;
}
export function checkScenarios(tracer, file) {
  const result = load(tracer, file);
  return { kind: 'scenario-step-catalog-integrity', notice: SCENARIO_NOTICE, catalogSha256: result.catalogSha256,
    valid: true, totals: result.totals };
}
export function reportScenarios(tracer, file, scenarioId) {
  const result = load(tracer, file, scenarioId), texts = new Map(result.state.files);
  let expandedBytes = 0;
  const snippet = range => {
    if (!texts.has(range.path)) texts.set(range.path, tracer.readLines(range.path));
    const value = texts.get(range.path).slice(range.start - 1, range.end).join('');
    if (hash(value) !== range.sha256) fail(`Scenario snippet changed while reporting: ${location(range)}`);
    expandedBytes += Buffer.byteLength(value);
    if (expandedBytes > MAX_EXPANDED_BYTES) fail('Expanded scenario snippets exceed 64 MiB; select a smaller scenario.');
    return value;
  };
  const selectedSteps = new Set(result.scenarios.flatMap(scenario => scenario.occurrences.map(occurrence => occurrence.stepId)));
  const steps = result.catalog.steps.filter(step => selectedSteps.has(step.id)).map(step => ({ ...step,
    expectations: step.expectations.map(expectation => ({ ...expectation, witnessSnippet: snippet(expectation.witness) })),
    mappings: step.mappings.map(mapping => ({ ...mapping, sourceSnippet: snippet(mapping.source) })) }));
  const scenarios = result.scenarios.map(scenario => {
    let actionEnd = 0;
    const occurrences = scenario.occurrences.map(occurrence => {
      const actionStart = actionEnd + 1;
      actionEnd += occurrence.actions.length;
      return { occurrence: occurrence.occurrence, stepId: occurrence.stepId, actionStart, actionEnd };
    });
    return { id: scenario.id, title: scenario.title, actions: scenario.actions, occurrences };
  });
  return { kind: 'scenario-step-catalog-report', notice: SCENARIO_NOTICE, catalogSha256: result.catalogSha256,
    mapSha256: hash(mapBytes(tracer)), totals: result.totals, steps, scenarios };
}
export function scenarioPacket(tracer, file, scenarioId) {
  return { version: 1, links: load(tracer, file, scenarioId).links };
}

// Re-read referenced bytes before the locked mutation returns. One inventory is used
// for all schema/integrity checks; no stat-key cache can reuse an earlier command.
function recheckRanges(tracer, catalog, data) {
  const ranges = [], fullFiles = [];
  for (const step of catalog.steps) {
    ranges.push(...step.expectations.map(value => value.witness), ...step.mappings.map(value => value.source));
  }
  for (const link of data.links) { ranges.push(link.source); if (link.step) ranges.push(link.step); }
  for (const row of [...(data.commentExclusions ?? []), ...(data.deadCode ?? [])]) {
    ranges.push(row.source); fullFiles.push({ path: row.source.path, sha256: row.fileSha256 });
  }
  const files = new Map(), current = path => {
    if (!files.has(path)) files.set(path, tracer.readLines(path));
    return files.get(path);
  };
  for (const range of ranges) {
    const lines = current(range.path);
    if (range.end > lines.length || hash(lines.slice(range.start - 1, range.end).join('')) !== range.sha256) fail(`Source or witness changed during scenario integration: ${location(range)}`);
  }
  for (const file of fullFiles) if (hash(current(file.path).join('')) !== file.sha256) fail(`Declaration source changed during scenario integration: ${file.path}`);
}
export function linkScenarios(tracer, file, { scenarioId, expectedCatalogSha256, expectedMapSha256, reviewed } = {}) {
  if (reviewed !== true) fail('scenario link requires --reviewed after semantic review of sources, actions and expectation witnesses.');
  if (!sha(expectedCatalogSha256) || !sha(expectedMapSha256)) fail('scenario link requires exact lowercase --expect-catalog-sha256 and --expect-map-sha256 values.');
  catalogPath(tracer, file);
  return tracer.mutate(data => {
    const before = mapBytes(tracer);
    if (hash(before) !== expectedMapSha256) fail('Sidecar bytes changed since review; expected map SHA-256 does not match.');
    if (before.length && JSON.stringify(JSON.parse(before.toString('utf8'))) !== JSON.stringify(data)) fail('Sidecar changed while acquiring the scenario integration lock.');
    const input = readCatalog(tracer, file);
    if (input.catalogSha256 !== expectedCatalogSha256) fail('Scenario catalog bytes changed since review; expected catalog SHA-256 does not match.');
    const state = tracer.inventory();
    pinCatalog(tracer, input.catalog, state, false);
    const result = compile(input.catalog, scenarioId);
    const invalid = [...tracer.inspect(data, state), ...tracer.inspectComments(data, state), ...tracer.inspectDeadCode(data, state)].filter(row => row.errors.length);
    if (invalid.length) fail('Sidecar contains invalid or stale links or declarations. Run check and repair them explicitly before scenario integration.');
    const byIdentity = new Map(), byId = new Map();
    for (const previous of data.links) {
      const key = identity(previous), duplicate = byIdentity.get(key);
      if (duplicate && !sameLink(duplicate, previous)) fail(`Sidecar contains conflicting links for ${location(previous.source)}.`);
      byIdentity.set(key, previous); byId.set(previous.id, previous);
    }
    const additions = [], imported = [];
    for (const candidate of result.links) {
      const previous = byIdentity.get(identity(candidate));
      if (previous) {
        if (!sameLink(previous, candidate)) fail(`Link ${previous.id} already exists with different content. Review it, then unlink and relink; hashes and explanations are never silently refreshed.`);
        imported.push(previous.id); continue;
      }
      if (byId.has(candidate.id)) fail(`Link id collision: ${candidate.id}. Review the sidecar explicitly.`);
      additions.push(candidate); imported.push(candidate.id); byId.set(candidate.id, candidate); byIdentity.set(identity(candidate), candidate);
    }
    recheckRanges(tracer, input.catalog, data);
    if (readCatalog(tracer, file).catalogSha256 !== expectedCatalogSha256) fail('Scenario catalog changed during integration.');
    if (hash(mapBytes(tracer)) !== expectedMapSha256) fail('Sidecar changed during integration.');
    // Append only: existing records, ordering and arbitrary metadata remain intact.
    data.links.push(...additions);
    return { kind: 'scenario-manual-link-integration', notice: SCENARIO_NOTICE, catalogSha256: input.catalogSha256,
      previousMapSha256: expectedMapSha256, mapSha256: additions.length ? hash(`${JSON.stringify(data, null, 2)}\n`) : expectedMapSha256,
      changed: additions.length > 0, added: additions.length, existing: imported.length - additions.length, total: data.links.length,
      scenarioIds: result.scenarios.map(scenario => scenario.id), links: imported };
  });
}
