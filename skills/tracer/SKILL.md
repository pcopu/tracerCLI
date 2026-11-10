---
name: tracer
description: Author scenarios alongside code, supervise immutable background audits, and gate completion on current receipts; propose whole-repository maps before auditing while keeping proposals, reviewed links and execution evidence separate. Use for Tracer workflows, coverage gaps and keeping app or server CLI features testable; categorization and manual links never prove execution.
---

# Tracer

## Start with the requested outcome

For mapping, deliver the proposed map before exhaustive audits or execution. For testing, optimize for newly exercised behavior with meaningful assertions, not link-row count. Start from the current repository, existing scenarios and exact requested outcome. A small remaining gap needs a focused closure pass, not a new whole-repository audit. A large unfamiliar codebase benefits from parallel categorization while execution proceeds.

For a whole-codebase mapping request, follow the proposal-first workflow below before audits. For testing or feature implementation, use this working loop, adapting its size to the project:

1. **Establish a usable baseline.** Read repository guidance, inspect the configured CLI and existing feature/test inventory, and run `tracer check` plus `tracer report --json`. Identify the current source/build, target platforms, test command and immediate execution blocker. Reuse current evidence; do not regenerate an unchanged audit.
2. **Run a broad real scenario early.** Prefer a representative user goal with several observable stages, persistence and reopening where relevant. Start with supported routes and reuse existing scenario pieces. Do not wait for every feature to be categorized or every CLI route to exist before running independent supported scenarios.
3. **Work in parallel where it helps.** Categorize source into features, extend missing CLI routes, write scenarios and prepare required builds as independent lanes. Give each writer disjoint files or ranges. Keep one integration owner and one owner per shared native app session or device.
4. **Use the gaps to choose the next batch.** Combine feature inventory, uncovered observations, failed assertions and inaccessible routes. Prefer broad scenarios with high expected behavioral gain; add focused cases for errors, cancellation, recovery and boundaries the broad flow cannot establish. A measured line hit still needs a relevant assertion.
5. **Integrate and verify a meaningful batch.** Merge reviewed changes, run affected journeys, validate mappings, then run required aggregate checks on final bytes before publication. Produce a checkpoint after a coherent feature batch or necessary handoff, not after every tiny link. Preserve required evidence and recovery points.

For an execution or implementation task, do not spend the entire task preparing an increasingly elaborate scenario that has never run. When a native build, disk budget, account or permission blocks execution, report the exact blocker and continue portable work. More mapping workers cannot remove that critical path. Estimate completion from measured end-to-end throughput, including review and integration, rather than raw model output speed.

## Existing code: propose the full map first, audit afterward

For a whole-codebase mapping request, produce a useful complete **proposed scenario map first**. Do not serialize proposal writing behind semantic audits, exact assertion witnesses, native builds or test execution. Audited linking and actual testing are later, separate progress tracks. Running independent existing tests may continue in parallel when authorized; their availability must not hold up proposals. A small change only needs an incremental proposal for its affected scope.

1. **Freeze the current inventory and scope.** Reuse valid feature categorization, source hashes and existing scenario summaries. Split the remaining scope into balanced, disjoint source ranges with one owner each. Preserve current reviewed links and agreed exclusions. Do not recategorize unchanged source or create a new exhaustive audit prerequisite.
2. **Propose scenarios for every included range.** Give each association a concrete scenario family, planned actions, observable proposed assertions, rationale, confidence and explicit uncertainty. Reuse plausible existing journeys; label them `needs-extension` when exact witness support is unknown, or `unwritten` for missing tests. Unknowns belong in uncertainty or an explicitly unresolved plan, not omitted ranges or fabricated command logs. Configuration, types, build and tooling may need appropriate contract scenarios rather than UI claims. Keep the proposal in a separate file, never the reviewed sidecar.
3. **Publish the full proposal checkpoint promptly.** Read `docs/proposals.md`; use `tracer proposal prepare --file draft.json` to pin source bytes and save its output to a different file, conventionally `docs/testing/proposed-scenario-map.json`. `proposal check` validates integrity, and `proposal report` reports the full plan and current scoped percentage. These commands do not execute the app, require assertion witnesses, or create reviewed links. The CLI does not invent scenarios; author them from source and feature context. Do not withhold a complete proposal while auditing it.
4. **Audit in bounded batches afterward.** Use `tracer proposal audit --file docs/testing/proposed-scenario-map.json --offset 0 --limit 25` to inspect source, plans and uncertainty together. Review risky boundaries, exact input variants, interception by outer guards, missing wrappers and whether the proposed assertion distinguishes the behavior. Reuse review of unchanged definitions. Repair only affected proposals after source changes; never blindly refresh stale pins. Report rejected and unresolved relationships honestly, preserving the original proposal until explicitly revised.
5. **Promote only explicitly reviewed relationships.** As witnesses become available, author reusable named steps with exact actions, fixture preconditions, assertion-bearing expectations and bounded source associations using `scenario prepare/report/packet`. One integration owner uses `scenario link --reviewed` with exact catalog and map hashes. `proposal audit` is read-only and never marks a row reviewed. No proposal, percentage, successful check or passing test automatically promotes anything. An audit can be completed without executing tests; do not infer an observed result from it.
6. **Execute and measure separately.** Run authorized real journeys through the application CLI and capture actual outcomes/build/platform/input route. Where instrumentation exists, use the separate measured dataset. Neither execution nor a passing run is a prerequisite for the full proposed map. Final code publication still requires the repository's applicable checks, and completed testing claims require their own evidence.

