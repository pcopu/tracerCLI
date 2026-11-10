# Supervised audits during active coding

Write scenarios alongside feature changes and audit stable snapshots independently while coding continues. Tracer's local audit queue records immutable review inputs, claims and receipts. It does not start a reviewer, detach subprocesses, contact external services, execute app code or decide whether a semantic claim is true.

For an existing whole-codebase mapping request, first deliver the complete proposed map using [the proposal workflow](proposals.md). Then audit in useful batches. Active coding needs incremental contracts for affected behavior, not a new exhaustive inventory before each edit.

## One authoring lane, one supervised review lane

1. Update code, supported CLI routes and the scenario contract together. Preserve useful existing journeys; add concrete boundary, cancellation, replay and recovery cases where needed.
2. At a stable milestone, prepare a current proposal and enqueue a small batch. Add relevant full caller, wrapper and witness files as context when they are not already referenced source. The job must contain enough information to review the claim, not just an isolated attractive snippet.
3. Have a coordinating agent retain one independent worker initially. Claim a pending job and give that worker the returned frozen inputs and claim ID. Keep the worker read-only against the author's working tree. Continue independent coding rather than waiting for the audit after every milestone.
4. Collect and record the receipt, or explicitly fail a broken review attempt. Bring actionable findings back at natural milestones. Queue status chatter is not a reason to interrupt every edit.
5. Correct affected contracts separately, then obtain independent review of the changed snapshot. Keep prior findings and snapshots as history.
6. At the completion or publication boundary, drain the agreed scope against the exact current proposal and source, then satisfy the separate execution and repository-check requirements.

The supervisor owns worker lifetime, collection and explicit recovery. A launching command returning does not prove that a detached reviewer is still running. If a worker disappears, the queue does not invent a completed result or infer a crash from elapsed time. An orphaned claim remains running until the supervisor explicitly fails it and retries as appropriate.

## Commands

Examples use an already prepared proposal. Names and IDs below are placeholders; take actual IDs from command output.

```sh
tracer audit enqueue --file docs/testing/proposed-scenario-map.json \
  --author feature-author --offset 0 --limit 4 \
  --context src/request-router.mjs --context tests/request-journey.mjs \
  --max-pending 4
tracer audit claim --worker independent-reviewer
tracer audit record --file audit-receipt.json
tracer audit status --file docs/testing/proposed-scenario-map.json
tracer audit drain --file docs/testing/proposed-scenario-map.json
```

- `audit enqueue --file PROPOSAL --author NAME` freezes selected associations and their dependencies. `--offset` and `--limit` bound the batch; repeat `--context PATH` for necessary additional files. `--max-pending` sets initial queue capacity (default 100, maximum 1000), counting pending plus running jobs. Existing capacity is preserved; a different supplied value is rejected. Enqueue defaults to the first 25 associations; use explicit offsets for later batches. Identical jobs are deduplicated rather than creating unlimited repeated work. Each job supports at most 10,000 required assertions across its range-specific assertions and linked shared outcomes; oversized contracts are rejected before snapshot persistence. Split a genuinely larger contract into meaningful smaller scenario contracts rather than dropping assertions. When capacity is exhausted, preserve the obligation and enqueue it at a later milestone; never report omitted work as reviewed.
- `audit claim --worker NAME [--job ID]` returns an immutable job and claim identity. The queue currently enforces one running review lane. A claim is not a completed audit and does not launch anything.
- `audit record --file RECEIPT` records structured reviewer declarations tied to the job and current claim. Use the actual frozen job as the receipt's scope, not a reread of the author's newer files. Invalid, incomplete or mismatched receipt data must not count as acceptance.
- `audit fail --job ID --claim ID --reason TEXT` explicitly records a failed attempt. Use a factual reason for a worker failure or unusable result; do not recast semantic findings as infrastructure failure to bypass them.
- `audit retry --job ID` explicitly retries eligible failed work. It does not rewrite the immutable snapshot. A changed contract needs a new enqueue, not a retry that pretends old inputs are new.
- `audit status --file PROPOSAL` inspects the current proposal's obligations and historical review status without executing review.
- `audit drain --file PROPOSAL` checks the completion gate. It is not a background worker, automatic recovery controller or execution runner. By default it gates **every current association in that proposal**, including associations never queued. Explicit `--offset N` and/or `--limit N` narrow the gate and must be disclosed with the completion claim; a scoped pass is not completion of the full proposal.

