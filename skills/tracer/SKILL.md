---
name: tracer
description: Measure real CLI scenario execution, provisionally bind existing plans to discovered routes, deduplicate compatible observations and prioritize remaining gaps. Also maintain requested source/action/assertion mappings and semantic audits with separate evidence.
---

# Tracer

Documentation paths in this skill are relative to the selected trusted Tracer package root, the parent of its `bin` directory. They are not relative to the application being tested or the installed skill directory, which contains only this file. Resolve the selected CLI entrypoint and read that package's matching documentation; do not assume a different globally installed version supports the same commands.

## Measure existing scenarios first

For an execution-coverage task, start with existing runnable scenarios and instrumentation. Reuse source tags, proposals, discovery catalogs and prior captures. New manual links, assertion audits and complete categorization are optional planning work unless the user requested them or an affected contract requires review. They do not gate a legitimate measurement run. Preserve the user's requested metric and agreed denominator.

1. Read repository guidance, inspect the trusted configured CLI and discover its exact selectors. Identify available instrumented builds, adapters, provenance and existing measured datasets. Use `tracer measure check --json` and `tracer measure report --json` to establish current evidence. Mapping reports can supply context when needed.
2. Provisionally connect tagged source and planned scenarios to existing routes. Prefer exact plan IDs, source ranges, catalog paths and selector argv. Keep inferred or speculative connections explicitly provisional with their basis, unresolved alternatives and source/discovery hashes. Assertion adequacy can remain unknown. Missing exact bindings should remain visible while supported routes proceed.
3. Deduplicate executions by actual route, required fixture/configuration and compatible build/source identity. Several plans can share one execution. Preserve distinct input variants and assertions. If the user requests all remaining scenarios, execute every authorized remaining selector, retaining blocked and failed results, then target measured gaps. For a bounded pilot, rank provisional targets by unique instrumented lines still unobserved, with setup cost and uncertainty visible.
4. Run real scenarios through the application's public CLI with its supported capture adapter. Reuse a verified pinned build while inputs remain compatible. Capture actual results and intervals promptly, including failures with valid captures. Preserve signing, source/build checks, isolation, account permissions and restricted routes. Keep measurement output outside pinned source where the adapter requires it.
5. Validate and union compatible observations. Count each exact source path and line once within a compatible measurement scope. Preserve failed-outcome observations alongside outcome metadata, and provide a passing-only view when supported. Keep incompatible builds, probes, line universes or source identities separate. Missing instrumentation remains unknown.
6. Compare the union with its instrumented universe and use remaining gaps to choose the next useful routes or focused variants. Distinguish unobserved lines, unreachable/platform-specific paths, missing instrumentation and assertion weaknesses. A provisional target score is a hypothesis until a real capture shows a gain. Recompute after each meaningful batch and improve the workflow when repeated friction has a concrete cause.

Use `tracer proposal bind --file PROPOSAL --routes /external/routes.json --json` to join structurally valid plans to a supplied discovery catalog. Read `docs/route-bindings.md` for its schema. Exact catalog paths match plan `existingPaths`; bindings deduplicate ordered argv while retaining plan/route IDs and restrictions. Restricted bindings remain unselectable. The command executes no routes and writes no mapping or measurement data.

Route catalogs may stay outside pinned source as canonical regular unsymlinked UTF-8 JSON files bounded to 32 MiB. Relative catalog paths resolve from the selected repository root. Paths inside records remain exact existing repository-relative files. A caller may explicitly list helper paths under an aggregate entrypoint. Stale source pins produce validation issues and score-ineligible predictions while exact route joining remains usable. Use only `scoreEligible` predictions for source-gap estimates. Source freshness and assertion review add no prerequisite to independent supported execution.

The binder's `measurementAdapter` and assertion match remain unknown. Before execution, select the actual supported adapter, compatible build/source identity and authorized fixture configuration externally. Preserve proposal/discovery hashes and the provisional basis, then attach actual run IDs, intervals and evidence. A practical loop is bind, deduplicate routes, run supported adapters, union real captures and inspect unobserved gaps. Combine predictions and union gaps in an explicit external ranking artifact when needed. Tracer's binder and union provide inputs to that decision. They supply no built-in scheduler or optimal future-route ranking.