Keep **proposed / reviewed / executed** statuses and percentages visible with their actual denominators. `report --json` exposes independent `progress.proposed`, `progress.reviewed` and `progress.executed` fields. Reviewed progress is current operator-declared manual links, not independently verified semantic audit. Execution is `null`/unknown in mapping reports, never inferred as 0% or 100%; report actual execution evidence in its own supported scope. A 100% proposal with 10% reviewed links is useful progress, not 100% tested behavior.

## Active coding: author scenarios together, audit asynchronously

Author or update the scenario contract, supported CLI route and meaningful assertions **alongside each feature change**, not as a deferred cleanup. Keep coding and scenario authoring in one lane; give independent reviewers frozen snapshots rather than the mutable working tree. Execute affected real journeys early when possible. A whole-repository proposal remains an early deliverable for a mapping request, not a prerequisite before each edit.

Read `docs/audit-queue.md` for the queue protocol and receipt contract. Use this loop:

1. **Author a complete affected contract.** Include concrete fixtures, ordered actions, required state/reset, observable outcomes and relevant caller/guard assumptions. Review every range's `proposedAssertions` AND every linked shared scenario's `expectedOutcomes`, with its actions. Shared text is part of every referring association, not background that can be omitted from review.
2. **Enqueue a stable milestone.** Prepare a current proposal, then use `tracer audit enqueue --file PROPOSAL --author NAME` with a useful bounded batch and explicit `--context` files for callers, wrappers or witnesses outside the referenced source. This freezes the selected full contracts and full source/context bytes in `.tracer/audits`. Enqueue on meaningful milestones, not every keystroke. Deduplicate unchanged inputs and bound pending work; a full queue is visible backpressure, not permission to discard review obligations.
3. **Supervise one independent review lane initially.** The coordinating agent retains the reviewer, claims a job with `audit claim --worker NAME`, and supplies the returned immutable job and claim ID. The queue does not launch processes or contact reviewers. Do not use a detached process as a substitute for supervision. Continue unrelated coding while review proceeds; poll or collect results at natural milestones instead of waiting after every enqueue.
4. **Review semantics, not just pins.** Assess source-association fit, assertion adequacy and executable readiness separately. Trace the whole call path and outer guards, replay interception, temporal ordering, stale responses, cancellation, boundary inputs and claimed privacy/atomicity/failure behavior. For each verbatim assertion, identify fixture, action, required state/reset, oracle and guard evidence. A helper can support a wider scenario without implementing every step; an unwritten fixture can block readiness without disproving source fit. Never relax production guards or call static/mock checks real native/provider execution.
5. **Record findings against that claim.** Use `audit record --file RECEIPT` for reviewer declarations with evidence and concrete corrections. Missing context or an unresolvable claim stays unresolved. A failed/crashed review must not become an accepted receipt: explicitly `audit fail` the claim and `audit retry` when appropriate. Pending/running work stays visible until completed or explicitly recovered; the CLI does not infer worker liveness.
6. **Correct separately and re-audit independently.** Preserve original snapshots and findings. Revise affected contracts deliberately, giving a contract its own scenario identity when changing a shared definition would affect unrelated associations. Queue revised contracts for a new independent audit; do not have the author turn a correction into acceptance. Carry a prior receipt only when exact full contract and all pinned source/context bytes still match. A changed proposal elsewhere alone need not invalidate an unchanged association, but even an out-of-range edit in its source file makes its receipt stale.
7. **Drain at completion, not during raw coding.** Before declaring the work complete or ready for publication, run `tracer audit status --file PROPOSAL` and `tracer audit drain --file PROPOSAL` against the final current proposal and source. The default gate covers **all current proposal associations**, including ones never enqueued, not merely the last batch. Any explicit narrower selector must match the agreed completion scope. Missing, pending, running, failed, correction-needed, unresolved or stale required review blocks audit completion. Run affected journeys and repository aggregate checks separately against final bytes; drain neither executes them nor proves their results.

