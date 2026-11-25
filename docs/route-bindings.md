# Provisional proposal route bindings

Join an existing pinned proposal to an explicitly supplied, reviewed route catalog.

```sh
tracer proposal bind --file docs/testing/proposed-scenario-map.json \
  --routes docs/testing/routes.json --json
```

The command reads repository files and emits JSON to stdout. The proposal retains its repository-relative file contract. The explicitly supplied route catalog may be an external absolute file or a path resolved relative to the selected repository root. Catalogs must be regular, unsymlinked UTF-8 JSON files bounded to 32 MiB. This permits discovery artifacts to remain outside pinned source. Paths inside catalog records retain the separate repository-relative contract below. Existing proposal validation checks scenario and association structure. Malformed structure and unsafe paths fail binding. Source-pin freshness issues are reported alongside usable exact-path route candidates.

## Route catalog

```json
{
  "version": 1,
  "routes": [
    {
      "id": "project-roundtrip",
      "paths": ["tests/e2e/project-roundtrip.mjs"],
      "argv": ["test", "--scenario", "project-roundtrip"]
    },
    {
      "id": "tooling",
      "paths": ["tests/tooling/arguments.mjs", "tests/tooling/persistence.mjs"],
      "argv": ["test", "tooling"]
    },
    {
      "id": "restricted-case",
      "paths": ["tests/e2e/restricted-case.mjs"],
      "argv": ["test", "--scenario", "restricted-case"],
      "restriction": "Requires an explicitly permitted new route"
    }
  ]
}
```

Each path must name an existing regular repository file. The join uses exact equality with a plan's `existingPaths`. A caller can explicitly advertise several helper or witness paths under one aggregate entrypoint. The command performs no basename, title, substring or import-graph inference.

`argv` contains the exact application arguments a caller could forward after `tracer app --`. Argument order, repetition, spaces and empty arguments are preserved. Each argv must contain at least one string. Control characters are rejected. A route ID may recur with additional paths when its argv and restriction agree. Conflicting duplicate IDs are rejected.

## Result

The result has kind `provisional-plan-route-bindings`, raw-byte `proposalSha256` and `routesSha256`, `bindings`, `plans` and `unmatchedRouteIds`. All results have provisional status and unknown assertion match.

Bindings deduplicate complete ordered argv arrays while retaining advertised `routeIds`, matched paths and every referring `planId`. Restrictions accumulate across aliases sharing an argv. Such a binding has `selectable` set to false. Unmatched advertised routes remain visible through `unmatchedRouteIds`. Plans retain candidate, restricted or unmatched status and every unmatched existing path, including plans with no existing paths.

Each binding includes proposed source ranges referenced by its plans. These `predictedSources` retain their source pins and range IDs. Current predictions have provisional status. Stale pins produce stale status, while missing source, invalid pins, overlapping associations or out-of-bounds ranges produce invalid status. Each prediction includes its validation issues and `scoreEligible`. Only current predictions are eligible for a source-prediction score. Top-level `proposalValidation` reports all source issues, while exact-path binding continues for structurally valid plans. The command preserves original proposal bytes and hashes throughout. `measurementAdapter` remains unknown because the generic catalog has no verified instrumentation configuration. An actual execution must separately select the appropriate build, source identity, fixture configuration and measurement adapter.

The command neither executes catalog argv nor discovers the configured app. It writes no proposal, reviewed map, assertion result or measurement dataset. A successful exact-path join establishes a candidate route. Assertion adequacy, observed execution and measured coverage require their own evidence.

## Match a behavior to its CLI actions

Use the application’s current action discovery or capability report to add
`actions` to the route catalog. Each record has an exact string `id` and an
optional `restriction`. Use the identifiers the application actually exposes.
An action ID can identify a documented command scope. Duplicate IDs are errors.

For a behavior you have traced in source, add these optional fields to its
proposal scenario:

```json
{
  "entryPoint": { "path": "src/project.mjs", "symbol": "save" },
  "actionIds": ["open-project", "save-project"]
}
```

