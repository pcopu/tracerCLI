import { bindProposalRoutes, readRoutes } from './route-bindings.mjs';
import { gapsMeasured } from './measured.mjs';
import { compactRanges } from './tracer.mjs';

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

function gapFiles(measured) {
  const current = new Map(), unavailable = [];
  for (const file of measured.files) {
    const { gapLines, gapRanges } = file.passedOnlyKnown;
    if (file.status !== 'current') {
      unavailable.push({ path: file.path, status: file.status, gapLines, gapRanges });
    } else {
      const lines = gapRanges.flatMap(([start, end]) => Array.from({ length: end - start + 1 }, (_, i) => start + i));
      current.set(file.path, { sha256: file.currentSource.sha256, lines });
    }
  }
  return { current, unavailable };
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

function extensionCandidates(surroundingIntervals, journeys, current, assigned, limit) {
  const byGap = new Map(), byExecution = new Map();
  for (const example of surroundingIntervals) {
    const { path, range, journey } = example, key = JSON.stringify([path, range]);
    if (!byGap.has(key)) byGap.set(key, { path, range, executions: new Map() });
    const executions = byGap.get(key).executions, execution = journeys.get(journey);
    if (!executions.has(execution)) executions.set(execution, example);
  }

  let gapLines = 0, exclusiveGapLines = 0;
  for (const { path, range: [start, end], executions } of byGap.values()) {
    const lines = current.get(path).lines.filter(line => start <= line && line <= end && !assigned.get(path)?.has(line));
    if (!lines.length) continue;
    gapLines += lines.length;
    const exclusive = executions.size === 1;
    if (exclusive) exclusiveGapLines += lines.length;
    for (const [execution, example] of executions) {
      if (!byExecution.has(execution)) byExecution.set(execution, { files: new Map(), exclusiveGapLines: 0, exclusiveExamples: [], sharedExamples: [] });
      const candidate = byExecution.get(execution);
      addLines(candidate.files, path, lines);
      if (exclusive) candidate.exclusiveGapLines += lines.length;
      const examples = exclusive ? candidate.exclusiveExamples : candidate.sharedExamples;
      if (examples.length < 3) examples.push(example);
    }
  }
  const rows = [...byExecution].map(([{ routeIds, argv, restrictions }, candidate]) => ({ routeIds, argv, restrictions,
    ...summarize(candidate.files), exclusiveGapLines: candidate.exclusiveGapLines,
    examples: candidate.exclusiveExamples.concat(candidate.sharedExamples).slice(0, 3) }));
  rows.sort((a, b) => b.exclusiveGapLines - a.exclusiveGapLines || b.gapLines - a.gapLines || a.routeIds[0].localeCompare(b.routeIds[0]));
  return { count: rows.length, gapLines, exclusiveGapLines, items: rows.slice(0, limit) };
}

function directWorklist(tracer, { routesFile, captureSet, referenceRoot, limit }) {
  const catalog = readRoutes(tracer.root, routesFile);
  const measured = gapsMeasured(tracer.root, { captureSet, referenceRoot, extensionJourneys: catalog.journeys });
  const { current, unavailable } = gapFiles(measured);
  const { data, mapSha256 } = tracer.readMap({ withHash: true }), state = tracer.inventory();
  const executionsByPath = new Map(), workByRoute = new Map(), reviewByPath = new Map(), assigned = new Map();
  for (const execution of catalog.executions) {
    for (const path of execution.paths) {
      if (!executionsByPath.has(path)) executionsByPath.set(path, []);
      executionsByPath.get(path).push(execution);
    }
  }

  const links = { mapSha256, staleOrInvalid: 0, actionOnly: 0, witnessWithoutRoute: 0 };
  const fileHashes = new Map();
  for (const { link, errors } of tracer.inspect(data, state)) {
    if (errors.length) { links.staleOrInvalid++; continue; }
    if (!link.step) { links.actionOnly++; continue; }
    const candidates = executionsByPath.get(link.step.path);
    if (!candidates) { links.witnessWithoutRoute++; continue; }
    const { path, start, end } = link.source, measuredFile = current.get(path);
    if (!measuredFile?.lines.length) continue;
    if (!fileHashes.has(path)) {
      const source = tracer.snapshot({ path, start: 1, end: state.files.get(path).length }, state);
      fileHashes.set(path, source.sha256);
    }
    if (fileHashes.get(path) !== measuredFile.sha256) throw new Error(`Current source changed during worklist analysis: ${path}`);
    const lines = measuredFile.lines.filter(line => start <= line && line <= end);
    if (!lines.length) continue;
    const [execution] = candidates;
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
  const selectorReview = [...reviewByPath].map(([witnessPath, work]) => ({ witnessPath,
    candidates: executionsByPath.get(witnessPath).map(({ routeIds, argv, restrictions }) => ({ routeIds, argv, restrictions })),
    ...details(work) })).sort((a, b) => b.gapLines - a.gapLines || a.witnessPath.localeCompare(b.witnessPath));
  const { reference, captureSet: capture, allObserved, passedOnlyKnown } = measured;
  return { kind: 'source-coverage-worklist', version: 1,
    notice: 'Ranks passing gaps from current source and witnessed CLI links. Exact witness-path matches are candidates. No scenario ran and no action attribution is implied.',
    coverage: { reference, captureSet: capture, allObserved, passedOnlyKnown }, routesSha256: catalog.routesSha256, links,
    limit, linkedGapLines: [...assigned.values()].reduce((sum, lines) => sum + lines.size, 0),
    routeCount: routes.length, routes: routes.slice(0, limit),
    selectorReview: { count: selectorReview.length, items: selectorReview.slice(0, limit) },
    ...(measured.surroundingIntervals && { extensionCandidates: extensionCandidates(measured.surroundingIntervals, catalog.journeys, current, assigned, limit) }),
    unassigned: fileSummary(remainingGaps(current, assigned), limit), unavailable: fileSummary(unavailable, limit) };
}

export function coverageWorklist(tracer, { file, routesFile, captureSet, referenceRoot, limit = 15 }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Worklist requires --limit 1-1000.');
  if (file === undefined) return directWorklist(tracer, { routesFile, captureSet, referenceRoot, limit });
  const binding = bindProposalRoutes(tracer, file, routesFile);
  if (!binding.behaviorRanges) throw new Error('Proposal worklist requires a route catalog with discovered actions.');
  const measured = gapsMeasured(tracer.root, { captureSet, referenceRoot });
  const { current, unavailable } = gapFiles(measured);

  const assigned = new Map(), byPlan = new Map();
  const unscored = { staleOrInvalid: 0, unavailableOrUninstrumented: 0 };
  for (const prediction of binding.behaviorRanges) {
    const { path, start, end, fileSha256 } = prediction.source;
    const measuredFile = current.get(path);
    if (!prediction.scoreEligible) { unscored.staleOrInvalid++; continue; }
    if (measuredFile?.sha256 !== fileSha256) { unscored.unavailableOrUninstrumented++; continue; }
    const lines = measuredFile.lines.filter(line => start <= line && line <= end);
    if (!lines.length) continue;
    addLines(assigned, path, lines);
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
  return { kind: 'provisional-coverage-worklist', version: 1,
    notice: 'Ranks current source lines without passing observations. Associations and selectors are candidates. Scores can overlap across plans and selectors. No route was executed.',
    coverage: { reference, captureSet: capture, allObserved, passedOnlyKnown },
    proposal: { sha256: binding.proposalSha256, routesSha256: binding.routesSha256, unscoredRanges: unscored },
    limit, assignedGapLines: [...assigned.values()].reduce((sum, lines) => sum + lines.size, 0),
    routeCount: routes.length, routes: routes.slice(0, limit),
    queues: Object.fromEntries(Object.entries(queues).map(([step, rows]) => [step, { count: rows.length,
      items: rows.sort((a, b) => b.gapLines - a.gapLines || a.planId.localeCompare(b.planId)).slice(0, limit) }])),
    unassigned: fileSummary(unassigned, limit), unavailable: fileSummary(unavailable, limit) };
}