Keep reviewers read-only against the author's tree. Findings should be concise, source-linked and surfaced at useful milestones; queue chatter must not interrupt every edit. Periodically use a small blind overlap and adjudicate disagreements against source. Preserve withdrawn findings and do not describe reviewer agreement as accuracy.

A receipt is a **reviewer declaration**, not proof that source behavior is correct or a scenario ran. Queue acceptance never promotes proposal rows into reviewed witness links, passing tests or measured execution. Report proposed mapping, semantic-audit statuses, reviewed witness mapping and actual execution independently, with their own denominators.

The supporting benchmark had four small matched pairs: concurrent review removed audit waiting during coding, but one pair finished slower overall and final gates still waited. This supports a supervised pilot, not a general speed guarantee. Token telemetry was unavailable; do not claim token savings or substitute characters, source size or elapsed time for token usage. Measure end-to-end time, explicit waits, review/rework, stale results and failures separately.

## Discover and maintain the real CLI surface

Use `tracer --help` or the trusted installed `bin/tracer.mjs`; Tracer requires Node.js 20+ and Git. Inspect the application's actual CLI before inventing commands. Preserve its chosen `--map`, `--include-ext`, scope and minimum. The default map is `docs/testing/code-e2e-links.json`.

An application CLI lets agents and tests operate the real app through commands. Inspect existing routes, then build or extend the CLI within authorization as features are tackled. Include server features as well as UI features: HTTP/WebSocket behavior, authentication, persistence, jobs, cancellation and failures need real supported entrypoints and observable outcomes. Reuse production handlers without substituting direct implementation calls for CLI interaction. Tracer connects to a CLI; it does not create one automatically.

CLI feature parity is a completion requirement, not a global prerequisite that blocks all useful testing. Maintain a list of supported, missing, restricted and platform-specific routes. Before claiming complete CLI-driven testing, reconcile every in-scope feature with a tested route or an explicit unresolved gap. A command list alone proves neither behavior nor UI/native-input parity.

Keep the app CLI at feature parity whenever application features are added, changed or removed. In the same authorized change, update commands, discovery/help, CLI behavior and E2E journeys to reflect the current app, then update the related map. Report any route you cannot provide rather than silently leaving a feature untestable.

A mapping-only request does not authorize application changes. Preserve authentication, consent, safety checks, input-route semantics and user data. List unimplemented routes, platform constraints and deliberately restricted actions honestly. Never bypass a restricted interaction, replace a denied operation with an equivalent back door, or add production test-only bypasses to reach a percentage. Use isolated synthetic fixtures; network simulation belongs outside production configuration.

For an authorized new setup, `tracer init` creates missing config/map files without overwriting existing ones. Supply verified executable argv with `--app-json` and actual discovery arguments with `--actions-json`. A missing Tracer connection does not prove the app lacks a CLI. Inspect and trust `tracer.json` before `tracer actions` or `tracer app -- ...`, because those execute the configured application. Arguments and stdio pass through without a shell. Mapping, reports, checks and init do not execute stored action descriptions or app code.

## Categorize large codebases without pretending to test them

Feature categorization is a separate planning/navigation artifact, not a shortcut into the reviewed source/action/test map. Use it when the remaining source is large or poorly understood; skip it when existing reports already identify a small actionable gap. Do not invent a built-in Tracer categorization command; `scenario` manages named steps, not feature classification. Use a repository's existing catalog tooling, or a simple separate artifact appropriate to the authorized task.

- Pin one source inventory with exact file hashes, physical ranges and build/target membership. Separate current app, shared services, server, tooling, tests, generated/vendor code and retained legacy implementations. Keep scope and exclusions visible.
- Use stable feature names, including shared infrastructure and explicit unknowns. Split at semantic boundaries rather than arbitrary lines when practical. A range can describe a shared responsibility; do not force a misleading single-feature label or count it repeatedly to inflate totals.
- Assign disjoint file/range shards with explicit ownership. Workers write separate proposals, not the same sidecar. Useful fields are source path/range, file and snippet hashes, feature, rationale, uncertainty, target, and any known CLI/scenario candidate. Unknown mappings are better than fabricated ones.
- For several thousand lines, pilot a few balanced shards before fanning out. Compare models using similar work and include review time, missing-line repairs and integration overhead. A faster or cheaper model can handle routine classification; use deeper review for stateful, shared or ambiguous code. Do not hardcode a model preference or spawn more workers than capacity and integration can sustain.
- Merge deterministically. Reject stale hashes, out-of-bounds ranges, cross-owner edits, overlaps, duplicate proposals and unsupported feature IDs. Report unclassified lines explicitly. Integrity validation is not semantic review: sample straightforward ranges and review uncertain or cross-feature boundaries before relying on them to plan tests.
- Label model proposals as proposals. Classification may reach 100% while scenario mapping and execution remain incomplete. A category or scenario suggestion must never be promoted automatically to a tested link or measured hit.

