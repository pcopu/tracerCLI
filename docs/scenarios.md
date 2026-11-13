# Reusable named scenario steps

A scenario catalog exposes the actions, preconditions, expected results and relevant source for a journey without repeatedly reverse-engineering its test script. Author a step once, review it with its assertion witness, then reuse its stable ID in ordered scenarios. Distinct input variants need distinct step IDs. Keep steps small enough to have precise assertions but large enough to describe meaningful behavior.

This is **declared navigation**, not measured coverage. Tracer cannot infer whether a source association is correct, whether an assertion is strong, or which production branch ran. A passing command is not an assertion. Review those relationships before `scenario link`.

For whole-codebase mapping, start with the separate [full proposed map](proposals.md), including uncertain or unwritten tests, then audit in batches. This witness-bearing catalog is the later reviewed-link format; do not delay the initial proposal until all witnesses exist or tests run.

## Catalog

A version-1 catalog has exactly `version`, `kind`, `steps`, and `scenarios`. Steps contain `id`, `title`, a nonempty `preconditions` array, ordered literal `actions`, `expectations`, and `mappings`. Each expectation has a local `id`, `description` and an exact assertion-bearing `witness` range. Each mapping names a source range, an expectation ID and a bounded `why`. Empty mappings are allowed, so unmapped steps remain visible.

```json
{
  "version": 1,
  "kind": "scenario-step-catalog",
  "steps": [{
    "id": "create-project",
    "title": "Create a project",
    "preconditions": ["An isolated empty synthetic workspace"],
    "actions": ["app project create --title Synthetic", "app project show"],
    "expectations": [{
      "id": "title-saved",
      "description": "The returned title is exactly Synthetic",
      "witness": {"path": "tests/project.mjs", "start": 24, "end": 25}
    }],
    "mappings": [{
      "source": {"path": "src/project.mjs", "start": 12, "end": 19},
      "expectation": "title-saved",
      "why": "Project creation and public readback preserve the requested title."
    }]
  }],
  "scenarios": [{
    "id": "project-roundtrip",
    "title": "Create a project and verify it",
    "steps": ["create-project"]
  }]
}
```

Paths and ranges above are illustrative. Use current repository ranges, not these coordinates. No commands in this JSON execute. Never put tokens, real personal data or secret arguments in the catalog. Preconditions document fixture and authorization assumptions; Tracer does not satisfy them automatically.

## Prepare, inspect, audit and link

```sh
tracer scenario prepare --file scenarios-draft.json --json > scenarios-pinned.json
tracer scenario check --file scenarios-pinned.json --json
tracer scenario report --file scenarios-pinned.json --scenario project-roundtrip --json
tracer scenario packet --file scenarios-pinned.json --json > proposed-links.json
```

`prepare` pins exact UTF-8 snippet bytes for source and witnesses. It fills only missing hashes and rejects supplied stale hashes, so it cannot silently refresh previous evidence. Save to a different file; shell redirection to the input path would truncate it before Tracer reads it. All paths are repository-relative regular unsymlinked files, outside `.git` and the map path.

`check` validates schema, references and current source/witness hashes. `report` shows each selected named step once with source snippets and expectations, then compact ordered occurrences with action offsets. Every link uses the **entire ordered scenario action sequence**, including setup and repeated actions. Each occurrence's actionStart/actionEnd offsets locate it within that full sequence for review context. Reusing a step never discards its prerequisites. Unused step definitions remain checked but generate no links. Step slices, repeated occurrences and renamed IDs cannot manufacture additional manual traces. Full sequences describe scenario association, not per-action causality.

`packet` produces a version-1 manual link proposal compatible with the existing sidecar. Identical source/action/witness identities are deduplicated across scenarios, without losing repeated actions inside a sequence. It does not mutate the map or approve the proposal.

Review each changed step's source, assertion and preconditions together. Reuse that review for unchanged definitions; review each new composition's setup/order/data assumptions. Audit risky boundaries separately: early-return interception, alternate error branches sharing one status, unsupported wrappers, exact input variants and absent native observations. Do not require a second full review of every unchanged row. Integrity checks are not this semantic audit.

After review, obtain SHA-256 of the **exact pinned catalog file** and current map bytes. For a missing map, use SHA-256 of empty bytes. Run one integration owner:

```sh
tracer scenario link --file scenarios-pinned.json --reviewed \
  --expect-catalog-sha256 CATALOG_SHA256 \
  --expect-map-sha256 MAP_SHA256 --json
tracer check
tracer report --json
```