The entry point names a real runtime caller, registration or callback. Its
path is validated. Its connection to the assessed behavior requires source
review. Keep `actionIds` ordered, including repeated actions. An empty array
records an explicitly missing CLI route. Omit the field when the match still
needs review. A proposal scenario may supply a `restriction` with its reason.

When a journey file has multiple cases, add the exact discovered `routeIds`
to the plan. A Scriv group has the ID `journeys/edit/group/recover`.
Tracer requires the listed ID and an existing witness path from that
execution. A missing selector appears in `unmatchedRouteIds`.

With an `actions` catalog, each plan has a `behavior.next` result.

| Result | Meaning |
| --- | --- |
| `action-and-scenario` | All required action IDs were discovered and an existing scenario has a selectable path match. |
| `needs-scenario` | The actions exist. Add a scenario or extend it with the required condition. |
| `needs-cli-action` | The entry point is recorded and a required action is absent from this discovery. |
| `review-cli-match` | An entry point or selectable scenario is known. Check that the CLI reaches the recorded behavior. |
| `review-runtime-path` | Start by tracing the behavior to a runtime entry point. Check all supported builds before removing unreachable code. |
| `blocked` | The plan, a required action or all matching scenario routes have a recorded restriction. |

`behaviorRanges` lists each proposed source range once with every referring
plan ID. Stale pins remain visible. A CLI action's presence establishes a
candidate for the recorded discovery context, and a scenario path match still
requires source review and observed execution. Use `tracer app --` to run
approved scenario selectors. Compare later captures with `measure gaps` and
report each batch’s unique passing lines added, remaining gaps and wall time.

For Scriv, `worklist --file PROPOSAL` turns exact, selectable plan matches in
`decisions.nativeBatch` into deduplicated `test --case` arguments. The batch
includes existing cases to run and cases whose scenarios need the planned
condition. This is a candidate score over current passing gaps. Keep blocked
plans and missing action IDs visible in the decision queues.

Set `captureMode` to `startup` when the behavior occurs before the CLI
handshake. These cases appear in `decisions.nativeStartupBatch` with
`--coverage-startup`. The default capture mode is `session`. Native discovery
may advertise host flags in `launchModes`; use those exact IDs in plans for
launch behaviors. In-app actions still come from the capabilities report.

## Rank the coverage work that remains

```sh
tracer proposal worklist --file docs/testing/proposed-scenario-map.json \
  --routes /external/discovered-routes.json \
  --capture-set /external/captures.json --reference-root /external/reference/source
```

Use this read-only command to choose the next batch. It validates the capture
set once, intersects current proposal ranges with lines that lack a passing
observation, and orders each next-action queue by the number of affected lines.
It groups runnable candidates by exact ordered scenario arguments. Each queue
item lists selectable route IDs and shows restricted alternatives with their
reasons. Review the entry point, action IDs and required condition before
running a selector.

Each selector counts a shared line once. The same line can appear under
alternative plans or selectors, so use `assignedGapLines` for the deduplicated
count. `unassigned` ranks current instrumented gaps without a scoreable
association. Start from those files when old source pins have gone stale or a
behavior has no proposal. `unavailable` lists reference gaps whose current source
cannot be matched. Files without instrumentation have no numeric score.
`--limit` caps the items shown per queue (default 15) while totals remain whole.

The proposal and route catalog stay unchanged. Existing captures supply the
measured coverage totals. The proposed priorities describe work to investigate.
Run scoped scenarios on compatible builds and use `measure gaps` with a frozen
baseline to verify unique lines actually added and elapsed time.

## Start from current source and CLI routes

```sh
tracer worklist --routes /external/discovered-routes.json \
  --capture-set /external/captures.json --reference-root /external/reference/source
```