`audit claim` includes a `receiptTemplate` with exact job, snapshot, reviewer and assertion IDs. Its decisions start unresolved, and its assessment text is blank. An unfilled template cannot be recorded. Fill every assessment from actual frozen evidence; do not turn placeholders into acceptance mechanically.

Receipts use `version: 1`, `kind: "semantic-audit-receipt"`, `jobId`, `snapshotSha256`, `claim`, `reviewer` and `execution: "not-assessed"`. Set `associationFit` and `assertionAdequacy` separately to `accepted`, `needs-correction` or `unresolved`; `readiness` is `ready`, `needs-implementation` or `blocked`. Supply a rationale and concrete corrections when correction is needed. Accepted judgments cannot retain open corrections; readiness cannot say `ready` while the frozen scenario still says unwritten or needs extension. Every `assertionAssessments` entry has its exact template `id`, a decision and nonempty `fixture`, `action`, `state`, `oracle`, `guards` and `rationale`. Evidence entries contain frozen `path`, `start`, `end`, exact snippet `sha256` and an `observation`. Include evidence overlapping the association and any caller/guard evidence required to support it. Reviewer identity is an operator declaration, not authenticated identity or proof of independence.

## Immutable identity and staleness

Queue JSON is local under `.tracer/audits`. New storage gets a nested ignore file to keep ordinary Git adds from publishing it; customized existing ignore files are preserved, so inspect Git status before publication. Treat snapshots and receipts as evidence, not editable status switches. Keep them separate from proposals, the version-1 reviewed mapping sidecar and measured execution datasets. Do not include credentials, private application data or unrelated files in context, and do not publish queue contents by default. Local enqueue does not authorize sharing with an external reviewer.

A frozen job contains the proposal identity, selected complete association contracts, all referenced shared scenario definitions and full referenced source, verified `existingPaths` test files and explicit context file bytes with content pins. The contract includes range-specific `proposedAssertions` and every linked scenario's ordered `plannedActions` and `expectedOutcomes`. Reviewers must not silently omit a shared outcome because it is outside the range-specific assertion list.

Hash exact original bytes, including line endings. A snippet or normalized span hash alone cannot establish freshness. An edit anywhere in a pinned source file invalidates the old review for the current association, even if the selected range text is unchanged. Changed context, scenario actions, outcomes or other contract material also requires new review. Do not refresh stale pins without inspecting the changed behavior.

The whole proposal hash preserves provenance. A different whole-proposal hash alone may permit reuse only when the individual association's complete contract and all pinned source/context bytes are exactly unchanged. A matching range ID, feature tag, filename, summary or nearby snippet is insufficient. Never let an old result certify newer inputs. Preserve stale receipts as history rather than deleting them or counting them as current acceptance.

## Review the complete behavioral contract

Separate three judgments:

- **Source-association fit:** Does this source responsibility genuinely participate in the proposed flow? A helper or declaration need not implement the whole scenario. Check callers, wrappers and guards, not only the selected lines.
- **Assertion adequacy:** Do the proposed observations distinguish the claimed behavior, including the meaningful negative inputs and ordering requirements? Existing tests, broad range inclusion and plausible prose do not establish adequate assertions.
- **Executable readiness:** Are the required public CLI route, fixture controls, test witness, build and environment available? A coherent proposal can still be unwritten or blocked. Never infer readiness from source fit or native/provider execution from a static or simulated check.

For **each verbatim assertion**, including every range assertion and every linked shared scenario outcome, record:

1. The fixture and exact input variant that stimulates the behavior.
2. The action or ordered actions that reach it.
3. Required state, initialization, cleanup/reset and timing assumptions.
4. The observable oracle that distinguishes success from the relevant failure.
5. Outer guards and whole-callpath evidence, including interception that prevents reaching the claimed branch.

