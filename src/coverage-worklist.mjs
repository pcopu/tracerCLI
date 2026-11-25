import { createHash } from 'node:crypto';
import { bindCatalogPlans, readRoutes } from './route-bindings.mjs';
import { gapsMeasured, innermostFunction } from './measured.mjs';
import { compactRanges, parseRange } from './tracer.mjs';
import { guideCoverageWorklist } from './coverage-guidance.mjs';

const nextSteps = ['action-and-scenario', 'needs-scenario', 'needs-cli-action', 'review-cli-match', 'review-runtime-path', 'blocked'];
const byImpact = (a, b) => b.gapLines - a.gapLines || a.id.localeCompare(b.id);

function addLines(target, path, numbers) {
  const lines = target.get(path) ?? new Set();
  for (const line of numbers) lines.add(line);
  target.set(path, lines);
}

function summarize(files) {
  const sources = [...files].map(([path, lines]) => ({ path, gapLines: lines.size,
    gapRanges: compactRanges([...lines].sort((a, b) => a - b)) }));
  sources.sort((a, b) => b.gapLines - a.gapLines || a.path.localeCompare(b.path));
  return { gapLines: sources.reduce((sum, source) => sum + source.gapLines, 0), sources };
}

function sourceSelection(selectors) {
  if (!selectors?.length) return undefined;
  if (selectors.length > 32) throw new Error('Worklist accepts at most 32 --source selectors.');
  const sources = selectors.map(selector => parseRange(selector, false)), byPath = new Map();
  for (const source of sources) {
    if (!byPath.has(source.path)) byPath.set(source.path, []);
    byPath.get(source.path).push(source);
  }
  return { sources, intersects: (path, start, end = start) => byPath.get(path)?.some(window =>
    start <= (window.end ?? Infinity) && (window.start ?? 1) <= end) ?? false };
}

const expandRanges = ranges => ranges.flatMap(([start, end]) => Array.from({ length: end - start + 1 }, (_, i) => start + i));

function gapFiles(measured, focus) {
  const current = new Map(), unavailable = [];
  let sourceFocus;
  if (focus) {
    const unknown = focus.sources.filter(({ path, start = 1, end = Infinity }) =>
      !measured.files.some(file => file.path === path && file.instrumentedRanges.some(([lo, hi]) => start <= hi && lo <= end)));
    sourceFocus = { sources: focus.sources, instrumentedLines: 0, observedPassingLines: 0, gapLines: 0, unknown };
  }
  for (const file of measured.files) {
    const { path, status } = file;
    let { gapLines, gapRanges } = file.passedOnlyKnown;
    if (focus) {
      if (!focus.intersects(path, 1, Infinity)) continue;
      const select = line => focus.intersects(path, line);
      const instrumentedLines = expandRanges(file.instrumentedRanges).filter(select).length;
      if (!instrumentedLines) continue;
      const gaps = expandRanges(gapRanges).filter(select);
      gapLines = gaps.length;
      gapRanges = compactRanges(gaps);
      sourceFocus.instrumentedLines += instrumentedLines;
      sourceFocus.observedPassingLines += instrumentedLines - gapLines;
      sourceFocus.gapLines += gapLines;
    }
    if (status !== 'current') unavailable.push({ path, status, gapLines, gapRanges });
    else current.set(path, { sha256: file.currentSource.sha256, lines: expandRanges(gapRanges) });
  }
  return { current, unavailable, sourceFocus };
}

function remainingGaps(current, assigned) {
  const unassigned = [];
  for (const [path, file] of current) {
    const lines = file.lines.filter(line => !assigned.get(path)?.has(line));
    if (lines.length) unassigned.push({ path, gapLines: lines.length, gapRanges: compactRanges(lines) });
  }
  unassigned.sort((a, b) => b.gapLines - a.gapLines || a.path.localeCompare(b.path));
  return unassigned;
}

const fileSummary = (rows, limit) => ({ files: rows.length, gapLines: rows.reduce((sum, row) => sum + row.gapLines, 0), items: rows.slice(0, limit) });

// A later selector earns credit only for source lines earlier selections do not nominate.
function marginalCandidates(rows, limit) {
  const selected = [], nominated = new Map();
  const score = ({ files }) => [...files].reduce((sum, [path, lines]) =>
    sum + [...lines].filter(line => !nominated.get(path)?.has(line)).length, 0);
  while (rows.length && selected.length < limit) {
    let index = -1, marginalGapLines = 0;
    for (const [i, row] of rows.entries()) {
      const additional = score(row);
      if (additional > marginalGapLines) { index = i; marginalGapLines = additional; }
    }
    if (index < 0) break;
    const [row] = rows.splice(index, 1);
    for (const [path, lines] of row.files) addLines(nominated, path, lines);
    selected.push({ ...row, marginalGapLines });
  }
  return selected;
}