This command starts from the measured gaps. It checks the existing Tracer
source and witness pins and joins current witness paths to exact discovered
selectors. A single unrestricted selector appears under `routes` with its
ordered arguments and the contributing link IDs. Identical argument lists
share one entry. A witness with multiple selectors or a restricted selector
appears under `selectorReview` with each alternative and its restrictions.
A candidate can include `neighboringEvidence` from an exact journey or
scenario group that observed both anchors around a disputed source gap.
Use its selector and example interval to review the existing scenario.
The gap remains in selector review and the restrictions still apply.
Inspect the witness assertions before choosing a scenario group or adding a
missing condition.

`unassigned` lists measured gaps that still need a source-to-CLI match.
Trace those behaviors to their production callers and check which CLI actions
already reach them. A stale link or a witness without a discovered selector
cannot supply a match. Missing mapping data leaves the full gaps visible.
Add `--file` to the worklist when you have reviewed behavior plans.
The worklist commands are read-only and share the same measured denominator.

Scriv can use its launch-free discovery output directly as `--routes`.

```sh
tracer app -- test --list > /external/scriv-discovery.json
tracer worklist --routes /external/scriv-discovery.json \
  --capture-set /external/captures.json --reference-root /external/reference/source
```

For a native catalog scenario with groups, optional `groupWitnessPaths`
maps a listed group ID to its actual assertion support paths. Use checked-in
files under `tests/e2e/support/` or `tests/e2e/journeys/support/`. Each
declared path belongs to its group selector. If two groups declare the same
file, Tracer keeps both as candidates. The scenario entrypoint and recorded
interval journey labels still work as before.

A focused `worklist --source PATH:START-END` includes `focusedWitnessRoutes`
for current manual witnesses inside the selected source with one unrestricted
selector. This includes established witnesses on already observed lines.
Use these routes to inspect related assertions before extending a focused
caller. Only actual counter evidence affects the coverage totals.

Tracer accepts the version-1 `native-cli-scenario-catalog`, validates the
scenario paths and selection, preserves each blocker, and constructs the exact
`test --scenario ID` and `--group NAME` selectors. It matches Scriv's recorded
journey labels by path and optional `#group`. For proposal classification,
use the app's `capabilities` response from the Scriv build you are targeting.
Save the version-1 UIKit JSON outside pinned source and supply it directly.
A normalized route catalog with `actions` also works.

```sh
tracer worklist --routes /external/scriv-discovery.json \
  --capabilities /external/scriv-capabilities.json \
  --file docs/testing/focused-behaviors.json \
  --capture-set /external/captures.json --reference-root /external/reference/source
```

`decisions.queues` ranks current reviewed plans alongside the discovery leads.
A source range whose plans all require a CLI action or have a recorded blocker
stays in its decision queue and is omitted from scenario recommendations.
Shared ranges with an eligible alternative can still appear as scenario leads.
Only current source pins can change which leads are suggested. The report hashes
both discovery inputs, retains the full passing-gap total, and counts the union
of exact witnesses and scored plans in `decisions.classifiedGapLines`. Use
`unassigned` for gaps with neither and `unavailable` for unmatched source.
Use `proposal worklist` for a report limited to the proposal queues.

For coverage worklists, a route can also declare `journeys`, the exact
producer-declared journey labels from the capture set's outcome file. Use the
label for the specific scenario group. Aliases with identical arguments can
share a label. Tracer rejects a label tied to different argument lists.

A whole-scope worklist with UIKit capabilities lists exact passing control
windows in `recordedActions.items`. A matched window can nominate source gaps
and exact CLI cases without a preselected source range. Add `--source` to
include whole-session action hints for a caller you are investigating.

### From a gap to the next case

Every worklist result includes `nextStep` before the detailed evidence. Its
`kind`, `from` and `instruction` direct the agent to the existing result field
to inspect. `recipe` names the facts to resolve: the production branch/caller,
the exact public action and target/event, the triggering state and owned fixture,
and the existing case with its observable assertion. These facts belong in a
short working note; they do not require a new manual map or an approval step.
`afterRun` directs the agent to compare real passing gains with `measure batch`
for supported native receipts, or the adapter's retained capture set.

Declared cases retain their exact selector, condition and `argv`, with an
additional `next` field:

