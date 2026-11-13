# Propose the whole map, then audit in batches

A complete proposed map is an early planning deliverable. Produce it before exhaustive semantic review, exact assertion witnesses, application builds or test execution. Keep existing reviewed links intact. Audit the proposal in useful batches afterward, then explicitly integrate reviewed relationships and record execution separately.

Tracer validates authored plans; it does not invent scenario associations. Author a separate JSON file using current source and feature context. Uncertainty and unwritten tests are first-class planning information, not reasons to omit source ranges. A proposal is not a version-1 reviewed sidecar and cannot be imported with `scenario link`.

## Proposal artifact

```json
{
  "schemaVersion": 1,
  "kind": "proposed-scenario-association-map",
  "status": "model-proposed-unreviewed",
  "scenarios": [{
    "id": "project-roundtrip",
    "title": "Save and reopen a project",
    "featureId": "project",
    "state": "unwritten",
    "existingPaths": [],
    "plannedActions": ["Create a synthetic project", "Save", "Reopen"],
    "expectedOutcomes": ["The reopened project retains the exact title and contents."]
  }],
  "associations": [{
    "rangeId": "project-storage",
    "featureId": "project",
    "status": "model-proposed-unreviewed",
    "source": {"path": "src/project.mjs", "start": 12, "end": 19},
    "scenarioIds": ["project-roundtrip"],
    "rationale": "Project persistence supports a save and reopen contract.",
    "confidence": "medium",
    "uncertainty": "The test and exact assertion witness are not written yet.",
    "proposedAssertions": ["Compare the reopened title and contents with the original synthetic values."]
  }]
}
```

Coordinates are illustrative. Use actual source ranges. Each association has a unique range ID. Ranges partition source; put multiple relevant scenario IDs in one association rather than overlapping rows. Scenario IDs are unique, and all references must resolve. `plannedActions` and `expectedOutcomes` are nonempty descriptions, not executable argv or exact observed logs. Repeated planned actions retain their order. Existing test files do not establish assertion adequacy or execution.

Scenario state is `existing`, `needs-extension` or `unwritten`. Verify paths in `existingPaths`; leave it empty for unwritten scenarios. No assertion witness is required to propose. Associations always remain `model-proposed-unreviewed`; confidence is `low`, `medium` or `high`, and uncertainty is a string, empty only when there is no more specific uncertainty beyond proposal status. Use concrete proposed assertions for each range rather than a generic catch-all.

Additional provenance, inventory summaries and historical totals may be preserved in the artifact, but Tracer recomputes current progress from source, proposals and the current manual map. Saved totals and review/execution claims are never trusted as evidence.

## Prepare and show the complete map

```sh
tracer proposal prepare --file draft.json --json > docs/testing/proposed-scenario-map.json
tracer proposal check --file docs/testing/proposed-scenario-map.json --json
tracer proposal report --file docs/testing/proposed-scenario-map.json --json
tracer report --json
```

Create the destination directory first and never redirect onto the input file. These commands emit JSON and do not write files themselves, initialize an app, run any stored action, create manual links or change measured evidence. `prepare` fills missing hashes only. Supplied stale pins are rejected, never refreshed automatically. No app CLI configuration or test execution is required.

Each prepared source has three hashes:

- `fileSha256`: exact original full-file bytes, mandatory for current progress.
- `sha256`: exact selected snippet bytes, including line endings. New preparation adds this pin; legacy proposal artifacts without it remain readable.
- `spanSha256`: compatibility pin for the initial feature/proposal artifact, joining physical lines with LF and excluding the final line ending. CRLF line endings are normalized for this pin only. The mandatory exact full-file pin prevents normalization from concealing source changes.

Source files must be in the current Tracer inventory. Paths must remain repository-relative, regular and unsymlinked. Proposal files cannot be the reviewed sidecar or its working files. Changed source bytes make affected associations stale, including edits outside a selected span because the entire source file is pinned. Stale or overlapping associations contribute zero proposed lines. Malformed artifacts are reported as invalid. A successful integrity check is not semantic review.

`proposal report` includes the complete authored plan and independent current progress. Ordinary `report` automatically reads `docs/testing/proposed-scenario-map.json`; use `proposal report --file` for other paths. The included-line denominator follows the current manual mapping scope, blanks and declared comments. Duplicate, overlapping, stale or ignored ranges cannot inflate progress. A source selector clips proposal counts to the selected range. Action/sequence/witness selectors still select the existing manual-link scope; they do not search planned actions.

## Audit afterward, without automatic promotion

For the next concrete task, run `tracer next`. It defaults to this proposal and one scenario. The packet combines the proposed actions/outcomes, actual marginal witnessed-gap ranges and source snippets, and current same-file witness candidates. Witness snippets appear once even when several links reuse them. Exact proposal/map/source/witness hashes identify the snapshot; these pins are not execution evidence. The packet includes global integrity problems once and preserves ignored scope without dumping the source inventory.