function extensionCandidates(surroundingIntervals, journeys, current, assigned, pending, limit, batch) {
  const byGap = new Map(), byExecution = new Map();
  for (const example of surroundingIntervals) {
    const { path, range, journey } = example, key = JSON.stringify([path, range]);
    if (!byGap.has(key)) byGap.set(key, { path, range, executions: new Map() });
    const executions = byGap.get(key).executions, execution = journeys.get(journey);
    if (!executions.has(execution)) executions.set(execution, example);
  }

  let gapLines = 0, exclusiveGapLines = 0, restrictedGapLines = 0;
  for (const { path, range: [start, end], executions } of byGap.values()) {
    const lines = current.get(path)?.lines.filter(line => start <= line && line <= end && !assigned?.get(path)?.has(line)
      && !pending?.get(path)?.has(line)) ?? [];
    if (!lines.length) continue;
    const selectableCount = [...executions.keys()].filter(execution => !execution.restrictions.length).length;
    if (selectableCount) gapLines += lines.length;
    if (selectableCount === 1) exclusiveGapLines += lines.length;
    if (selectableCount < executions.size) restrictedGapLines += lines.length;
    for (const [execution, example] of executions) {
      if (!byExecution.has(execution)) byExecution.set(execution, { files: new Map(), exclusiveGapLines: 0, exclusiveExamples: [], sharedExamples: [] });
      const candidate = byExecution.get(execution);
      const exclusive = selectableCount === 1 && !execution.restrictions.length;
      addLines(candidate.files, path, lines);
      if (exclusive) candidate.exclusiveGapLines += lines.length;
      const examples = exclusive ? candidate.exclusiveExamples : candidate.sharedExamples;
      if (examples.length < 3) examples.push(example);
    }
  }
  const rows = [...byExecution].map(([{ routeIds, argv, restrictions }, candidate]) => ({ routeIds, argv, restrictions,
    files: candidate.files, ...summarize(candidate.files), exclusiveGapLines: candidate.exclusiveGapLines,
    examples: candidate.exclusiveExamples.concat(candidate.sharedExamples).slice(0, 3) }));
  rows.sort((a, b) => b.exclusiveGapLines - a.exclusiveGapLines || b.gapLines - a.gapLines || a.routeIds[0].localeCompare(b.routeIds[0]));
  const ready = rows.filter(row => !row.restrictions.length), restricted = rows.filter(row => row.restrictions.length);
  if (batch) for (const row of ready) batch.push(row);
  const count = ready.length;
  const publicRow = ({ files, ...row }) => row;
  return { count, gapLines, exclusiveGapLines, items: marginalCandidates(ready, limit).map(publicRow),
    restricted: { count: restricted.length, gapLines: restrictedGapLines, items: restricted.slice(0, limit).map(publicRow) } };
}

function nativeCaseBatch(candidates, { limit, held, pending, startup = false, includeExamples = false }) {
  const bySelector = new Map();
  for (const { argv, routeIds, files, examples } of candidates) {
    // Only use argv from the validated native discovery catalog.
    const [, , id, , group] = argv;
    const selector = group ? `${id}#${group}` : id;
    if (!bySelector.has(selector)) bySelector.set(selector, { selector, routeIds, files: new Map(),
      ...(includeExamples && { examples }) });
    const target = bySelector.get(selector).files;
    for (const [path, lines] of files) {
      const eligible = [...lines].filter(line => !held?.get(path)?.has(line) && !pending?.get(path)?.has(line));
      if (eligible.length) addLines(target, path, eligible);
    }
  }
  const rows = [...bySelector.values()].sort((a, b) => a.selector.localeCompare(b.selector));
  const cases = marginalCandidates(rows, limit).map(({ files, ...row }) => ({ ...row, ...summarize(files) }));
  return { argv: cases.length ? ['test', ...(startup ? ['--coverage-startup'] : []),
    ...cases.flatMap(({ selector }) => ['--case', selector])] : [],
    candidateGapLines: cases.reduce((count, row) => count + row.marginalGapLines, 0), cases };
}

function replayCandidates(sourcesByRoute, { held, pending, limit, failures, focus }) {
  const rows = [], union = new Map();
  for (const [execution, sources] of sourcesByRoute) {
    const available = new Map();
    for (const [path, lines] of sources) {
      const eligible = [...lines].filter(line => !held?.get(path)?.has(line) && !pending?.get(path)?.has(line) && (!focus || focus.intersects(path, line)));
      if (eligible.length) { addLines(available, path, eligible); addLines(union, path, eligible); }
    }
    if (available.size) rows.push({ execution, files: available, ...summarize(available) });
  }
  const count = rows.length;
  rows.sort((a, b) => a.execution.routeIds[0].localeCompare(b.execution.routeIds[0]));
  const items = marginalCandidates(rows, limit).map(({ execution, sources, gapLines, marginalGapLines }) => ({
    routeIds: execution.routeIds, argv: execution.argv, sources, gapLines, marginalGapLines,
    ...(failures && { failure: failures.get(execution) }),
  }));
  return { count, gapLines: summarize(union).gapLines, items };
}

function runtimeReview(tracer, data, state, measuredFiles, current, assigned, focus, limit) {
  if (!data.deadCode?.length) return undefined;
  const files = new Map(measuredFiles.map(file => [file.path, file]));
  const items = [], invalid = [], marked = new Map(), pending = new Map(), conflicts = new Map();
  for (const { mark, errors } of tracer.inspectDeadCode(data, state)) {
    const { path, start, end } = mark.source ?? {};
    if (focus && path && !focus.intersects(path, start, end)) continue;
    if (errors.length) {
      invalid.push({ id: mark.id, errors });
      continue;
    }
    const file = files.get(path);
    const range = line => start <= line && line <= end && (!focus || focus.intersects(path, line));
    const comparable = file?.status === 'current' && file.currentSource.sha256 === mark.fileSha256;
    const observed = comparable ? expandRanges(file.observedRanges).filter(range) : [];
    const gaps = comparable ? (current.get(path)?.lines ?? []).filter(range) : [];
    const witnessed = gaps.filter(line => assigned.get(path)?.has(line));
    const disposition = observed.length ? 'observed-execution' : witnessed.length ? 'witness-conflict'
      : gaps.length ? 'review-removal' : 'unmeasured';
    if (gaps.length) {
      addLines(marked, path, gaps);
      addLines(disposition === 'review-removal' ? pending : conflicts, path, gaps);
    }
    items.push({ ...mark, disposition, gapLines: gaps.length, gapRanges: compactRanges(gaps),
      observedRanges: compactRanges(observed), witnessedGapRanges: compactRanges(witnessed) });
  }
  for (const [path, lines] of conflicts) for (const line of lines) pending.get(path)?.delete(line);
  items.sort(byImpact);
  return { pending, report: { count: items.length, gapLines: summarize(marked).gapLines,
    pendingGapLines: summarize(pending).gapLines, items: items.slice(0, limit),
    invalid: { count: invalid.length, items: invalid.slice(0, limit) } } };
}

