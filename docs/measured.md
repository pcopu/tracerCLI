# Measured LCOV intervals

Tracer's manual map and optional measurements answer different questions. Manual links express reviewed intent. A measured interval records which tool-reported line counters increased between two supplied LCOV exports. It does not run instrumentation, infer source-to-build relationships, or prove that an assertion passed.

## Capture and import

Use an authorized language/platform coverage adapter to collect cumulative snapshots before and after the actual action sequence in one process/run, without resetting counters or changing the build. Pin the exact source files used for that build before capture. Preserve the original exports and capture records separately; the dataset stores line counts and hashes, not the raw LCOV's function names or other private paths.

```sh
tracer measure import --before before.lcov --after after.lcov \
  --manifest interval.json --sources build-sources.json \
  --strip-prefix /capture/ --json
tracer measure report --source src/app.py:10-20 --json
tracer measure report --action 'app select --index 1' --json
tracer measure report --sequence '["app select --index 1","app select --index 0"]'
tracer measure check
```

Input paths are relative to the invoking working directory or absolute. They must be regular, unsymlinked UTF-8 files no larger than 64 MiB. `--root` selects the target Git root. `--map` affects manual links only, never measurement storage. Absolute LCOV `SF` roots require an exact explicit `--strip-prefix` ending in `/`; no basename guessing or automatic remapping occurs. All resulting paths must stay inside the repository, without traversal or symlinks.

## Manifest v1

`interval.json` has these required fields and an optional `actionLabels` array. Replace placeholder hashes with actual lowercase SHA-256 values; this illustrative JSON is not import-ready.

```json
{
  "version": 1,
  "runId": "recorded-run-identity",
  "actions": ["app select --index 1", "app select --index 0"],
  "counterMode": "cumulative",
  "counterReset": false,
  "sourceManifestSha256": "<SHA256 of exact build-sources.json bytes>",
  "probeSha256": "<SHA256 of actual capture probe source>",
  "tools": [
    {"name": "llvm-cov", "version": "actual recorded version", "sha256": "<tool binary SHA256>", "hashTiming": "capture"}
  ],
  "limitations": ["Polling and background work overlap this interval."],
  "before": {
    "sha256": "<before.lcov SHA256>",
    "runId": "recorded-run-identity",
    "buildSha256": "<instrumented executable SHA256>",
    "sourceManifestSha256": "<same exact source manifest SHA256>",
    "toolchainSha256": "<SHA256 of UTF-8 JSON.stringify(tools)>"
  },
  "after": {
    "sha256": "<after.lcov SHA256>",
    "runId": "recorded-run-identity",
    "buildSha256": "<same unchanged executable SHA256>",
    "sourceManifestSha256": "<same exact source manifest SHA256>",
    "toolchainSha256": "<same tool declaration SHA256>"
  }
}
```

A producer can also supply `actionLabels`, a nonempty array of unique exact
labels derived from the recorded interaction. For example, Scriv can bind
`scriv menu-action --scope script-entries` to an interval that contains a
completed menu command in its advertised Scripts entry scope. Labels work
with exact `--action` lookups. Sequence queries still use `actions`.

`actions` preserves exact order and repeated actions. These are supplied descriptions of the recorded sequence, never executable commands. One action selector returns its whole interval, not per-action attribution.

Tools require unique names and recorded versions. A hash obtained only afterward must use `hashTiming: "after-export"`. If unavailable, use `sha256: null` and `hashTiming: "unavailable"`. Never hash a version string and claim it is the executable. The toolchain hash binds the exact JSON tools declaration, including order and timing; it is not proof which binary ran. Likewise, the supplied run/build/probe identities are provenance declarations, not a cryptographic build attestation. Preserve evidence supporting them outside this minimal schema.

`build-sources.json` must contain `files: [{"path":"src/app.py","sha256":"<exact full-file SHA256>"}]`. Other top-level manifest fields are permitted and covered by its exact file hash. Paths are repository-relative and unique. Every LCOV source must appear in it; a complete build manifest may contain additional files. Use original capture/build-time hashes, never silently generate replacements from edited source.