Use `--file PROPOSAL` for another plan, `--limit 1..10` for a small disjoint batch, or `--scenario ID` to inspect one specific plan. A targeted selection requires limit one and recomputes its potential gaps independently of earlier output. Source previews show at most eight ranges per task, snippets show at most 20 lines/2 KiB, and reuse shows at most five candidate links. Plans/action sequences show a bounded prefix (12 items/4 KiB), with totals, truncation flags and a full-value hash when clipped. Full-contract audit commands and continuation coordinates remain explicit. A clipped sequence is not a complete trace. Same-file witnesses are candidates for inspection, never certified compatible assertions.

Follow the packet's workflow: inspect and extend a meaningful existing journey, run its actual advertised test argv through `tracer app --`, review the assertion-bearing catalog, integrate with `scenario link --reviewed` using fresh exact hashes, check, then run `tracer next` again. The packet gives real CLI commands and clearly marked required inputs for unknown test argv/catalog paths; it does not invent a test selector from a plan title or filename. Use `tracer actions` only when discovery is needed, after reviewing the configured app argv. Full contract audits remain available when a preview is insufficient. No separate proposal or audit record is required for every small edit; batch coherent work while honoring the project's review requirements. `no-witness-gaps` describes the current mapping minimum only; empty scope and unknown execution remain separate.

Choose a bounded next batch from the current witnessed mapping gaps:

```sh
tracer proposal prioritize --file docs/testing/proposed-scenario-map.json --limit 25 --json
```

This read-only command validates the entire proposal and manual map, then ranks scenarios by marginal unique included lines below the saved **witnessed** trace minimum. Action-only links do not fill witnessed gaps. Exact duplicate action sequences still count once; stale links contribute nothing. Blanks, current declared comments and ignored source stay outside the included denominator. Stale or overlapping proposals receive no target credit, while their diagnostics remain visible even with `--limit 1`.

The greedy selection chooses the scenario with the largest remaining gap-line count, breaking ties by scenario ID in code-point order. Shared association lines count only for the first selected scenario that targets them. It stops at the limit or when no scenario adds another unique gap line. `targetedGapLines` and `remainingGapLines` describe potential targets selected by this heuristic, not completed work, closed trace deficits or a minimum-size scenario set. In particular, a minimum above one may require multiple distinct witnessed traces on each target line. The command neither proves new trace distinctness nor changes any mapping or execution percentage.

`reuseOpportunities` groups eligible scenarios sharing an exact existing test path. These groups suggest where extending a coherent journey may reuse setup; they do not certify that the scenarios can be merged or that their assertions are adequate. Counts in these groups overlap and must not be summed as unique project lines. Inspect the full proposal and audit contracts before writing assertions or promoting links.

The default limit is 25, with a range of 1–1000. Ranking rows carry at most 25 association IDs and 10 existing paths; reuse groups carry at most 25 scenario IDs and there are at most `limit` groups. Explicit counts and truncation flags expose omitted detail. The proposal hash in `progress.proposed` identifies the full input for subsequent audit packets. Global proposal issues, invalid link/comment/dead-code records, ignored scope and inventory exclusions remain available in the output. `valid: false` exposes integrity problems without hiding unrelated candidates; malformed artifacts still fail. Output has a 64 MiB hard limit. No app, stored action, map write or measured import runs.

```sh
tracer proposal audit --file docs/testing/proposed-scenario-map.json --offset 0 --limit 25 --json
```

Audit packets show each selected association with current source text, relevant scenario plans, confidence and uncertainty. Follow `nextOffset` for the next batch. Offset is zero-based and limit is 1–1000 (default 25). Selection uses saved association order; keep the artifact hash fixed while processing offsets. An audit packet does not perform or certify an audit. It is read-only, and stale ranges have no current snippet rather than misleading text. Expanded packets have a 64 MiB limit; select a smaller batch if needed.

Review meaning and assertion quality after the full proposed map is available. Exact test witnesses may be added through the named-step catalog described in [scenarios.md](scenarios.md), but do not invent them to satisfy a planning percentage. Audit both source and witness, then use the explicit `scenario link --reviewed` command with exact catalog and map hashes. Neither proposal checks, audit packets, tests nor percentages automatically approve or promote a proposal. Existing manual `link` workflows remain available for explicitly reviewed relationships.

## Three distinct progress tracks

- `progress.proposed`: current included lines associated with unreviewed scenario plans, with denominator and percentage. Missing or malformed artifacts have unknown percentage, not 100%. Empty included scope also has a null percentage.
- `progress.reviewed`: current operator-declared manual-linked lines and the independent manual-scope percentage. This includes legacy manual links and is not a certification that Tracer performed semantic review. `withWitnessLines` is navigation evidence, not passed assertions.
- `progress.executed`: `not-derived-from-mapping`, with null lines, denominator and percentage. Unknown does not mean zero. Real scenario outcomes and `measure report` use separate evidence and potentially different denominators; this report does not manufacture one execution percentage by combining them.

Thus 100% proposed and 10% reviewed can coexist honestly with unknown execution. Run authorized real tests separately and report passed, failed, blocked and not-run outcomes on the correct build/platform/input route. Instrumented line hits remain distinct from passing assertions. Final implementation publication still requires the repository's checks; proposal completion itself does not require running the application.