function neighboringEvidence(files, examples) {
  const supported = new Map();
  let example;
  for (const candidate of examples ?? []) {
    const { path, range: [start, end] } = candidate;
    const matched = [...(files.get(path) ?? [])].filter(line => line >= start && line <= end);
    if (!matched.length) continue;
    addLines(supported, path, matched);
    example ??= candidate;
  }
  if (!example) return undefined;
  return { gapLines: [...supported.values()].reduce((sum, lines) => sum + lines.size, 0), example };
}

function reviewFunctions(measured, current, assigned, pending, limit) {
  const { functions, crossFunctionGaps = [] } = measured;
  const excluded = (path, line) => assigned.get(path)?.has(line) || pending?.get(path)?.has(line);
  let crossBoundaryGapLines = 0;
  for (const { path, ranges } of crossFunctionGaps) {
    crossBoundaryGapLines += current.get(path)?.lines.filter(line => !excluded(path, line)
      && ranges.some(([start, end]) => start <= line && line <= end)).length ?? 0;
  }
  const rows = [];
  for (const file of measured.files) {
    const ranges = functions.files.get(file.path), gaps = current.get(file.path)?.lines;
    if (!ranges || !gaps?.length) continue;
    const listed = new Set();
    for (const range of ranges) {
      const [start, end] = range;
      const bodyStart = functions.nested.has(range) ? start + 1 : start;
      if (file.passedOnlyKnown.observedRanges.some(([lo, hi]) => bodyStart <= end && bodyStart <= hi && lo <= end)) continue;
      const lines = gaps.filter(line => start <= line && line <= end && !excluded(file.path, line) && !listed.has(line));
      if (!lines.length) continue;
      for (const line of lines) listed.add(line);
      rows.push({ path: file.path, start, end, gapLines: lines.length, gapRanges: compactRanges(lines) });
    }
  }
  rows.sort((a, b) => b.gapLines - a.gapLines || a.path.localeCompare(b.path) || a.start - b.start);
  return { sha256: functions.sha256, crossBoundaryGapLines,
    entryPoints: { count: rows.length, gapLines: rows.reduce((sum, row) => sum + row.gapLines, 0), items: rows.slice(0, limit) } };
}

function functionScenarioExtensions(measured, journeys, current, held, pending, limit) {
  const groups = new Map(), union = new Map();
  for (const examples of [measured.functionIntervals, measured.functionEdges?.scenario, measured.passingCallers?.scenario]) {
    for (const example of examples ?? []) {
      const { path, functionRange } = example;
      const key = JSON.stringify([path, functionRange]);
      if (!groups.has(key)) groups.set(key, { path, functionRange, examples: [] });
      groups.get(key).examples.push(example);
    }
  }
  const rows = [];
  for (const { path, functionRange, examples } of groups.values()) {
    const eligible = [];
    const { count, items: cases } = extensionCandidates(examples, journeys, current, held, pending, Math.min(limit, 3), eligible);
    if (!count) continue;
    const lines = new Set();
    for (const { files } of eligible) for (const line of files.get(path)) lines.add(line);
    addLines(union, path, lines);
    rows.push({ path, functionRange, gapLines: lines.size, gapRanges: compactRanges([...lines].sort((a, b) => a - b)), cases });
  }
  rows.sort((a, b) => b.gapLines - a.gapLines || a.path.localeCompare(b.path) || a.functionRange[0] - b.functionRange[0]);
  return { count: rows.length, gapLines: summarize(union).gapLines, items: rows.slice(0, limit),
    notice: 'Each function is shown with passing scenario anchors and discovered actions from those intervals. Inspect the condition before extending a case.' };
}

function reviewCaseActions(catalog, { actions, evidence, matchEntry, limit }) {
  const items = [];
  for (const { id, command, trigger, cases } of actions) {
    const matches = matchEntry && cases.map(row => matchEntry(row.entryPoint)).filter(Boolean);
    const match = matches && (matches.find(row => row.kind === 'entry-point') ?? matches[0]);
    if (matchEntry && !match) continue;
    const commandAvailable = catalog.capabilitiesSha256 && catalog.measurementActions.has(command);
    items.push({ id, command, ...(trigger && { trigger }), ...(match && { match }),
      ...(catalog.capabilitiesSha256 && { commandAvailable }), caseCount: cases.length,
      cases: cases.slice(0, limit).map(({ condition, selector, journey }) => {
        const row = { condition, selector, argv: ['test', '--case', selector] };
        if (!evidence) return row;
        const recorded = evidence.get(journey);
        const passed = recorded?.passed ?? 0, failed = recorded?.failed ?? 0;
        const observed = summarize(recorded?.files ?? new Map());
        return { ...row, evidence: { status: passed ? failed ? 'mixed' : 'passed' : failed ? 'failed' : 'unknown',
          passedIntervals: passed, failedIntervals: failed, commandRecorded: recorded?.actions.has(`scriv ${command}`) ?? false,
          observedLines: observed.gapLines,
          sources: observed.sources.slice(0, limit).map(({ path, gapRanges }) => ({ path, observedRanges: gapRanges })) } };
      }) });
  }
  return { count: items.length, items: items.slice(0, limit),
    notice: 'Actions and conditions are declared by discovery. Counters and outcomes describe retained case intervals.' };
}