`--reviewed` is an explicit attestation by the operator, not a review performed by Tracer. Integration validates all pins under one exclusive map lock, preserves prior records and metadata, rejects conflicting identities or stale inputs, and applies the batch atomically. Exact repeated imports are idempotent. A changed rationale/hash needs an explicit unlink/review/relink, never an implicit replacement. Old `link` commands and version-1 maps remain supported. Catalogs do not change categorization or measured datasets.

## Capture actions and assertion results while the real scenario runs

The optional package export `@pcopu/tracercli/scenario-runtime` provides `createScenarioRun`. Add it to the application's test harness; execute that harness through the real configured CLI, for example `tracer app -- test project-roundtrip`. It is not automatically injected into arbitrary applications.

```js
import { createScenarioRun } from '@pcopu/tracercli/scenario-runtime';
const run = createScenarioRun({
  catalog: pinnedCatalog,
  scenarioId: 'project-roundtrip',
  runId: 'unique-run-id',
  context: { build: 'actual-build-identity', platform: 'actual-platform', inputRoute: 'CLI' }
});
try {
  await run.step('create-project', async step => {
    await step.action('app project create --title Synthetic', () => appCLI(['project', 'create', '--title', 'Synthetic']));
    const result = await step.action('app project show', () => appCLI(['project', 'show']));
    await step.expect('title-saved', () => assert.equal(result.title, 'Synthetic'));
  });
} finally {
  saveRunResult(run.finish());
}
```

`appCLI`, `assert`, `pinnedCatalog`, and `saveRunResult` are application-owned integrations, not Tracer APIs. Action callbacks explicitly execute reviewed application interactions; descriptions never execute by themselves. Assertion callbacks must contain real checks and throw on failure. Returning `false` fails too. A no-op callback is not a meaningful assertion even though it returns successfully, so audit the witness.

The helper records actual callback order, time, fixed failure codes and separate action/expectation outcomes without saving callback results, exception messages, command output or runtime secrets. Finish returns a frozen result; writing it is an explicit application action. Only optional `build`, `platform`, and `inputRoute` context strings are accepted. Do not put secrets in descriptions or context.

All planned actions must finish before assertions for that step. Split interleaved checks into separate steps. Forgotten assertions stay not-run and make the run incomplete. A thrown or swallowed callback failure cannot become a passing run. Out-of-order, overlapping, nested and leaked calls are rejected. Pending work cannot be finished, and repeated finish calls return the same result.

Results are labeled `adapter-reported`. The result's `catalogSha256` hashes `JSON.stringify(catalog)`, not file whitespace; the CLI report's digest hashes exact file bytes. These are deliberately different identities. Capture does not create manual links, validate assertion strength, collect instrumentation or provide cryptographic build attestation. Continue using the separate `measure` dataset for actual LCOV observations.

## Where this saves time

Review and record each reusable action/assertion/source relationship once, then validate only changed definitions and new composition assumptions. Run independent service/tooling groups while map-only proposals are prepared. Choose broad journeys with substantial newly asserted behavior rather than repeatedly mining almost-complete scenarios for tiny gaps. Measure newly mapped unique included lines per complete review/integration/checkpoint time and newly passing behavioral assertions separately. Compiler/import timing alone is not an end-to-end mapping speedup.


## Inspect integration before guarded linking

`scenario report` adds a read-only `integration` preflight for the selected scenarios against the current sidecar. `totals.new`, `totals.identical` and `totals.conflicting` count compiled candidate links. Each candidate row includes its `proposedId`, status and matching existing IDs with exact `differingFields`. Identity uses the exact source range, ordered action array and witness range, as guarded linking does. A changed explanation therefore conflicts with an existing identity. A generated ID collision also reports the existing ID and differing fields.

`sidecarValid` gates classification. An invalid or stale sidecar produces `ready: false`, unknown `totals: null` and at most 25 diagnostic rows, with `total` and `truncated` describing omitted rows. Run `tracer check` for complete integrity findings. `scenario check` continues to validate the catalog independently of sidecar integrity.

A `ready: true` result describes that read-only snapshot. It grants no approval, changes no links and establishes no execution evidence. Review source, actions, witnesses and explanations, resolve conflicts explicitly, then supply current catalog and map hashes to `scenario link --reviewed`. The locked integration still performs its complete checks.
