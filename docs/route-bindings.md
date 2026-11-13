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