function matchCaseEntryPoint(tracer, state, measured, focus) {
  const { functions } = measured;
  const key = (path, start, end) => JSON.stringify([path, start, end]);
  const owners = new Set(), callers = new Map(), selected = new Map();
  const compatible = measured.files.filter(file => file.status === 'current');
  for (const { path, instrumentedRanges } of compatible) {
    if (!focus.intersects(path, 1, Infinity)) continue;
    selected.set(path, expandRanges(instrumentedRanges).filter(line => focus.intersects(path, line)));
  }
  if (functions) {
    const verifiedPaths = new Set(compatible.map(file => file.path));
    for (const [path, lines] of selected) {
      const ranges = functions.files.get(path) ?? [];
      for (const line of lines) {
        const owner = innermostFunction(ranges, line);
        if (owner) owners.add(key(path, ...owner));
      }
    }
    for (const { caller, path, targetRange } of functions.calls ?? []) {
      if (!verifiedPaths.has(caller.path) || !owners.has(key(path, ...targetRange))) continue;
      const id = key(caller.path, ...caller.functionRange);
      if (!callers.has(id)) callers.set(id, { kind: 'compiler-call', caller, callee: { path, range: targetRange } });
    }
  }
  return entryPoint => {
    if (!entryPoint) return undefined;
    const { path, start, end, sha256 } = entryPoint;
    if (!state.files.has(path) || end > state.files.get(path).length || tracer.snapshot(entryPoint, state).sha256 !== sha256) return undefined;
    const id = key(path, start, end);
    const exactFunction = functions?.files.get(path)?.some(range => range[0] === start && range[1] === end);
    const direct = exactFunction ? owners.has(id) : selected.get(path)?.some(line => start <= line && line <= end);
    return direct ? { kind: 'entry-point', entryPoint } : callers.get(id);
  };
}