## Strict compatibility and staleness

The importer checks both file hashes, same declared run/build/tool/source identities, no resets, identical source-file and instrumented-line sets, compatible LCOV TN test scopes and VER source versions, matching optional DA checksums, safe integer counts, nonnegative deltas and valid current source line bounds. Duplicate SF or DA records, duplicate/misplaced TN or VER metadata, malformed/unsupported records, missing pinned hashes, unsafe paths and partial exports are rejected before state is written. Each input supports at most 500,000 DA records. Writes are atomic and use an exclusive lock; an existing or stale lock needs inspection, not automatic deletion.

Only `DA` counters are imported. Function/branch data and `LF`/`LH` summaries are ignored, because exporters can report summaries with a different basis. The denominator is matched instrumented DA line records, not all physical project lines and not the summary's LF value. Zero deltas remain in the evidence but never count as observed. A counter increase is tool-specific, not necessarily the exact number of times a source line executed.

Import defaults to rejecting changed source bytes. To deliberately retain a historical capture against an edited checkout, add `--allow-stale`. This only permits a full-file hash mismatch in an otherwise regular repository source file. It never permits unsafe paths, missing files, invalid counters or absent capture-time hashes. Historical line bounds cannot be independently checked against edited bytes; keep the original source snapshot for that review. The importer validates line bounds whenever the pinned full-file hash matches. A changed file is stale as a whole, even if a particular numbered line still looks the same. Stale files keep historical counters but contribute zero current observed lines. A later source deletion is also reported stale. Reverting to exactly the pinned bytes makes the source current again; no measurement record is edited.

## Dataset and reports

Storage is separate at `docs/testing/code-e2e-measurements.json`, schema `{version:1, kind:"lcov-intervals", intervals:[...]}`. Each interval contains the supplied manifest, its original byte hash, explicit path prefix, per-file source hashes, sorted `[line,before,after]` rows, and a payload digest. Capture content identity is SHA256 over the JSON array of before-export hash, after-export hash and executable hash. New interval IDs are SHA256 over the JSON array `[captureContentId, runId]`, distinguishing an occurrence in one declared run from identical exports produced in another run.

Successful new imports write compact JSON with a final newline. The 64 MiB dataset limit applies to those exact UTF-8 bytes, including the newline; input files retain the same 64 MiB limit. Legacy pretty-printed datasets remain readable within that limit. Reports, checks and idempotent reimports preserve their bytes. A new interval compacts the dataset without changing existing IDs, payload digests, provenance or counter rows. Raw capture files stay unchanged, and manual sidecars retain their indented format.

Reimporting the same exact evidence in the same run is idempotent. Conflicting labels/provenance for the same capture content and run are rejected rather than inventing another interval, including changes to the original manifest bytes. Use distinct run IDs only for genuinely distinct captured runs, with matching IDs in the top-level manifest and both snapshots. Changing a declaration does not prove a second execution; preserve the supporting capture records separately. Multiple intervals with different export bytes in one run remain separate.

Legacy version-1 records whose IDs contain only capture content identity remain readable. Reimport returns the existing ID without changing the record, and a distinct run can be added alongside it. Duplicate occurrences are rejected even if one uses a legacy ID and the other a run-scoped ID. No automatic migration rewrites historical evidence. New run-scoped records require Tracer 0.1.2 or newer; older readers reject their IDs. A payload digest detects accidental edits, not malicious rewriting by someone who can recompute it.

Reports show each interval separately with its full manifest, source status, current observed ranges, unchanged instrumented ranges, historical increased ranges and exact tool counters. Totals distinguish historical instrumented/increased records from current instrumented/observed records. They do not sum overlapping intervals or combine build denominators. Missing instrumentation is unknown, not proof of nonexecution. `measure check` exits nonzero for stale files or invalid data. Normal `check`, `report` and `config --minimum-traces` continue to concern manual links only. The measured dataset and its working-file suffixes are always excluded from manual source inventory and test witnesses, even with custom extensions or a custom manual map.

