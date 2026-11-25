// Turn existing worklist evidence into the next investigation, never an execution.
function caseNext(action, row, focus, unavailable) {
  if (action.commandAvailable === false) return 'review-cli-action';
  if (row.evidence?.status === 'failed') return 'repair-existing-case';
  if (row.evidence?.status === 'mixed') return 'review-case-outcomes';
  if (focus && !unavailable && !focus.unknown.length && focus.gapLines === 0) return 'reuse-passing-evidence';
  if (row.evidence?.status === 'passed') {
    if (focus && (unavailable || focus.unknown.length)) return 'resolve-measurement';
    return focus?.gapLines > 0 ? 'extend-existing-case' : 'reuse-passing-evidence';
  }
  return 'review-and-run-existing-case';
}

export function guideCoverageWorklist(report) {
  const { sourceFocus: focus } = report;
  const unavailable = Boolean(report.unavailable?.files);
  const measured = focus ?? report.coverage?.passedOnlyKnown;
  const queues = report.decisions?.queues ?? report.queues;
  const held = ['blocked', 'needs-cli-action'].find(kind => queues?.[kind]?.count);
  const heldNext = held && {
    kind: held === 'blocked' ? 'resolve-blocker' : 'review-cli-action',
    from: `${report.decisions ? 'decisions.' : ''}queues.${held}.items`,
    instruction: held === 'blocked'
      ? 'Read the existing blocker and its required environment or permission. Keep the held range visible and continue independent supported cases; do not schedule a substitute that bypasses the restriction.'
      : 'Inspect the reviewed production entry point and confirm current CLI discovery still lacks its route. Add the narrowly scoped authorized action and an observable case, then refresh discovery before running it.',
  };
  const allHeld = held && measured?.gapLines > 0 && report.decisions?.heldGapLines === measured.gapLines;
  const actionCases = report.actionCases && { ...report.actionCases,
    items: report.actionCases.items.map(action => ({ ...action,
      cases: action.cases.map(row => ({ ...row, next: allHeld ? heldNext.kind : caseNext(action, row, focus, unavailable) })) })) };
  const complete = measured?.gapLines === 0 && !unavailable && !focus?.unknown.length;
  let kind, from, instruction;
  if (allHeld) {
    ({ kind, from, instruction } = heldNext);
  } else if (actionCases?.count) {
    kind = 'use-action-cases'; from = 'actionCases.items';
    instruction = 'Read the production branch and choose the declared condition that reaches it. Inspect that existing case\'s fixture and assertion, then follow its next field. A source match or unknown outcome does not select the condition for you.';
  } else if (report.failedReplays?.count) {
    kind = 'repair-existing-case'; from = 'failedReplays.items';
    instruction = 'Inspect the retained failure and repair the existing case or product defect while preserving its behavior assertion. Keep unrelated runnable cases moving.';
  } else if (complete) {
    kind = 'reuse-passing-evidence'; from = focus ? 'sourceFocus' : 'coverage.passedOnlyKnown';
    instruction = 'Reuse the compatible passing observations for this measured scope. Choose another remaining gap; do not rerun an unchanged case solely to add the same lines.';
  } else if (report.replayCandidates?.count) {
    kind = 'run-existing-case'; from = 'replayCandidates.items';
    instruction = 'Inspect the exact existing selector and its state, then replay it on the verified reference build. Retained older observations guide selection without filling current gaps.';
  } else {
    const leads = [
      ['actionReview.dispatchBatch', report.actionReview?.dispatchBatch?.cases.length],
      ['actionReview.nativeBatch', report.actionReview?.nativeBatch?.cases.length],
      ['functionReview.scenarioExtensions.items', report.functionReview?.scenarioExtensions?.count],
      ['extensionCandidates.items', report.extensionCandidates?.count],
      ['functionReview.callers.session.items', report.functionReview?.callers?.session?.count],
      ['functionReview.edgeCandidates.items', report.functionReview?.edgeCandidates?.count],
      ['nativeBatches.session', report.nativeBatches?.session?.cases.length],
      ['nativeBatches.startup', report.nativeBatches?.startup?.cases.length],
      ['decisions.nativeBatch', report.decisions?.nativeBatch?.cases.length],
      ['decisions.nativeStartupBatch', report.decisions?.nativeStartupBatch?.cases.length],
      ['routes', report.routes?.length],
    ];
    from = leads.find(([, count]) => count)?.[0];
    if (from) {
      kind = 'inspect-existing-case';
      instruction = 'Use the existing selector as a lead. Trace its real control or event to the branch, identify the missing state, and inspect its assertion. Reuse the case if that state exists; otherwise extend its fixture and assertion before capturing.';
    } else if (unavailable || focus?.unknown.length) {
      kind = 'resolve-measurement'; from = unavailable ? 'unavailable' : 'sourceFocus.unknown';
      instruction = 'Locate compatible captures or the required instrumentation/build for these ranges. Unknown or stale evidence is not an uncovered branch. Continue independent supported cases.';
    } else if (held) {
      ({ kind, from, instruction } = heldNext);
    } else {
      kind = 'trace-entry-point'; from = report.functionReview ? 'functionReview.entryPoints' : 'unassigned';
      instruction = 'Inspect production callers, callbacks and registrations, then current CLI discovery and existing tests. Review missing or stale entry-point declarations. Add a case or narrow production CLI route only after checking reuse; do not invent a selector or refresh an unreviewed pin.';
    }
  }
  const nextStep = { kind, from, instruction,
    recipe: ['source branch and production caller', 'exact public CLI action and target or event',
      'triggering state and owned fixture setup', 'existing discovered case and observable assertion'],
    afterRun: 'Run through the app CLI with compatible instrumentation, then compare unique passing gains using measure batch for supported native receipts or the adapter\'s retained capture set. If a passing case adds no target observations, inspect the missing state or async capture boundary before rerunning unchanged.',
    notice: 'Guidance is provisional. No case ran, no branch state was inferred, and no measurement or mapping was changed.' };
  const { kind: reportKind, version, ...details } = report;
  return { kind: reportKind, version, nextStep, ...details, ...(actionCases && { actionCases }) };
}