function directWorklist(tracer, { catalog, measured, current, unavailable, decisions, limit, focus, sourceFocus, actionId, actionLabel, actionTarget, actionTargetSha256 }) {
  const held = decisions?.held, replays = measured.replaySources;
  const { data, mapSha256 } = tracer.readMap({ withHash: true }), state = tracer.inventory();
  const actionCases = focus && catalog.actionCases.size && reviewCaseActions(catalog, {
    actions: catalog.actionCases.values(), evidence: measured.caseEvidence, limit,
    matchEntry: matchCaseEntryPoint(tracer, state, measured, focus),
  });
  const executionsByPath = new Map(), workByRoute = new Map(), reviewByPath = new Map(), assigned = new Map();
  for (const execution of catalog.executions) {
    for (const path of execution.paths) {
      if (!executionsByPath.has(path)) executionsByPath.set(path, []);
      executionsByPath.get(path).push(execution);
    }
  }

  const links = { mapSha256, staleOrInvalid: 0, actionOnly: 0, witnessWithoutRoute: 0 };
  const fileHashes = new Map(), focusedWitnesses = new Map();
  for (const { link, errors } of tracer.inspect(data, state)) {
    if (errors.length) { links.staleOrInvalid++; continue; }
    if (!link.step) { links.actionOnly++; continue; }
    const candidates = executionsByPath.get(link.step.path);
    if (!candidates) { links.witnessWithoutRoute++; continue; }
    const { path, start, end } = link.source, measuredFile = current.get(path);
    const focusedWitness = focus && candidates.length === 1 && !candidates[0].restrictions.length
      && focus.intersects(path, start, end);
    if (!measuredFile || (!measuredFile.lines.length && !focusedWitness)) continue;
    if (!fileHashes.has(path)) {
      const source = tracer.snapshot({ path, start: 1, end: state.files.get(path).length }, state);
      fileHashes.set(path, source.sha256);
    }
    if (fileHashes.get(path) !== measuredFile.sha256) throw new Error(`Current source changed during worklist analysis: ${path}`);
    const [execution] = candidates;
    if (focusedWitness) {
      if (!focusedWitnesses.has(execution)) focusedWitnesses.set(execution, { paths: new Set(), ids: new Set() });
      const witness = focusedWitnesses.get(execution);
      witness.paths.add(link.step.path);
      witness.ids.add(link.id);
    }
    const lines = measuredFile.lines.filter(line => start <= line && line <= end && !held?.get(path)?.has(line));
    if (!lines.length) continue;
    const needsReview = candidates.length !== 1 || execution.restrictions.length > 0;
    const bucket = needsReview ? reviewByPath : workByRoute;
    const key = needsReview ? link.step.path : execution;
    if (!bucket.has(key)) bucket.set(key, { files: new Map(), linkIds: new Set(), witnessPaths: new Set() });
    const work = bucket.get(key);
    addLines(work.files, path, lines);
    work.linkIds.add(link.id);
    work.witnessPaths.add(link.step.path);
    addLines(assigned, path, lines);
  }

  const details = work => ({ linkIds: [...work.linkIds].sort(), ...summarize(work.files) });
  const routes = [...workByRoute].map(([execution, work]) => ({ id: execution.routeIds[0],
    routeIds: execution.routeIds, argv: execution.argv, witnessPaths: [...work.witnessPaths].sort(), ...details(work) })).sort(byImpact);
  const examplesByExecution = new Map();
  if (reviewByPath.size) {
    for (const example of measured.surroundingIntervals ?? []) {
      const execution = catalog.journeys.get(example.journey);
      if (!examplesByExecution.has(execution)) examplesByExecution.set(execution, []);
      examplesByExecution.get(execution).push(example);
    }
  }
  const selectorReview = [...reviewByPath].map(([witnessPath, work]) => ({ witnessPath,
    candidates: executionsByPath.get(witnessPath).map(execution => {
      const { routeIds, argv, restrictions } = execution;
      const evidence = neighboringEvidence(work.files, examplesByExecution.get(execution));
      return { routeIds, argv, restrictions, ...(evidence && { neighboringEvidence: evidence }) };
    }),
    ...details(work) })).sort((a, b) => b.gapLines - a.gapLines || a.witnessPath.localeCompare(b.witnessPath));
  const witnessRows = [...focusedWitnesses].map(([{ routeIds, argv }, { paths, ids }]) =>
    ({ routeIds, argv, witnessPaths: [...paths].sort(), linkIds: [...ids].sort() }))
    .sort((a, b) => b.linkIds.length - a.linkIds.length || a.routeIds[0].localeCompare(b.routeIds[0]));
  const { reference, captureSet: capture, allObserved, passedOnlyKnown } = measured;
  const count = files => [...files.values()].reduce((sum, lines) => sum + lines.size, 0);
  const linkedGapLines = count(assigned);
  const runtime = runtimeReview(tracer, data, state, measured.files, current, assigned, focus, limit);
  const pending = runtime?.pending;
  if (held) for (const [path, lines] of held) addLines(assigned, path, lines);
  const batches = catalog.launchActions && {
    session: [...workByRoute].map(([{ argv, routeIds }, { files }]) => ({ argv, routeIds, files })),
    startup: [],
  };
  const extensions = measured.surroundingIntervals && extensionCandidates(measured.surroundingIntervals,
    catalog.journeys, current, assigned, pending, limit, batches?.session);
  const startup = catalog.launchActions && measured.startupIntervals
    && extensionCandidates(measured.startupIntervals, catalog.journeys, current, assigned, pending, limit, batches?.startup);
  const actionReview = actionId === undefined ? undefined
    : reviewAction(actionId, catalog, actionLabel, measured, sourceFocus, limit);
  const edgeCandidates = measured.functionEdges && extensionCandidates(measured.functionEdges.scenario,
    catalog.journeys, current, assigned, pending, limit, batches?.session);
  const startupEdgeCandidates = catalog.launchActions && measured.functionEdges
    && extensionCandidates(measured.functionEdges.startup, catalog.journeys, current, assigned, pending, limit, batches?.startup);
  const callers = measured.passingCallers && {
    notice: 'A passing interval observed the caller function. A static call points to the unobserved callee. Inspect the call site and extend the case for its missing condition.',
    session: extensionCandidates(measured.passingCallers.scenario, catalog.journeys, current, assigned, pending, limit, batches?.session),
    ...(catalog.launchActions && { startup: extensionCandidates(measured.passingCallers.startup,
      catalog.journeys, current, assigned, pending, limit, batches?.startup) }),
    declarations: {
      notice: 'A passing interval observed the line that declares a nested function. Inspect its control or event registration and find a real way to invoke it.',
      session: extensionCandidates(measured.passingCallers.declarations.scenario, catalog.journeys, current, assigned, pending, limit),
      ...(catalog.launchActions && { startup: extensionCandidates(measured.passingCallers.declarations.startup,
        catalog.journeys, current, assigned, pending, limit) }),
    },
  };
  const dispatchPlans = new Map();
  if (batches) for (const [label, examples] of measured.dispatchGaps ?? []) {
    const candidates = [];
    extensionCandidates(examples, catalog.journeys, current, held, pending, 0, candidates);
    dispatchPlans.set(label, nativeCaseBatch(candidates, { limit, includeExamples: true }));
  }
  if (actionReview) {
    if (actionTarget !== undefined) actionReview.target = actionTarget;
    if (actionTargetSha256 !== undefined) actionReview.targetSha256 = actionTargetSha256;
    const intervals = actionReview.restrictions.length ? [] : measured.actionIntervals ?? [];
    const exactBatch = batches && [];
    actionReview.extensionCandidates = extensionCandidates(intervals, catalog.journeys, current, held, pending, limit, exactBatch);
    if (measured.functionEdges) {
      const exactEdges = actionReview.restrictions.length ? [] : measured.functionEdges.action;
      actionReview.functionEdgeCandidates = extensionCandidates(exactEdges, catalog.journeys, current, held, pending, limit, exactBatch);
    }
    if (exactBatch) actionReview.nativeBatch = nativeCaseBatch(exactBatch, { limit, held, pending });
    if (batches && actionReview.dispatchWindows) {
      actionReview.dispatchBatch = (!actionReview.restrictions.length && dispatchPlans.get(actionLabel))
        || nativeCaseBatch([], { limit });
      if (actionReview.dispatchBatch.cases.length) actionReview.next = 'extend-scenario';
    }
  }
  if (decisions) for (const [path, lines] of decisions.assigned) addLines(assigned, path, lines);
  const decisionSummary = decisions && {
    proposal: decisions.report.proposal, queues: decisions.report.queues, routes: decisions.report.routes,
    assignedGapLines: decisions.report.assignedGapLines, heldGapLines: count(held), classifiedGapLines: count(assigned),
    ...(batches && {
      nativeBatch: nativeCaseBatch(decisions.nativeCandidates.session, { limit, held, pending }),
      nativeStartupBatch: nativeCaseBatch(decisions.nativeCandidates.startup, { limit, held, pending, startup: true }),
    }),
  };
  return { kind: 'source-coverage-worklist', version: 1,
    notice: 'Ranks passing gaps from current source and witnessed CLI links. Exact witness-path matches are candidates. No scenario ran and no action attribution is implied.',
    coverage: { reference, captureSet: capture, allObserved, passedOnlyKnown }, routesSha256: catalog.routesSha256, links,
    limit, linkedGapLines,
    routeCount: routes.length, routes: routes.slice(0, limit),
    selectorReview: { count: selectorReview.length, items: selectorReview.slice(0, limit) },
    ...(focus && { focusedWitnessRoutes: { count: witnessRows.length, items: witnessRows.slice(0, limit) } }),
    ...(extensions && { extensionCandidates: extensions }),
    ...(startup && { startupCandidates: startup }),
    ...(batches && { nativeBatches: {
      notice: 'Extend the selected scenarios for the missing conditions, then append pinned capture options to argv. Scores count candidate lines once per batch.',
      session: nativeCaseBatch(batches.session, { limit, held, pending }),
      startup: nativeCaseBatch(batches.startup, { limit, held, pending, startup: true }),
    } }),
    ...(actionReview && { actionReview }),
    ...(actionCases && { actionCases }),
    ...(measured.recordedActions && (focus || measured.recordedActions.size)
      && { recordedActions: reviewRecordedActions(measured.recordedActions, catalog, limit, dispatchPlans) }),
    ...(catalog.capabilitiesSha256 && { capabilitiesSha256: catalog.capabilitiesSha256 }),
    ...(replays && { replayCandidates: replayCandidates(replays.eligible, { held, pending, limit, focus }),
      failedReplays: replayCandidates(replays.failed, { held, pending, limit, focus, failures: replays.failures }) }),
    ...(runtime && { runtimeReview: runtime.report }),
    ...(sourceFocus && { sourceFocus }),
    ...(measured.functions && { functionReview: { ...reviewFunctions(measured, current, assigned, pending, limit),
      scenarioExtensions: functionScenarioExtensions(measured, catalog.journeys, current, held, pending, limit),
      ...(edgeCandidates && { edgeCandidates,
        edgeNotice: 'An adjacent counter increased inside the same compiler function. The missing block needs a new condition or assertion.' }),
      ...(startupEdgeCandidates && { startupEdgeCandidates }), ...(callers && { callers }) } }),
    ...(decisionSummary && { decisions: decisionSummary }),
    unassigned: fileSummary(remainingGaps(current, assigned), limit), unavailable: fileSummary(unavailable, limit) };
}