Check replay/deduplication, stale responses, cancellation exceptions, temporal ordering and boundary values. Test privacy, atomicity and failure guarantees at their claimed scope. For example, a replay guard may prevent a later validation branch from running; a negative case then needs a fresh identifier or explicit state reset. Do not quietly assume that missing stimulus.

Include precise frozen source/caller references or snippets, rationale, uncertainty and actionable corrections. If the supplied snapshot lacks a necessary caller or witness, report unresolved and request a new snapshot with that context. Do not fill the gap with the mutable working tree or an unsupported confident assertion.

Accepted, correction-needed and unresolved outcomes are reviewer declarations. Structural validation checks completeness and identity, not semantic truth. A successful audit is not proof of correctness, exhaustive branch analysis, or execution.

## Corrections and independent re-audit

Preserve the original proposal checkpoint and receipt. Make changes in a separate proposal revision. If a shared scenario change would alter unrelated associations, give the corrected contract its own identity instead of silently weakening the shared contract for everyone.

Enqueue the revised current inputs for independent review. A correction can introduce a different error, so author acknowledgment or a newly written assertion does not itself close the finding. Unchanged receipts may carry forward only through exact contract and dependency comparison. Retain disagreements, withdrawn findings and the evidence for adjudication. A small blind overlap can calibrate reviewers, but agreement is not measured accuracy.

## States and the mandatory completion gate

Keep job lifecycle and semantic review outcomes distinct. Pending means queued but unclaimed; running means claimed without a terminal result; failed means an explicitly failed attempt. A recorded receipt can contain correction-needed or unresolved findings rather than accepted judgments. Missing means a current obligation has no qualifying review. Stale means a historical result no longer matches current inputs. Do not collapse these into a single green percentage.

The final semantic gate must fail closed for any required missing, pending, running, failed, correction-needed, unresolved or stale review. Older pending/running jobs in the selected range scope also remain explicit `outstandingJobs` until the supervisor closes them; a newer receipt cannot silently discard them. Do not narrow scope to only accepted/enqueued jobs to manufacture a pass. Do not treat a full queue, a missing worker, malformed receipt, timeout or zero returned results as success. An explicit recovery and valid current receipt are required before the corresponding obligation can be cleared.

A semantic drain may pass while accepted plans still need implementation. The result keeps `executableReady` separate and always labels execution `not-assessed`; neither readiness nor a drain pass proves a scenario ran. Drain against final bytes, not a previous milestone. If code or contract changes afterward, reevaluate freshness and rerun the affected gate before completion. Report the scope and remaining counts honestly. Independent coding can continue while audit work remains, but “complete” or “ready for publication” cannot skip this gate.

Keep these separate:

- Proposed association completeness and its source-line denominator.
- Semantic review status by current association and the three judgments above.
- Explicitly reviewed source/action/witness links.
- Actual scenario execution results with build, platform, route and observed outcomes.
- Measured execution for its own instrumentation scope.

No audit operation promotes proposals into reviewed links, executes tests or imports measured evidence. The usual reviewed-link integration and authorized application runs remain separate, as do repository aggregate checks.

## Evidence and limits of the method

Source-contract review trials showed why every assertion, shared outcome, caller and guard needs explicit review, and why corrections themselves need independent re-audit. Initial flags were not all proven defects, and reviewer agreement was not accuracy.

Four small matched benchmark pairs on two synthetic CLI task families compared sequential checkpoint review with supervised concurrent review. Concurrent runs had no explicit audit waits during coding and finished sooner in three pairs, but one finished slower overall. Final completion gates still waited. This supports a supervised pilot, not a universal speedup, a zero-overhead promise or evidence about large native/provider workflows. The benchmark used a fixed behavioral oracle, not a language model's semantic association review.

Token telemetry was unavailable. Do not claim token savings or substitute elapsed time, characters, source bytes or tool-output token counts for actual per-role model usage. Measure launch-to-current-gate time, worker admission, explicit waits, review workload, rework, stale results and failures. Preserve quality thresholds before judging a workflow optimization useful.
