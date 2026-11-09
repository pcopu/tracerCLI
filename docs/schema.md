# Data formats

## Sidecar v1

Default path: `docs/testing/code-e2e-links.json`. Old maps with `version: 1`, a `links` array and no `minimumTraces` remain supported; their minimum is 1.

```json
{
  "version": 1,
  "minimumTraces": 2,
  "links": [
    {
      "id": "human-readable-id-or-hash",
      "source": {"path": "src/cart.py", "start": 10, "end": 18, "sha256": "<64 lowercase hex characters>"},
      "actions": ["cart add --sku demo --quantity 2", "cart total"],
      "step": {"path": "tests/cart.spec", "start": 20, "end": 30, "sha256": "<64 lowercase hex characters>"},
      "why": "Add two items, then assert the calculated total."
    }
  ]
}
```

`step` is optional; it is not `null`. IDs must be unique nonempty letters, digits, underscores or hyphens. New IDs use the first 16 hex characters of a SHA-256 over the source location, ordered action array and optional step location encoded as an unambiguous JSON array. Existing seed IDs are preserved. This ID identifies an association, not a distinct trace. Distinct per-line trace identity is `JSON.stringify(actions)`.

Ranges are 1-based inclusive safe integers within current files. SHA-256 hashes cover exact snippet bytes, including line endings and UTF-8 BOM. Unrecognized top-level/link fields are preserved when unrelated records change, but no unknown field is treated as execution evidence. `minimumTraces` is a positive safe integer.

## JSON report

`tracer report --json` returns:

- `kind: "manual-links"`, an explicit `notice`, `minimumTraces`, `traceIdentity: "exact-ordered-action-sequence"`, and the optional `query`.
- `totals`: `files`, `lines`, `linked`, `withStep`, `unlinked`, `belowMinimum`. These are source-line counts, not the sum of all traces.
- `files`: per-file source scope, the same line counts, `linkedRanges`, `unlinkedRanges`, `belowMinimumRanges`, current matching `links`, and `traceCounts`.
- `traceCounts`: adjacent lines with equal counts compressed into `{start, end, count, withStepCount}`. Expand each inclusive range for an individual line's count.
- `invalid`: `{link, errors}` records. Invalid records never contribute to trace counts.
- `excluded`: `{path, reason}` for source candidates excluded by explicit rules.

Ranges such as `linkedRanges` are arrays of `[start, end]`, even for one line. Empty files have `start: 1`, `end: 0`, zero counts and empty range arrays.

`tracer check --json` returns `kind: "manual-link-integrity"`, `notice`, `total`, `valid` and `invalid`. Threshold-enabled checks also include `minimumTraces` and `belowMinimum`. Exit status, not JSON presence, determines success.

## JavaScript API

```js
import { Tracer } from '@pcopu/tracercli';
const tracer = new Tracer({ root: '/path/to/repository' });
const report = tracer.report({ kind: 'source', value: 'src/cart.py:12' });
const integrity = tracer.check();
```

Constructor options: `root`, `map`, `extensions`. Methods: `report(query?, {minimumTraces}?)`, `check({requireMinimum, minimumTraces}?)`, `config(minimumTraces?)`, `link({source, actions, step?, why})`, `unlink(id)`, `inventory()`, `readMap()`. Source/step inputs to `link` use `path:range` strings. Methods throw on fatal errors; check returns invalid records without throwing for individual broken links. Imports do not inspect files or execute CLI entrypoints.

## Project app configuration

`tracer.json` is separate from the link sidecar. `version` must be 1. Optional `app` is a nonempty argv array of strings, starting with an executable; optional `actions` is a nonempty discovery argv array and requires `app`. Empty non-executable arguments are retained; control characters are rejected. Unknown fields are preserved but not executed. This file is read only by init and explicit app/discovery commands, not by mapping reports/checks. The map cannot occupy `tracer.json`.

## Separate measured evidence

Optional `tracer measure` uses its own version-1 interval dataset, never manual sidecar fields. See [the LCOV manifest and dataset schema](measured.md).