Keep raw captures and private provenance out of public repositories unless sharing is explicitly authorized and sanitized. The importer performs no network requests or app execution, and `measure` commands never trigger automatic updates. It does not modify skills or agent instructions.

## Union compatible external captures

Run a read-only union across analysis roots that contain imported measurement datasets and their pinned source copies.

```sh
tracer measure union --input-root /analysis/first --input-root /analysis/second --json
tracer measure union --input-root /analysis/first --outcomes /analysis/outcomes.json --json
tracer measure union --input-root /analysis/first --input-root /analysis/second --scope source-lines --json
```

Each dataset passes the existing interval/payload validation and current source checks. The default `--scope strict` requires exact agreement on the source-manifest, probe, build and toolchain hashes, source file hashes and instrumented DA line sets. Incompatible scopes fail with their scope identities so they can be reported separately. A repeated capture occurrence counts once, including legacy capture-content IDs and modern run-scoped IDs for the same capture and run. The output preserves every stored alias under its canonical run-scoped ID. Conflicting content under an ID or occurrence fails. Empty input datasets cannot establish a union denominator.

`--scope source-lines` explicitly permits different build, source-manifest, probe and toolchain identities when every source path, full-source hash and instrumented DA line set agrees exactly. Every original identity group remains visible in `provenanceGroups`, with its interval IDs and origin indexes. This is a cross-provenance source-line presence union. It does not establish identical instrumentation adapters or builds, and it never sums counters across intervals. Changed source bytes or DA line sets fail in both modes.

The output contains `allObserved` and `passedOnlyKnown` totals, per-file observed ranges and gaps, the compatible `scope`, dataset origin hashes and per-journey marginal novelty. Both denominators describe the supplied instrumented line universe. Lines absent from that universe remain unknown. Repeated intervals and overlapping observations add no extra denominator or observed line.

Outcomes are optional producer declarations with digest-bound evidence. Their JSON format is

```json
{
  "version": 1,
  "intervals": [{
    "id": "64-character imported interval SHA-256 ID",
    "journey": "document-roundtrip",
    "status": "passed",
    "evidence": {
      "path": "document-roundtrip-evidence.json",
      "sha256": "64-character exact evidence-file SHA-256"
    }
  }]
}
```

Each outcome must reference a unique stored or canonical interval ID and use `passed` or `failed`. Unknown and duplicate declared IDs fail. Different aliases for one occurrence must agree on journey and outcome. Their evidence bindings remain visible while that occurrence contributes once. Input roots and the outcomes path resolve relative to the selected Tracer root. Evidence paths resolve relative to the outcomes file. Evidence must be a regular unsymlinked UTF-8 file within the existing 64 MiB input limit, with the supplied exact digest.

The union checks evidence bytes and records their provenance. It does not interpret producer-specific evidence or independently verify assertions. Native or service producers should derive declarations from their actual structured results and validate their own evidence contract. Missing declarations remain `unknown` and are excluded from `passedOnlyKnown`. Zero known-passing observations describes that declared subset, while the separate unknown outcome count remains visible.

Journey groups follow first encounter in input-root order and stored interval order. All intervals bearing that journey label are combined before its marginal novelty is computed against preceding groups. Undeclared journeys use their interval ID. Marginal novelty is order-dependent interval observation, with no per-action or assertion attribution. The command creates no dataset, lock, manual link or approval and executes no application.

## Look up current source before choosing another capture

A reusable external capture set holds the analysis roots, optional outcomes file and scope mode.

```json
{"version":1,"inputRoots":["first/analysis/source","second/analysis/source"],"outcomes":"outcomes.json","scope":"source-lines"}
```

Paths inside the capture set resolve relative to its directory. The file uses the existing regular, unsymlinked UTF-8 JSON input limit of 64 MiB. Its exact path and raw SHA256 appear in results. `inputRoots` is required, `outcomes` is optional, and omitted `scope` defaults to `strict`.

```sh
tracer measure where --capture-set /analysis/captures.json --source src/model.py:40-90
tracer measure where --capture-set /analysis/captures.json --source src/model.py --json
tracer measure where --capture-set /analysis/captures.json \
  --source src/model.py:40-90 --source src/storage.py:12-60 --json
tracer measure union --capture-set /analysis/captures.json --json
```

