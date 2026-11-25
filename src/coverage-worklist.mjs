import { bindProposalRoutes } from './route-bindings.mjs';
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

export function coverageWorklist(tracer, { file, routesFile, captureSet, referenceRoot, limit = 15 }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Proposal worklist requires --limit 1-1000.');
  const binding = bindProposalRoutes(tracer, file, routesFile);
  if (!binding.behaviorRanges) throw new Error('Proposal worklist requires a route catalog with discovered actions.');
  const measured = gapsMeasured(tracer.root, { captureSet, referenceRoot });
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

  const unassigned = [];
  for (const [path, file] of current) {
    const lines = file.lines.filter(line => !assigned.get(path)?.has(line));
    if (lines.length) unassigned.push({ path, gapLines: lines.length, gapRanges: compactRanges(lines) });
  }
  unassigned.sort((a, b) => b.gapLines - a.gapLines || a.path.localeCompare(b.path));
  const fileSummary = rows => ({ files: rows.length, gapLines: rows.reduce((sum, row) => sum + row.gapLines, 0), items: rows.slice(0, limit) });
  const { reference, captureSet: capture, allObserved, passedOnlyKnown } = measured;
  return { kind: 'provisional-coverage-worklist', version: 1,
    notice: 'Ranks current source lines without passing observations. Associations and selectors are candidates. Scores can overlap across plans and selectors. No route was executed.',
    coverage: { reference, captureSet: capture, allObserved, passedOnlyKnown },
    proposal: { sha256: binding.proposalSha256, routesSha256: binding.routesSha256, unscoredRanges: unscored },
    limit, assignedGapLines: [...assigned.values()].reduce((sum, lines) => sum + lines.size, 0),
    routeCount: routes.length, routes: routes.slice(0, limit),
    queues: Object.fromEntries(Object.entries(queues).map(([step, rows]) => [step, { count: rows.length,
      items: rows.sort((a, b) => b.gapLines - a.gapLines || a.planId.localeCompare(b.planId)).slice(0, limit) }])),
    unassigned: fileSummary(unassigned), unavailable: fileSummary(unavailable) };
}