function observedActionRoutes(sources, restrictions) {
  return [...(sources ?? [])].map(([execution, { files, example }]) => ({
    routeIds: execution.routeIds, argv: execution.argv, restrictions: [...new Set([...restrictions, ...execution.restrictions])], example,
    observedLines: [...files.values()].reduce((sum, lines) => sum + lines.size, 0),
    sources: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, lines]) =>
      ({ path, observedRanges: compactRanges([...lines].sort((a, b) => a - b)) })),
  })).sort((a, b) => b.observedLines - a.observedLines || a.routeIds[0].localeCompare(b.routeIds[0]));
}

function reviewAction(id, catalog, label, { actionSources, dispatchWindowSources }, sourceFocus, limit) {
  const restrictions = [catalog.actions.get(id)?.restriction].filter(Boolean);
  const candidates = observedActionRoutes(actionSources, restrictions);
  const windows = observedActionRoutes(dispatchWindowSources, restrictions).filter(row => !row.restrictions.length);
  const routes = candidates.filter(row => !row.restrictions.length), restricted = candidates.filter(row => row.restrictions.length);
  const hasObservedSource = routes[0]?.observedLines > 0;
  const allFocusedLinesPassed = sourceFocus.gapLines === 0 && !sourceFocus.unknown.length;
  let next;
  if (restrictions.length) next = 'blocked';
  else if (!label) next = 'review-cli-action';
  else if (hasObservedSource) next = allFocusedLinesPassed ? 'no-passing-gaps' : 'extend-scenario';
  else next = routes.length ? 'review-scenario' : 'find-or-add-scenario';
  return { id, next, measurementAction: label ?? null, restrictions,
    ...(catalog.capabilitiesSha256 && { capabilitiesSha256: catalog.capabilitiesSha256 }),
    routeCount: routes.length, routes: routes.slice(0, limit),
    ...(dispatchWindowSources && { dispatchWindows: { count: windows.length, items: windows.slice(0, limit),
      notice: 'Passing intervals declared by the capture producer around the completed activation. Background work may overlap and later work falls outside the window.' } }),
    restrictedRoutes: { count: restricted.length, items: restricted.slice(0, limit) },
  };
}

const activationLabel = 'scriv activate';
const targetLabel = digest => `${activationLabel} --target-sha256 ${digest}`;
const windowLabelFor = digest => `${activationLabel} --window-target-sha256 ${digest}`;

function discoverRecordedActions(catalog, focus) {
  if (!catalog.measurementActions) return;
  const menuLabels = new Map([...catalog.measurementActions]
    .filter(([, label]) => label.startsWith('scriv menu-action --scope '))
    .map(([id, label]) => [label, { id, label, actionArgs: ['--action', id] }]));
  const commandLabels = new Map([...catalog.semanticActionIds].map(id => {
    const label = catalog.measurementActions.get(id);
    return [label, { id, label, actionArgs: ['--action', id] }];
  }));
  const supportsActivate = catalog.measurementActions.get('activate') === activationLabel;
  return { focus, actions(record) {
    const labels = new Set(record.actionLabels);
    const commands = new Set(record.actions);
    const matches = [];
    if (focus) for (const command of commands) {
      const action = commandLabels.get(command);
      if (action) matches.push({ action, window: false });
    }
    for (const label of labels) {
      const menu = menuLabels.get(label);
      if (focus && menu && commands.has('scriv menu-action')) matches.push({ action: menu, window: false });
      if (!supportsActivate || !commands.has(activationLabel)) continue;
      const digest = /^scriv activate --target-sha256 ([a-f0-9]{64})$/.exec(label)?.[1];
      if (!digest) continue;
      const window = labels.has(windowLabelFor(digest));
      // A whole-scope search stays bounded to exact control windows. Session
      // action hints are available when the caller supplies a source range.
      if (focus || window) matches.push({ action: { id: 'activate', label, targetSha256: digest,
        actionArgs: ['--action', 'activate', '--target-sha256', digest] }, window });
    }
    return matches;
  } };
}