Executed lines, passing scenario results and assertion adequacy are independent conclusions. Real counter increases establish execution within the capture scope even when the source has no manual link or reviewed assertion. They cannot establish correctness, per-action causality or whole-project coverage outside that scope. Never discard valid observations solely because an assertion failed.

Reuse existing broad journeys before authoring many new cases. Add focused scenarios for remaining observable behavior, errors, cancellation, recovery and boundaries. Follow repository test conventions. Continue authorized execution through completion, fixing recoverable tooling problems without bypassing restrictions. When a platform/build/account dependency blocks one route, record its exact state and continue independent supported work.

## Mapping and audit tasks

For an explicit whole-codebase mapping request, produce a proposed map promptly using existing inventory and scenario context. Read `docs/proposals.md`. `tracer proposal prepare --file draft.json` pins a draft, and `proposal check`/`proposal report` validate and report it. Keep proposals separate from reviewed links. Preserve uncertainty and mark missing implementations or bindings explicitly. Update affected slices after changes through source review, preserving historical checkpoints.

When semantic review is requested or required by an affected contract, assess source fit, assertion adequacy and executable readiness separately. Read `docs/audit-queue.md` for immutable snapshots and reviewer receipt handling. Queue bounded stable milestones, supervise the authorized reviewers and preserve unresolved findings. Carry receipts only while full contract and pinned source/context identities match. `tracer audit status` and `tracer audit drain` gate the agreed audit scope when audit completion is the requested deliverable. They add no measurement prerequisite to an execution-only task. A receipt remains a reviewer declaration with its own provenance.

While implementing a feature, update its supported CLI route and meaningful journeys together. Maintain changed source/action/assertion associations where existing mappings are affected or mapping work was requested. Run affected real scenarios and repository checks against final integrated bytes. Keep publication and any explicitly required independent review within the user's workflow.

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

Prefer a coherent user journey over disconnected microtests: create or open work, make related changes, inspect the results, save, reopen and verify retained state. Reuse a session within a coherent journey to avoid needless launch/setup cost, but keep independent journeys isolated. Add assertions at meaningful stages so failures identify the broken behavior. Exercise interruption, cancellation, repeat actions and recovery where they matter. Review assertion adequacy separately for broad flows, using precise public-state oracles at meaningful stages.

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

When mapping is requested or existing associations change, maintain related maps with source, actions and assertions. For changed or moved snippets, review both ends, `tracer unlink ID`, then link the corrected ranges. Never blindly refresh hashes or guess relocated ranges. Remove obsolete links for authorized deletions and preserve unrelated records; malformed sidecars need scoped repair, not a reset. Reassess semantic changes even when hashes happen to match.

Use one integrator to apply reviewed link batches and detect conflicting edits. After a mapping batch, run `tracer check`, inspect the full `tracer report --json`, and run affected real journeys as required by the task. Commit related maps with code/tests when publication is authorized. Run final required aggregate checks against the integrated bytes, not merely each worker's earlier copy.

## Resolve scope and obsolete code explicitly

Inventory lines are not necessarily executable lines. A current app build cannot exercise a retained legacy app, a separate server or another platform's branch. Report these targets separately without silently changing the denominator.

Before proposing removal of apparently obsolete code, inspect build membership, imports, callers, dynamic registration, public/package exports, compatibility promises and supported configurations. No hits in one run, no direct text references, an old filename or exclusion from one target is not proof of obsolescence. Retain uncertain code and document the question. Remove genuinely obsolete code only when authorized, with recovery available and affected build/package/scenario checks; update interfaces, maps and documentation together. Do not delete defensive checks or supported APIs to manufacture 100%.

For agreed application-only mapping scope, inspect test/support files before `tracer ignore PATH --why TEXT`; restore with `tracer unignore PATH`. Report included totals, `ignoredTotals` and reasons. Never ignore runtime code, security checks or difficult paths just to pass a threshold. Ignored files and witnesses remain globally integrity-checked, their tests still run, and ignores do not change measured evidence. An empty included scope is not full coverage. Read `docs/ignores.md` for details.

