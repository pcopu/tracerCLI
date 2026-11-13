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

`interval.json` has exactly these fields. Replace placeholder hashes with actual lowercase SHA-256 values; this illustrative JSON is not import-ready.

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