function reviewRecordedActions(matches, catalog, limit, dispatchPlans) {
  const items = [], restricted = [];
  for (const { action, sessions, windows } of matches.values()) {
    const { id } = action;
    const restrictions = [catalog.actions.get(id)?.restriction].filter(Boolean);
    const windowRoutes = observedActionRoutes(windows, restrictions);
    const sessionRoutes = observedActionRoutes(sessions, restrictions);
    for (const [rows, wantRestricted] of [[items, false], [restricted, true]]) {
      const focused = windowRoutes.filter(row => Boolean(row.restrictions.length) === wantRestricted);
      const batch = !wantRestricted && !restrictions.length ? dispatchPlans.get(action.label) : undefined;
      const hasCandidates = batch?.cases.length > 0;
      const bounded = hasCandidates || focused.length > 0;
      const routes = bounded ? focused : sessionRoutes.filter(row => Boolean(row.restrictions.length) === wantRestricted);
      if (hasCandidates || routes.length) rows.push({ ...action, evidence: bounded ? 'dispatch-window' : 'session',
        observedLines: routes[0]?.observedLines ?? 0, routeCount: routes.length, routes: routes.slice(0, limit),
        ...(hasCandidates && { dispatchBatch: batch }) });
    }
  }
  const priority = row => row.dispatchBatch ? 0 : row.evidence === 'dispatch-window' ? 1 : row.targetSha256 ? 3 : 2;
  const summarize = rows => ({ count: rows.length, items: rows.sort((a, b) => priority(a) - priority(b)
    || (b.dispatchBatch?.candidateGapLines ?? 0) - (a.dispatchBatch?.candidateGapLines ?? 0)
    || b.observedLines - a.observedLines || a.label.localeCompare(b.label)).slice(0, limit) });
  return { ...summarize(items), restricted: summarize(restricted),
    notice: 'Dispatch batches use passing anchors inside a matched control window. Candidate lines remain unobserved. Session matches need caller review. Background work can overlap a dispatch window.' };
}

export function coverageWorklist(tracer, options) {
  return guideCoverageWorklist(buildCoverageWorklist(tracer, options));
}

function buildCoverageWorklist(tracer, { file, routesFile, capabilitiesFile, captureSet, referenceRoot, sourceFirst, replay, sources, actionId, actionTarget, actionTargetSha256, functionMapFile, limit = 15 }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Worklist requires --limit 1-1000.');
  const focus = sourceSelection(sources);
  const catalog = readRoutes(tracer.root, routesFile, { capabilitiesFile });
  const declaredAction = actionTarget === undefined && actionTargetSha256 === undefined && catalog.actionCases.get(actionId);
  const caseActions = declaredAction ? [declaredAction] : focus ? [...catalog.actionCases.values()] : [];
  if (!captureSet && !declaredAction) throw new Error('Action lookup requires an ID declared by native case discovery.');
  if (actionTarget !== undefined && actionTargetSha256 !== undefined) {
    throw new Error('Use one of --target or --target-sha256.');
  }
  if (actionTarget !== undefined || actionTargetSha256 !== undefined) {
    if (actionId !== 'activate' || catalog.measurementActions?.get(actionId) !== activationLabel) {
      throw new Error('--target requires --action activate and UIKit --capabilities advertising activate.');
    }
    if (actionTarget !== undefined && (!/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/.test(actionTarget) || /\s/.test(actionTarget))) {
      throw new Error('--target requires a stable control identifier, e.g. workspace-project.');
    }
    if (actionTargetSha256 !== undefined && (actionTargetSha256.length !== 64 || !/^[a-f0-9]{64}$/.test(actionTargetSha256))) {
      throw new Error('--target-sha256 requires 64 lowercase hexadecimal digits.');
    }
  }
  if (actionId !== undefined && !declaredAction && !focus) throw new Error('--action requires --source for CLI commands.');
  if (actionId !== undefined && !declaredAction && !catalog.actions) throw new Error('--action requires discovered actions in the route catalog or --capabilities.');
  let actionLabel, windowLabel;
  if (actionId !== undefined && !declaredAction) {
    actionLabel = catalog.measurementActions ? catalog.measurementActions.get(actionId) : catalog.actions.get(actionId)?.id;
  }
  const digest = actionTargetSha256 ?? (actionTarget === undefined ? undefined : createHash('sha256').update(actionTarget).digest('hex'));
  if (digest) {
    actionLabel = targetLabel(digest);
    windowLabel = windowLabelFor(digest);
  }
  const actionQuery = actionLabel && { label: actionLabel, windowLabel, focus, journeys: catalog.journeys };
  const caseQuery = caseActions.length ? { focus, journeys: new Set(caseActions.flatMap(action => action.cases.map(row => row.journey))) } : undefined;
  if (declaredAction && !captureSet) return { kind: 'action-case-worklist', version: 1, routesSha256: catalog.routesSha256,
    actionCases: reviewCaseActions(catalog, { actions: caseActions, limit }) };
  const binding = file === undefined ? null : bindCatalogPlans(tracer, file, catalog);
  if (binding && !binding.behaviorRanges) throw new Error('Proposal worklist requires discovered actions or --capabilities.');
  const direct = sourceFirst || !binding;
  const labels = catalog.measurementActions ?? (catalog.actions && [...catalog.actions.keys()].map(id => [id, id]));
  const actionIdsByLabel = direct && labels && new Map([...labels].map(([id, label]) => [label, id]));
  const actionDiscovery = direct && discoverRecordedActions(catalog, focus);
  const measured = gapsMeasured(tracer.root, { captureSet, referenceRoot, actionQuery, actionDiscovery: declaredAction ? undefined : actionDiscovery,
    launchActions: catalog.launchActions, actionIdsByLabel, functionMapFile, caseQuery,
    extensionJourneys: direct && !declaredAction ? catalog.journeys : undefined, replayJourneys: replay ? catalog.journeys : undefined });
  const scope = gapFiles(measured, focus);
  const decisions = binding && proposalWorklist({ binding, measured, ...scope, focus, capabilitiesSha256: catalog.capabilitiesSha256, limit });
  if (declaredAction) return { kind: 'action-case-worklist', version: 1, routesSha256: catalog.routesSha256,
    reference: measured.reference, captureSet: measured.captureSet,
    coverage: { allObserved: measured.allObserved, passedOnlyKnown: measured.passedOnlyKnown },
    unavailable: fileSummary(scope.unavailable, limit), ...(scope.sourceFocus && { sourceFocus: scope.sourceFocus }),
    ...(decisions && { decisions: { queues: decisions.report.queues,
      heldGapLines: [...decisions.held.values()].reduce((sum, lines) => sum + lines.size, 0) } }),
    actionCases: reviewCaseActions(catalog, { actions: caseActions, evidence: measured.caseEvidence, limit }) };
  if (!direct) return decisions.report;
  return directWorklist(tracer, { catalog, measured, ...scope, decisions, limit, focus, actionId, actionLabel, actionTarget, actionTargetSha256 });
}