A capture set provides the roots, outcome path and scope together. Combining it with direct `--input-root`, `--outcomes` or `--scope` flags is an error. Existing direct union flags retain their behavior. Without a capture set, `where` reads only the selected root's conventional measurement dataset. An absent local dataset produces `unknown` query ranges.

`where` hashes the current requested file and checks exact requested bounds. It returns current `observedRanges`, `unobservedInstrumentedRanges` and `unknownRanges`. Unobserved instrumented ranges have usable current counter rows with no observed increase in the listed captures. Unknown ranges lack usable current instrumentation. Changed current source and stale snapshot files contribute historical evidence with original hashes and captured-source coordinates clipped to the requested bounds, while their current query ranges remain unknown. Historical coordinates are never relocated to guess current code identity. The source hash is rechecked before returning.

Repeat `--source` for up to 32 paths or ranges from the same capture set.
Tracer validates shared inputs once and emits the same per-range reports in the
requested order. A single selector keeps its original format. With multiple
selectors, JSON contains a `reports` array and plain output prints each range.
An invalid selector fails the whole command before output.

Each current hit identifies its canonical interval, stored aliases, exact observed overlap and recorded ordered actions. Journey and outcome labels come only from supplied producer declarations. Known-passing observed ranges are separate. Plain output groups hits by journey and declared outcome, with merged ranges and interval counts. JSON retains per-interval details and relevant evidence bindings.

Lookup validates dataset payloads and the requested file in each snapshot. Other snapshot files stay outside its stated `validationScope`, so an unrelated stale file does not gate this source question. Independent capture families retain their identities and the requested file's instrumented universe. Their full-universe hashes and provenance groups remain visible, with no unrelated file-by-file expansion. Overall query classifications express physical-line presence across these listed families. They establish no combined build coverage percentage, compatible-adapter proof or assertion adequacy.

`union --capture-set` still enforces the existing whole-scope compatibility and current-source checks. Both commands are read-only and reuse recorded captures without application execution, manual-link prerequisites or metadata repair.

## Rank gaps against a reference build

```sh
tracer measure gaps --capture-set /analysis/captures.json \
  --reference-root /analysis/latest/analysis/source --json
```

Choose an analysis root listed in the capture set, usually the latest captured build. A relative `--reference-root` resolves from the selected repository root. The reference dataset must be nonempty and internally compatible in strict mode. Its recorded files and DA lines fix the denominator, and its snapshot source must still match. This command reads the capture set once and ranks reference files by missing passing lines, with path as the tie breaker. The capture set's `scope` option still governs `union`; `gaps` always uses the explicit reference and per-file rules below.

A compatible interval must carry the same repository-relative file path, exact full-file source hash and exact DA line set as the reference. Its snapshot and the current checkout must also contain those source bytes. Compatible observations across independently recorded builds keep their original provenance. Current files with changed or unavailable bytes retain their reference lines in the denominator, earn zero current observation credit, and have those lines listed in `unavailableReferenceRanges`. Snapshots with source or instrumented universe conflicts are listed per file. Captured paths outside the reference appear in `outOfReferenceFiles`. The report makes no claim about repository components absent from its reference instrumentation.

`referencePassingObservedRanges` counts passing observations from the strict reference identity. `reusedPassingObservedRanges` lists the additional lines observed during passing intervals with other compatible file evidence. Remaining reference lines are classified as unavailable, observed only in known failed runs, observed with an unknown outcome, or unobserved instrumented lines. An unknown outcome takes precedence over a known failure when both observed the same line and no known passing interval did. `unknownInstrumentationRanges` uses current file coordinates, including the entire physical current file when its bytes differ from the reference. It is `null` when current source is unavailable. Use `measure where` for interval and journey details on a selected source range.

The concise output lists up to 20 files and directs readers to `--json` for the complete file list, range classifications, dataset provenance and digest-bound outcomes. The command neither executes a scenario nor changes a capture. It ranks measured gaps with a fixed scope; it cannot predict unexecuted routes, report whole-project coverage or prove branch or assertion coverage.