Use the catalog to route scenarios and expose missing interfaces. Do not make exhaustive categorization a new serial gate. Classify changed slices incrementally and invalidate only affected proposals; do not relabel the entire repository on each edit.

## Build broad journeys, then targeted variants

Operate through the actual application CLI and inspect public observable state. If the project advertises a test command, run it through `tracer app -- test` or its real equivalent. Use `tracer actions` for discovery. Direct production API calls in a test harness do not establish CLI behavior.

Prefer a coherent user journey over disconnected microtests: create or open work, make related changes, inspect the results, save, reopen and verify retained state. Reuse a session within a coherent journey to avoid needless launch/setup cost, but keep independent journeys isolated. Add assertions at meaningful stages so failures identify the broken behavior. Exercise interruption, cancellation, repeat actions and recovery where they matter. A huge happy-path script without precise oracles is not coverage.

Preserve and reuse existing useful assertions. Replace legacy suites only within authorization and after their intended behavior has an adequate verified replacement; deletion is not proof of migration. Keep platform, input-route and live-service limits explicit. A passing service fixture is not live-account or native UI acceptance.

Run independent CLI/server scenario groups concurrently when fixtures, ports, homes, storage and process ownership are isolated. Benchmark before changing the default. Do not run competing UI drivers against the same app or shared device. Reuse a pinned valid build across compatible scenario-only changes; rebuild whenever source/build identity requires it. Run newly authored slices promptly, and keep final aggregate verification separate from targeted results.

## Link reviewed behavior in semantic batches

Inspect both source and witness. Choose meaningful function, branch or workflow ranges and an exact assertion-bearing test step. Do not make one administrative task per line, blanket-link whole files to the runner, or expand a range over untested behavior merely to fill a gap. Imports, declarations and structural lines can be explained as support for a scenario, but their association does not demonstrate every branch executed.

Record the literal CLI action sequence in actual order, including repetitions, input variants and meaningful preconditions. For example, after verifying these commands and paths in the target project:

```sh
tracer link src/cart.py:10-18 \
  --action 'cart add --sku demo --quantity 2' \
  --action 'cart total' \
  --step tests/cart.spec:20-30 \
  --why 'Add two items, then assert the calculated total.'
tracer report --source src/cart.py:12
tracer report --step tests/cart.spec:25
tracer check
```

Action strings never execute automatically. Omit `--step` when no witness exists and report that gap. Do not include credentials, customer records or sensitive command arguments. Record whether a scenario is prepared, passed, failed, blocked or not run separately: a manual link is not proof of execution.

Maintain related maps with source, actions and assertions. For changed or moved snippets, review both ends, `tracer unlink ID`, then link the corrected ranges. Never blindly refresh hashes or guess relocated ranges. Remove obsolete links for authorized deletions and preserve unrelated records; malformed sidecars need scoped repair, not a reset. Reassess semantic changes even when hashes happen to match.

Use one integrator to apply reviewed link batches and detect conflicting edits. After each meaningful batch, run `tracer check`, inspect the full `tracer report --json`, and execute affected real journeys. Commit related maps with code/tests when publication is authorized. Run final required aggregate checks against the integrated bytes, not merely each worker's earlier copy.

## Resolve scope and obsolete code explicitly

Inventory lines are not necessarily executable lines. A current app build cannot exercise a retained legacy app, a separate server or another platform's branch. Report these targets separately without silently changing the denominator.

Before proposing removal of apparently obsolete code, inspect build membership, imports, callers, dynamic registration, public/package exports, compatibility promises and supported configurations. No hits in one run, no direct text references, an old filename or exclusion from one target is not proof of obsolescence. Retain uncertain code and document the question. Remove genuinely obsolete code only when authorized, with recovery available and affected build/package/scenario checks; update interfaces, maps and documentation together. Do not delete defensive checks or supported APIs to manufacture 100%.