function proposalWorklist({ binding, measured, current, unavailable, capabilitiesSha256, limit, focus }) {
  const assigned = new Map(), byPlan = new Map(), held = new Map();
  const heldStatuses = new Set(['blocked', 'needs-cli-action']);
  const statuses = new Map(binding.plans.map(({ id, behavior }) => [id, behavior.next]));
  const unscored = { staleOrInvalid: 0, unavailableOrUninstrumented: 0 };
  for (const prediction of binding.behaviorRanges) {
    const { path, start, end, fileSha256 } = prediction.source;
    if (focus && !focus.intersects(path, start, end)) continue;
    const measuredFile = current.get(path);
    if (!prediction.scoreEligible) { unscored.staleOrInvalid++; continue; }
    if (measuredFile?.sha256 !== fileSha256) { unscored.unavailableOrUninstrumented++; continue; }
    const lines = measuredFile.lines.filter(line => start <= line && line <= end);
    if (!lines.length) continue;
    addLines(assigned, path, lines);
    if (prediction.planIds.every(id => heldStatuses.has(statuses.get(id)))) addLines(held, path, lines);
    for (const planId of prediction.planIds) {
      if (!byPlan.has(planId)) byPlan.set(planId, new Map());
      addLines(byPlan.get(planId), path, lines);
    }
  }

  const candidatesByPlan = new Map();
  for (const candidate of binding.bindings) {
    for (const id of candidate.planIds) {
      if (!candidatesByPlan.has(id)) candidatesByPlan.set(id, []);
      candidatesByPlan.get(id).push(candidate);
    }
  }
  const queues = Object.fromEntries(nextSteps.map(step => [step, []]));
  const selectable = new Set(), nativeCandidates = { session: [], startup: [] };
  for (const { id, title, featureId, behavior, routeIds: matchedRoutes, unmatchedRouteIds } of binding.plans) {
    const files = byPlan.get(id);
    if (!files) continue;
    const { next, ...detail } = behavior;
    const candidates = candidatesByPlan.get(id) ?? [];
    const ready = candidates.filter(candidate => candidate.selectable);
    const routeIds = ready.flatMap(candidate => candidate.routeIds.filter(route => matchedRoutes.includes(route)));
    const restrictedRoutes = candidates.filter(candidate => !candidate.selectable)
      .map(({ routeIds, restrictions }) => ({ routeIds, restrictions }));
    queues[next].push({ planId: id, title, featureId, routeIds, restrictedRoutes,
      ...(unmatchedRouteIds && { unmatchedRouteIds }), ...detail, ...summarize(files) });
    if (unmatchedRouteIds && (next === 'action-and-scenario' || next === 'needs-scenario')) {
      const batch = nativeCandidates[detail.captureMode ?? 'session'];
      for (const candidate of ready) batch.push({ argv: candidate.argv, routeIds: candidate.routeIds, files });
    }
    if (next === 'action-and-scenario') selectable.add(id);
  }

  const routes = [];
  for (const candidate of binding.bindings) {
    if (!candidate.selectable) continue;
    const planIds = candidate.planIds.filter(id => selectable.has(id));
    if (!planIds.length) continue;
    const files = new Map();
    for (const id of planIds) for (const [path, lines] of byPlan.get(id)) addLines(files, path, lines);
    routes.push({ id: candidate.routeIds[0], routeIds: candidate.routeIds, argv: candidate.argv, planIds, ...summarize(files) });
  }
  routes.sort(byImpact);

  const unassigned = remainingGaps(current, assigned);
  const { reference, captureSet: capture, allObserved, passedOnlyKnown } = measured;
  const report = { kind: 'provisional-coverage-worklist', version: 1,
    notice: 'Ranks current source lines without passing observations. Associations and selectors are candidates. Scores can overlap across plans and selectors. No route was executed.',
    coverage: { reference, captureSet: capture, allObserved, passedOnlyKnown },
    proposal: { sha256: binding.proposalSha256, routesSha256: binding.routesSha256, unscoredRanges: unscored,
      ...(capabilitiesSha256 && { capabilitiesSha256 }) },
    limit, assignedGapLines: [...assigned.values()].reduce((sum, lines) => sum + lines.size, 0),
    routeCount: routes.length, routes: routes.slice(0, limit),
    queues: Object.fromEntries(Object.entries(queues).map(([step, rows]) => [step, { count: rows.length,
      items: rows.sort((a, b) => b.gapLines - a.gapLines || a.planId.localeCompare(b.planId)).slice(0, limit) }])),
    unassigned: fileSummary(unassigned, limit), unavailable: fileSummary(unavailable, limit) };
  return { report, assigned, held, nativeCandidates };
}