### Compare with an earlier capture set

```sh
tracer measure gaps --capture-set /analysis/current.json \
  --reference-root /analysis/latest/analysis/source \
  --baseline-capture-set /analysis/baseline.json --json
```

The reference root must be in the current capture set. The baseline may come from earlier builds. Tracer validates the prior dataset payloads, snapshots and digest-bound outcomes independently. Comparison requires all listed datasets and rejects conflicting payloads or outcome declarations for a shared capture occurrence. Each file is comparable only if the validated baseline has the same path, exact source bytes and DA line set as the reference and the current checkout still matches.

In `comparison`, `gainedLines` and `lostLines` are the set differences in known passing observations for comparable files. `passingLinesWithoutComparableBaseline` counts newly measured current files separately when baseline identity is missing or incompatible. A comparable interval with an unknown outcome provides instrumentation identity but no passing credit. `files` ranks changed paths by gains, then losses, then path and includes exact ranges for each category. `baseline` preserves origin hashes, producer identities and outcome bindings. Earlier source changes are not counted as comparable gains and unavailable current files remain visible in the primary gap report.

When a rebuild changed the reference denominator, add
`--baseline-reference-root /analysis/previous/analysis/source`. That root
must belong to the baseline capture set. Tracer validates each reference's
exact source and instrumentation independently. `comparison.referenceChange`
reports the two pinned denominators, the net line-count difference, and files
whose source or instrumentation changed. A scope decrease records the
reference change. The same evidence rules still govern passing gains and
losses on comparable files. The `measure batch` command accepts the same
option when appending new-build receipts.

Adding or dropping an outcome declaration can change gained or lost known-passing lines without a new execution. To measure a batch's contribution, keep the complete baseline captures and declarations frozen, then append only the new captures and their outcomes. Review losses for omitted captures or absent declarations. Pair comparable gains with verified producer elapsed wall time for the same batch. Keep build and preparation time explicit and do not sum jobs that ran in parallel.

### Compare several batches in one command

List the baseline first and the succeeding capture sets in execution order. Paths are relative to the series file and may also be absolute. A series accepts 2–32 capture sets and up to 256 distinct measurement input roots across them. Split larger sequences at a shared checkpoint.

```json
{
  "version": 1,
  "captureSets": ["baseline.json", "batch-one.json", "batch-two.json"]
}
```

```sh
tracer measure gaps --series /analysis/series.json \
  --reference-root /analysis/latest/analysis/source --json
```

Each stage compares with the preceding capture set. Keep the same reference root in every set after the baseline. JSON `reports` contains an ordinary gap comparison for each stage in input order. The default text output shows each stage's passing total, comparable gains and losses, and passing lines without a comparable baseline.

Shared manifests, dataset payloads, captured source snapshots, and producer evidence are read once during the invocation. Outcome declarations, compatibility checks, and current checkout source checks still apply to each comparison. A later command verifies the inputs again. The command is read-only and waits for every comparison to validate before printing reports.

## Measure a completed Scriv batch

Pass the `evidence.json` from a finished Scriv CLI run with imported coverage.
The output directory must be new and outside all source roots.

```sh
tracer measure batch --baseline-capture-set /external/baseline/captures.json \
  --receipt /external/run/evidence.json --reference-root /external/reference/source \
  --output /external/next-batch
```

Repeat `--receipt` to include several completed runs. Tracer binds each
measured interval to its import receipt and its declared scenario, group, and
outcome. It checks the run, build, probe, source and receipt digests before
publishing the derived capture set. Passing observations can earn passing
credit. Failed scenarios with completed imports retain their observations and
failed outcome. The receipt is producer evidence about the invocation.

The output contains `captures.json` and `outcomes.json` for subsequent
worklists or batches. `report.json` has the same format and contents as the
reference gap comparison against the baseline, including gained and lost line
ranges. `batch.json` summarizes the comparison and records each receipt's
elapsed time and digest. For a new destination, invalid input leaves the output absent.
