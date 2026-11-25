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

With these labels, `extensionCandidates` ranks selectors that have a passing
interval with counter increases on both neighboring instrumented lines of an
unassigned gap. Each example includes its interval ID, journey label and anchor
lines. This locates an existing fixture and scenario to inspect when adding a
condition. Treat the intervening gap as uncovered. Restrictions still apply.
The overall total counts each shared gap once. `exclusiveGapLines` counts
gaps with one candidate selector and sorts those selectors first. The report
keeps the gap in `unassigned` until it has a current witness or a scored plan.
The anchor examples retain their full surrounding gap for context. Candidate
`sources` contain the exact lines still suggested for extension.

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
A selector with a passing compatible capture for the same file is skipped.
If a selector already failed in the exact reference scope, its remaining
candidate ranges appear in `failedReplays` with the failed interval and
receipt. Inspect the failure before running that selector again.
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