| `next` | Agent action |
| --- | --- |
| `review-and-run-existing-case` | Inspect the fixture and assertion, choose the condition matching the branch, and capture that existing case. Missing evidence does not choose the condition. |
| `extend-existing-case` | The case passed but the focused measured scope still has gaps. Add the missing condition and assertion before running again. |
| `repair-existing-case` | Inspect the failure and fix the existing case or product behavior while preserving its oracle. |
| `review-case-outcomes` | Passing and failed intervals coexist. Inspect their identities and chronology; a historical failure may already be repaired. |
| `reuse-passing-evidence` | Reuse compatible observations before repeating an unchanged case. A complete focused union does not change an individual case's outcome. |
| `review-cli-action` | Supplied capabilities do not advertise the command, or the focused range has a reviewed missing route. Check the actual build and discovery before using or adding it. |
| `resolve-measurement` | A previously passing case lacks comparable focused evidence. Resolve the compatible evidence/build without calling unknown code uncovered; independent cases can still run to produce evidence. |
| `resolve-blocker` | The remaining focused gaps are held by reviewed blockers. Read the recorded restriction and continue independent supported work. |

With no action declaration, the top-level guidance points to existing scenario,
replay or caller leads. If none exists, trace the production entry point and
inspect existing tests before adding a case or CLI route. Missing/stale pins
remain excluded from validated source matches and need review. Guidance never
invents selectors, executes the app, changes mappings or creates coverage credit.
Results remain JSON with or without `--json`.

Reviewed held ranges take precedence over declared case advice when all remaining
measured gaps in the scope are held. Discovery remains visible, but its cases do not gain
permission to bypass a recorded blocker. Shared gaps with an eligible reviewed
alternative remain actionable.

For an asynchronous gap, change state at the real owned dependency boundary and
use a full-session capture. A synchronous control window around opening a sheet
cannot establish that a later sync callback ran. After a zero-gain passing run,
review the state and capture boundary before repeating the same case unchanged.

Native discovery can include `groupActions` keyed by the listed group name.
Each entry names an action `id`, its CLI `command`, and the `condition` the
case exercises. An optional `trigger` describes the actual public control or
shortcut. An optional `entryPoint` pins a production function with its source
`path`, `start`, `end`, and SHA-256 of the exact range bytes. An optional
`branch` uses the same fields to pin the production range the named condition
reaches, such as a completion handler in another file. A branch declaration
requires an entry point. Define both alongside the runnable cases.

`tracer worklist --routes CATALOG --action edit-line` returns the named cases
and ready-to-use `test --case` arguments directly from discovery. Supply the
reference and capture set to include retained outcomes, observed source ranges
and whether the passing interval recorded the declared CLI command. With a
source-focused worklist, a current branch and entry-point pair can match a
selected instrumented range directly, without a compiler call map. A
`condition-branch` match shows the cases whose declared branches intersect
the focus. If none match for an action, the worklist falls back to its current
entry point or compiler-resolved callee. Captures still describe case
intervals, and declarations do not contribute passing lines.
With a pinned function map containing compiler calls, `dispatchBatch` can
also nominate an unobserved callee when the same exact control window observed
its caller's body. The example gives the call site, observed caller line and
unobserved callee range, including across files. Review the condition at the
call site before extending the case.

Once you know the production caller and its CLI action, use the action ID and
the caller's source range to find a scenario to extend.

```sh
tracer worklist --routes /external/scriv-discovery.json \
  --capabilities /external/scriv-capabilities.json --action export-project \
  --source apps/catalyst/ScrivUIKit/Automation/ScrivCLIExport.swift \
  --capture-set /external/captures.json --reference-root /external/reference/source
```