## Report distinct evidence, not one ambiguous percentage

Report these conclusions with their own sources and denominators.

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

## Capture, import and combine measured execution

Read `docs/measured.md` from the installed Tracer package or official `pcopu/tracerCLI` repository before capturing/importing LCOV. Tracer imports evidence; it does not supply an instrumentation adapter or run the app for you.

Capture cumulative before/after profiles around a real ordered sequence on an unchanged build. Preserve the run ID, executable/probe/source identities, capture-time per-file manifest, tool versions/hash timing and export hashes. Do not reconstruct build-time provenance from today's checkout. Keep background activity, polling and non-atomic capture limitations. A hash observed after export must say `after-export`; unknown hashes stay null.

Use `tracer measure import --before FILE --after FILE --manifest FILE --sources FILE`, with an explicit `--strip-prefix` when needed; never guess source paths by basename. Imports write a separate dataset, not the manual map. `tracer measure report` supports source/action/sequence lookups, but an action lookup still describes the entire interval. Do not attribute interval hits to individual actions, sum overlapping observations, or treat missing instrumentation as zero coverage. Counter increases are not assertions.

Use `tracer measure union --input-root ROOT --input-root OTHER_ROOT --scope strict --outcomes FILE --json` for a read-only union. Repeat `--input-root` as needed. Both `--scope` and `--outcomes` are optional. The default strict scope requires exact source-manifest, probe, build, toolchain, full-source hashes and instrumented DA line sets. Dataset validation and current source checks apply to every input. Matching repeated captures contribute once, with aliases retained. Conflicting duplicates fail. Keep original datasets intact.

Explicit `--scope source-lines` permits different build, source-manifest, probe and toolchain identities when every source path, full-file hash and instrumented DA line universe agrees exactly and source checks remain current. It retains every original identity group and its interval/origin membership in `provenanceGroups`. Report this as cross-provenance source-line presence. Preserve uncertainty about adapter/build equivalence. Each source line counts once, and counters are never summed across captures. Changed bytes or DA universes fail in either scope.

Optional outcomes use `{"version":1,"intervals":[{"id":"INTERVAL_ID","journey":"EXACT_JOURNEY","status":"passed","evidence":{"path":"evidence.json","sha256":"SHA256"}}]}`. Explicit statuses are `passed` and `failed`. Missing declarations remain unknown and are excluded from `passedOnlyKnown`. Input roots and the outcomes path resolve relative to the selected Tracer root. Evidence paths resolve relative to the outcomes file.

Outcome statuses are producer declarations. The union verifies evidence-file bytes and digest and preserves their provenance. Interpretation of native/service evidence bodies, status semantics and assertion adequacy remains with the producing adapter or converter. Validate that actual structured evidence contract before generating declarations. Read `docs/measured.md` for input limits and duplicate/alias rules. Report `allObserved` and `passedOnlyKnown` with these limitations. Journey novelty follows first-encounter input/interval order and describes past interval observations. Future target scores remain provisional until another real capture records a gain.

After source changes, `tracer measure check` detects stale evidence. Preserve stale history, exclude it from current observations and recapture when authorized. Use `--allow-stale` only to retain explicitly historical inputs with original hashes. Integrity metadata is not cryptographic source-to-build attestation or proof of correctness.

## Install and update without replacing local work

Agent setup has separate consents: `tracer init --agent codex|claude --install-skill` installs a missing skill; `--add-instruction` separately adds a generic project pointer. Detecting an agent grants neither permission. Preserve customized skills and instructions. Installation does not guarantee automatic discovery or hot reload.

Use `tracer update --status` for local state and an explicitly requested `tracer update --check` for official GitHub availability. Managed installs remain separate from npm/Git checkouts; never overwrite a development checkout or bypass integrity checks. Automatic updates require opt-in. Honor `TRACER_NO_UPDATE=1`, CI and the chosen off/check/apply mode.

Tracer refreshes registered skills only while they match their original checksums. Preserve modified/unregistered skills; merge changes only within authorization. Project instructions remain generic pointers. New CLI code runs on the next invocation; an agent may need a new session to load a refreshed skill. Do not claim active agents hot-reload.
