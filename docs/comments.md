# Agent-marked comments

Tracer does not parse comment syntax. An agent or person who has inspected the source can explicitly declare comment-only physical lines:

```sh
tracer comment src/example.swift:10-15
tracer report --source src/example.swift:10-20 --json
tracer check --require-minimum
tracer uncomment COMMENT_ID
```

No extra audit, rationale or approval workflow is required. These are **declarations**, not verified language semantics, executable-line classifications or execution evidence. A mark can be wrong. The CLI makes that limitation explicit; it cannot guarantee that an agent classified the source honestly.

## Rules for agents

- Read every line being marked and enough surrounding language context to establish that it is entirely a comment.
- Never mark executable code, declarations, mixed code/comment lines, strings, docstrings, templates or uncertain text merely to improve a percentage or satisfy a minimum.
- Leave uncertain lines counted. A failing minimum is preferable to a false comment declaration.
- Do not blanket-mark files or use comment-looking prefixes without checking literal/multiline context. A whole-file mark is appropriate only when every nonblank line is genuinely a comment.
- Blank physical lines are already excluded automatically. There is no need to mark them, and overlap never earns additional exclusions.
- After source edits, inspect stale marks, remove the affected ID with `uncomment`, and mark the reviewed range again. Never mass-refresh hashes just to make a gate pass.

## Storage and staleness

The existing version-1 link sidecar gains an optional `commentExclusions` array. Each entry contains an `id`, a byte-exact `source` range (`path`, `start`, `end`, `sha256`), and `fileSha256` for the entire original source file. Existing links and unrelated fields are preserved. There is no new sidecar or parser dependency.

The full-file hash prevents a declaration from silently surviving a surrounding edit that changes its meaning, even if its own snippet bytes did not change. Any edit to that source file conservatively makes its marks stale. Source/line identity, UTF-8/BOM/CRLF bytes and existing link hashes are never rewritten. Repeating an unchanged mark is byte-idempotent; repeating a stale mark fails rather than refreshing it.

Stale, malformed, duplicate-ID or out-of-inventory marks are reported globally in `invalidComments`, even for a narrow lookup. They contribute zero exclusions, so their lines remain counted. Both ordinary integrity checks and minimum checks fail for invalid comment declarations. Remove a known ID explicitly to recover; malformed/duplicate identities require deliberate sidecar repair.

## Counts and compatibility

Manual reports use `lineBasis: "nonblank-undeclared-comment-lines"`. Each file and totals expose `physicalLines`, `blankLines` and `commentLines`. `commentLines` counts only nonblank lines in current declared ranges. The invariant is `lines + blankLines + commentLines === physicalLines`; overlapping declarations form a union, never a multiplied discount.

Files expose current original `comments` records and effective `commentRanges`, alongside `blankRanges`. Original `links` and `traceCounts` remain physical and navigable, even inside an excluded comment. Existing `linked`, `withStep`, `unlinked`, `belowMinimum` and their ranges count only included lines. Comment declarations apply consistently across source/action/sequence/witness filters; filtered totals still describe only the selected scope.

Checks add `commentTotal`, `commentValid` and `invalidComments`. A valid hash proves only that declared bytes/context are unchanged, not that they are comments. Older Tracer versions can preserve this v1 extension but do not apply its exclusions; update the shared installation to use the same behavior across projects. There is no per-project version pin.

Measured LCOV remains separate. Comment marks and automatic blank exclusion never drop instrumented `DA` records, alter captured counters or rewrite interval history.

Project [mapping ignores](ignores.md) are independent of comment declarations. Ignoring a file moves its complete record to separate ignored scope; it never suppresses stale or malformed comment diagnostics or changes measured evidence.