`actionReview` compares the exact action with retained passing intervals and
their discovered selectors. It ranks scenarios that observed lines in the
selected source first and includes an example interval ID and observed ranges.
`actionReview.extensionCandidates` ranks missing conditions whose two anchors
occurred in a post-launch interval recording that exact action. This shortlist
also considers gaps with existing source witnesses.
Scenarios that recorded the action elsewhere remain candidates for review.
A fully observed focus with a matching scenario reports `no-passing-gaps`.
When there is no retained passing match, look for an existing unmeasured
scenario or write one. If discovery does not list the action, check the
production caller and build capabilities before adding a CLI action. Restricted
selectors stay in a separate list.

Scriv command evidence uses the exact `scriv COMMAND` capture label. Menu
scope IDs in Scriv capabilities, such as `script-entries`, match exact
`scriv menu-action --scope script-entries` labels in new captures. Use the
scope ID as `--action`. The broad `--action menu-action` still uses the
original command records from both newer and older captures. For a button,
use `--action activate --target CONTROL_ID` with its stable identifier from a
real Scriv snapshot. For example, the Codex cancel button is
`--action activate --target codex-cancel-check`. Scriv captures from direct,
completed identifier dispatches supply an exact identifier fingerprint.
The filter keeps other buttons, numerical view paths and earlier unscoped
activations out of the action shortlist. Use the broad `--action activate` to
inspect those historical captures. For version-1
route catalogs, use the exact measured action string as `actions[].id`. A passing interval containing an action and source counters
establishes co-occurrence. Review the caller and scenario before assigning
causality, and measure the new condition to establish its gain.

With these labels, `extensionCandidates` ranks selectors that have a passing
interval with counter increases on both neighboring instrumented lines of an
unassigned gap. Uninstrumented lines can split a physical gap into several
ranges. Tracer uses instrumented neighbors and reports the actual gap lines in
`sources`. Each example includes its interval ID, journey label and anchor
lines. With `--capabilities`, `actionIds` lists the discovered CLI actions
recorded in that interval, including specifically recorded menu scopes. You can
supply capabilities without a proposal or an action filter. Use those IDs and
the exact selector to find the existing fixture and inspect the production
caller. Multiple recorded actions in an interval each remain possible leads.

For native Scriv discovery, `startupCandidates` contains gaps whose two
anchors only increased together in isolated launch intervals. Use the listed
scenario to inspect the launch fixture and choose a first-launch or reopen
scenario for the missing initial state. An interval recorded after launch gets
precedence if it reaches the same two anchors. Both lists leave their gap
lines uncovered.
`extensionCandidates.items` is a batch shortlist. Each selector is picked for
the largest number of candidate gap lines still absent from earlier items.
`marginalGapLines` counts that contribution. For ties, Tracer prefers more
`exclusiveGapLines` nominated by just one unrestricted selector. Selectors
that would add zero candidate lines remain counted in `count`. Recently
selected lines may still appear in an item's full `sources` for context.
Restricted selectors and their reasons stay under `extensionCandidates.restricted`
and cannot use up the shortlist limit. Neither list changes passing totals or
assigns an uncovered line. Review the anchor examples and trace the required
condition before extending a journey.

## Match gaps within compiler-mapped functions

Use `worklist --function-map FILE` with an export from the signed reference
build. The version-1 JSON has kind `llvm-function-map`, the reference
`buildSha256` and `sourceManifestSha256`, and a `files` array. Each entry
contains the reference-relative `path`, its exact full-file `sha256`, and
inclusive physical line pairs in `ranges`. Tracer checks the build, source
manifest, and file pins against the selected reference. Producers must also
verify their compiler export and profile. The map contributes no observations.

When both anchors belong to compiler-mapped functions, at least one function
must contain both before Tracer recommends extending that scenario from their
proximity. `functionReview.crossBoundaryGapLines` counts remaining lines that
lost that lead. `functionReview.entryPoints` ranks functions with no passing
line in the full function, after existing witnesses and reviewed dispositions.
Trace them to the real CLI registration, a callback, or another production
caller. A wholly unobserved function can still have a valid runtime entry point.

A producer can include `calls` in the same function map. Each entry is
`{"caller":{"path":"src/controller.swift","line":92},"callee":{"path":"src/service.swift","start":60,"end":124}}`.
Use compiler-resolved source references from the exact build inputs. The
call site must belong to a mapped caller function and the callee must name an
exact mapped range. Leave unresolved dynamic dispatch and registrations for
source review. An absent call is inconclusive.

