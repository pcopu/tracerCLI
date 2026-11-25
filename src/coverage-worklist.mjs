import { createHash } from 'node:crypto';
import { bindCatalogPlans, readRoutes } from './route-bindings.mjs';
import { gapsMeasured } from './measured.mjs';
import { compactRanges, parseRange } from './tracer.mjs';

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

function extensionCandidates(surroundingIntervals, journeys, current, assigned, pending, limit) {
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
  const count = ready.length;
  const publicRow = ({ files, ...row }) => row;
  return { count, gapLines, exclusiveGapLines, items: marginalCandidates(ready, limit).map(publicRow),
    restricted: { count: restricted.length, gapLines: restrictedGapLines, items: restricted.slice(0, limit).map(publicRow) } };
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

function directWorklist(tracer, { catalog, measured, current, unavailable, decisions, limit, focus, sourceFocus, actionId, actionLabel, actionTarget }) {
  const held = decisions?.held, replays = measured.replaySources;
  const { data, mapSha256 } = tracer.readMap({ withHash: true }), state = tracer.inventory();
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
  const extensions = measured.surroundingIntervals && extensionCandidates(measured.surroundingIntervals, catalog.journeys, current, assigned, pending, limit);
  const startup = catalog.launchActions && measured.startupIntervals
    && extensionCandidates(measured.startupIntervals, catalog.journeys, current, assigned, pending, limit);
  const actionReview = actionId === undefined ? undefined
    : reviewAction(actionId, catalog, actionLabel, measured.actionSources, sourceFocus, limit);
  if (actionReview) {
    if (actionTarget !== undefined) actionReview.target = actionTarget;
    const intervals = actionReview.restrictions.length ? [] : measured.actionIntervals ?? [];
    actionReview.extensionCandidates = extensionCandidates(intervals, catalog.journeys, current, held, pending, limit);
  }
  if (decisions) for (const [path, lines] of decisions.assigned) addLines(assigned, path, lines);
  const decisionSummary = decisions && {
    proposal: decisions.report.proposal, queues: decisions.report.queues, routes: decisions.report.routes,
    assignedGapLines: decisions.report.assignedGapLines, heldGapLines: count(held), classifiedGapLines: count(assigned),
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
    ...(actionReview && { actionReview }),
    ...(catalog.capabilitiesSha256 && { capabilitiesSha256: catalog.capabilitiesSha256 }),
    ...(replays && { replayCandidates: replayCandidates(replays.eligible, { held, pending, limit, focus }),
      failedReplays: replayCandidates(replays.failed, { held, pending, limit, focus, failures: replays.failures }) }),
    ...(runtime && { runtimeReview: runtime.report }),
    ...(sourceFocus && { sourceFocus }),
    ...(decisionSummary && { decisions: decisionSummary }),
    unassigned: fileSummary(remainingGaps(current, assigned), limit), unavailable: fileSummary(unavailable, limit) };
}

function reviewAction(id, catalog, label, actionSources, sourceFocus, limit) {
  const restrictions = [catalog.actions.get(id)?.restriction].filter(Boolean);
  const candidates = [...(actionSources ?? [])].map(([execution, { files, example }]) => ({
    routeIds: execution.routeIds, argv: execution.argv, restrictions: [...new Set([...restrictions, ...execution.restrictions])], example,
    observedLines: [...files.values()].reduce((sum, lines) => sum + lines.size, 0),
    sources: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, lines]) =>
      ({ path, observedRanges: compactRanges([...lines].sort((a, b) => a - b)) })),
  })).sort((a, b) => b.observedLines - a.observedLines || a.routeIds[0].localeCompare(b.routeIds[0]));
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
    restrictedRoutes: { count: restricted.length, items: restricted.slice(0, limit) },
  };
}

export function coverageWorklist(tracer, { file, routesFile, capabilitiesFile, captureSet, referenceRoot, sourceFirst, replay, sources, actionId, actionTarget, limit = 15 }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Worklist requires --limit 1-1000.');
  const focus = sourceSelection(sources);
  const catalog = readRoutes(tracer.root, routesFile, { capabilitiesFile });
  if (actionTarget !== undefined) {
    if (actionId !== 'activate' || catalog.measurementActions?.get(actionId) !== 'scriv activate') {
      throw new Error('--target requires --action activate and UIKit --capabilities advertising activate.');
    }
    if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/.test(actionTarget) || /\s/.test(actionTarget)) {
      throw new Error('--target requires a stable control identifier, e.g. workspace-project.');
    }
  }
  if (actionId !== undefined && !focus) throw new Error('--action requires --source.');
  if (actionId !== undefined && !catalog.actions) throw new Error('--action requires discovered actions in the route catalog or --capabilities.');
  let actionLabel;
  if (actionId !== undefined) {
    actionLabel = catalog.measurementActions ? catalog.measurementActions.get(actionId) : catalog.actions.get(actionId)?.id;
  }
  if (actionTarget !== undefined) {
    const digest = createHash('sha256').update(actionTarget).digest('hex');
    actionLabel += ` --target-sha256 ${digest}`;
  }
  const actionQuery = actionLabel && { label: actionLabel, focus, journeys: catalog.journeys };
  const binding = file === undefined ? null : bindCatalogPlans(tracer, file, catalog);
  if (binding && !binding.behaviorRanges) throw new Error('Proposal worklist requires discovered actions or --capabilities.');
  const direct = sourceFirst || !binding;
  const labels = catalog.measurementActions ?? (catalog.actions && [...catalog.actions.keys()].map(id => [id, id]));
  const actionIdsByLabel = direct && labels && new Map([...labels].map(([id, label]) => [label, id]));
  const measured = gapsMeasured(tracer.root, { captureSet, referenceRoot, actionQuery, launchActions: catalog.launchActions, actionIdsByLabel,
    extensionJourneys: direct ? catalog.journeys : undefined, replayJourneys: replay ? catalog.journeys : undefined });
  const scope = gapFiles(measured, focus);
  const decisions = binding && proposalWorklist({ binding, measured, ...scope, focus, capabilitiesSha256: catalog.capabilitiesSha256, limit });
  if (!direct) return decisions.report;
  return directWorklist(tracer, { catalog, measured, ...scope, decisions, limit, focus, actionId, actionLabel, actionTarget });
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
  const selectable = new Set();
  for (const { id, title, featureId, behavior } of binding.plans) {
    const files = byPlan.get(id);
    if (!files) continue;
    const { next, ...detail } = behavior;
    const candidates = candidatesByPlan.get(id) ?? [];
    const routeIds = candidates.filter(candidate => candidate.selectable).flatMap(candidate => candidate.routeIds);
    const restrictedRoutes = candidates.filter(candidate => !candidate.selectable)
      .map(({ routeIds, restrictions }) => ({ routeIds, restrictions }));
    queues[next].push({ planId: id, title, featureId, routeIds, restrictedRoutes, ...detail, ...summarize(files) });
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
  return { report, assigned, held };
}