For agreed application-only mapping scope, inspect test/support files before `tracer ignore PATH --why TEXT`; restore with `tracer unignore PATH`. Report included totals, `ignoredTotals` and reasons. Never ignore runtime code, security checks or difficult paths just to pass a threshold. Ignored files and witnesses remain globally integrity-checked, their tests still run, and ignores do not change measured evidence. An empty included scope is not full coverage. Read `docs/ignores.md` for details.

## Report distinct evidence, not one ambiguous percentage

Keep these conclusions separate:

1. **Feature categorization:** proposed/reviewed code-to-feature assignments and unknowns.
2. **Proposed scenario mapping:** full unreviewed plans, uncertainty, unwritten tests and current included-line percentage.
3. **Semantic audit:** current reviewer declarations for source fit, assertion adequacy and readiness; missing, pending, running, failed, correction-needed, unresolved and stale work remain explicit.
4. **Reviewed scenario mapping:** current operator-declared manual links, exact action sequences and witness gaps.
5. **CLI surface:** implemented routes, missing features and restrictions by target/platform.
6. **Observed test results:** actual scenarios, assertions, build, platform and input route; passed, failed, skipped, blocked and not run.
7. **Measured execution:** real instrumentation observations for its exact scope and source/build, not correctness or per-action causality.

For a request to reach 100%, identify the requested metric and denominator from context; clarify only if necessary to avoid doing the wrong work. Continue useful authorized work meanwhile. Report progress and blockers for the intended metric. Never substitute a 100% catalog or manual map for tested behavior, full native parity or completed migration.

The saved `tracer config --minimum-traces N` policy is a positive integer, default 1; preserve the agreed value. Read-only `report --minimum-traces N` compares, and `check --require-minimum` gates the included scope. A distinct manual trace is one exact ordered action sequence, not one link, action or witness. Repeated IDs, overlapping rows or alternate witnesses cannot create extra traces. Do not vary labels to inflate distinctness. Stale/invalid links count zero; action-only links remain planning information.

Manual totals count included nonblank physical source lines outside current declared comments, not executable statements. Report physical and blank lines separately. Inspect every line and language context before `tracer comment PATH:START-END`; never mark code, declarations, mixed lines, strings, docstrings, templates or uncertain text as comments. Marks pin source bytes; review stale marks, `tracer uncomment ID`, then re-mark only verified comment ranges. No blind hash refreshes. Preserve physical ranges and exact hashes. Read `docs/comments.md` and `docs/schema.md` when changing classifications or sidecars.

## Import measured execution only when available

Read `docs/measured.md` from the installed Tracer package or official `pcopu/tracerCLI` repository before capturing/importing LCOV. Tracer imports evidence; it does not supply an instrumentation adapter or run the app for you.

Capture cumulative before/after profiles around a real ordered sequence on an unchanged build. Preserve the run ID, executable/probe/source identities, capture-time per-file manifest, tool versions/hash timing and export hashes. Do not reconstruct build-time provenance from today's checkout. Keep background activity, polling and non-atomic capture limitations. A hash observed after export must say `after-export`; unknown hashes stay null.

Use `tracer measure import --before FILE --after FILE --manifest FILE --sources FILE`, with an explicit `--strip-prefix` when needed; never guess source paths by basename. Imports write a separate dataset, not the manual map. `tracer measure report` supports source/action/sequence lookups, but an action lookup still describes the entire interval. Do not attribute interval hits to individual actions, sum overlapping observations, or treat missing instrumentation as zero coverage. Counter increases are not assertions.

After source changes, `tracer measure check` detects stale evidence. Preserve stale history, exclude it from current observations and recapture when authorized. Use `--allow-stale` only to retain explicitly historical inputs with original hashes. Integrity metadata is not cryptographic source-to-build attestation or proof of correctness.

## Install and update without replacing local work

Agent setup has separate consents: `tracer init --agent codex|claude --install-skill` installs a missing skill; `--add-instruction` separately adds a generic project pointer. Detecting an agent grants neither permission. Preserve customized skills and instructions. Installation does not guarantee automatic discovery or hot reload.

Use `tracer update --status` for local state and an explicitly requested `tracer update --check` for official GitHub availability. Managed installs remain separate from npm/Git checkouts; never overwrite a development checkout or bypass integrity checks. Automatic updates require opt-in. Honor `TRACER_NO_UPDATE=1`, CI and the chosen off/check/apply mode.

Tracer refreshes registered skills only while they match their original checksums. Preserve modified/unregistered skills; merge changes only within authorization. Project instructions remain generic pointers. New CLI code runs on the next invocation; an agent may need a new session to load a refreshed skill. Do not claim active agents hot-reload.