`functionReview.callers` proposes the exact discovered CLI cases whose passing
reference intervals observed the caller's function while the callee has no
passing body observation. Anchors belong to the caller's own function, and
callers may be in a different file from the requested `--source` range.
Each example gives the call location, observed caller line, callee range and
interval ID. Inspect the condition at the call site before extending the case.
Native batch suggestions deduplicate these lines with the other scenario
leads. `functionReview.callers.declarations` lists calls inside nested
functions whose declaration line increased before a body was observed in the
same case and capture mode. A line shared by a UIAction registration and its
closure can count at registration time. Read that call site and find the
control or callback event before selecting a case. Declaration leads are
separate from the native batch. Reported lines are candidates until measured
by a new passing run.

## Rank the routes for a source range

```sh
tracer worklist --routes /external/scriv-discovery.json \
  --capture-set /external/captures.json --reference-root /external/new-build/analysis/source \
  --source src/service.swift:60-124 --source src/controller.swift:90-105
```

Repeat `--source` to examine related code together. Tracer ranks links,
scenario extensions, replay candidates and reviewed decisions within the
selected ranges before applying `--limit`. A path without a range selects the
whole file. Overlapping selections count each reference line once. The
project-wide coverage counts stay intact, and `sourceFocus` reports the
selected instrumented, passing and gap counts. Selections with no reference
instrumentation are listed under `unknown`. Use `measure where` to inspect
individual physical lines and prior witnesses. Stale and unavailable files
retain their reference denominator under `unavailable`.

## Review code without a runtime path

Use `tracer dead-code PATH:START-END --why ... --evidence ...` after tracing
callers, callback registrations and supported build targets. The worklist's
`runtimeReview` shows current declarations alongside their measured gaps.
`observed-execution` means the code ran in a compatible interval. A
`witness-conflict` means a current source-to-CLI link points to a discovered
scenario route. Resolve either finding before proceeding with removal.
Declarations without comparable instrumentation are `unmeasured`.

`review-removal` still needs a human decision. Its uncontradicted lines count
toward `pendingGapLines` and stay out of extension and replay suggestions.
They remain gaps in the passing totals until a verified new reference changes
the instrumentation. Invalid or stale declarations are listed with their
errors and never hold lines. Use `--source` to review one behavior at a time.

## Recover coverage on a rebuilt source tree

```sh
tracer worklist --replay --routes /external/scriv-discovery.json \
  --capture-set /external/captures.json --reference-root /external/new-build/analysis/source
```

Use the current capture set that includes both the new reference and retained
captures from earlier builds. `replayCandidates` ranks already-discovered
scenarios whose earlier passing intervals nominate current gaps. It matches the
exact journey label to an unrestricted selector. On changed files it matches
unique, exact source lines with both neighboring lines unchanged. For unchanged
bytes with different instrumented lines, it uses the original coordinates.
Each prior source snapshot and outcome must pass the ordinary evidence checks.
A startup replay includes `--coverage-startup` in its command. A passing
compatible capture for the same file and mode satisfies that replay.
When an attempt fails in the exact reference scope, `failedReplays` shows
the remaining ranges, failed interval and receipt for that capture mode.
Inspect the failure before running that selector again.
A Scriv receipt may also provide a typed `failure.diagnostic` with a relative
scenario source location and the number of matching controls. Tracer validates
the diagnostic against the receipt's exact scenario and group. Older receipts
still supply the failed interval and receipt path.
Current reviewed holds supplied through `--file` also apply to replay leads.

The total counts candidate lines once. Each item gives exact `argv`, candidate
source ranges and `marginalGapLines` beyond earlier selections. A selector that
would add no further candidate lines is omitted from the ranked list. The
reported denominator and passing counts still come from exact compatible
observations. Run the selected groups against the current build and import
fresh receipts before measuring gains.
