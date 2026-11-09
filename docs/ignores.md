# Project mapping scope

Tracer 0.3.0 can exclude explicitly chosen scenario or test-only support files from an application's **manual mapping denominator**. This does not skip their tests, remove their links, stop validating their bytes, or change measured LCOV evidence. It is a project scope choice, not proof that ignored code is covered.

```sh
tracer ignore tests/ --why 'Scenario journeys and test-only fixtures are outside the application mapping scope.'
tracer ignore support/test-helper.mjs --why 'Test-only support, not application runtime.'
tracer report --json
tracer report --source tests/scenario.mjs
tracer check --require-minimum
tracer unignore tests/
```

## Explicit, reversible paths

An ignore target must exist when added and be a regular, unsymlinked repository file or directory. Directory targets are stored with a trailing slash, even when the input omits it. Paths are exact and case-sensitive; there are no globs. `tests/` includes descendants but not `tests-extra/`, and a file rule matches only that file. Absolute paths, traversal, repository-root targets, `.git`, glob characters (`*`, `?`, `[` and `]`), symlinks and nonregular targets are rejected. Paths never execute as commands.

Every rule needs a nonempty single-line `--why`. Repeating the same canonical path and reason leaves the sidecar byte-for-byte unchanged. A changed reason requires explicit removal and re-addition. `unignore` takes the exact saved path, including a directory's trailing slash, and works even if the target has since disappeared. Overlapping file/directory rules exclude each file once; removing one rule does not undo another matching rule.

Rules live in the existing version-1 sidecar as an optional `ignoredSources` array of `{ "path": "tests/", "why": "..." }` records. Existing links, comments and unrelated fields are preserved. Missing targets are retained as rules with zero matching source files rather than silently removed. Malformed rules and duplicate exact paths fail closed and need deliberate repair; Tracer never resets the map to recover.

## Reports and integrity

`report.files` and `report.totals` describe only included source files. `ignoredFiles` contains selected ignored files with their original counts, links, comments, physical `traceCounts`, and an `ignoredBy` list of matching rule paths. `ignoredTotals` uses the same fields as `totals`, but is separate and does not participate in a minimum gate. Both totals retain the blank/comment line rules. A source lookup of an ignored file succeeds in `ignoredFiles`; it is not an empty or missing-source result.

`ignoredSources` always lists the global rules, reasons and `matchedFiles` counts across the current source inventory. File totals are selector-specific, while those rule counts remain global. Text output labels ignored files and totals explicitly. Zero included files or a passing minimum is never described as full execution coverage.

Both ordinary `check` and `check --require-minimum` inspect every stored link and comment declaration, including ignored sources and ignored test witnesses. Stale hashes, malformed records and missing source/witness files still fail checks and remain globally visible under filtered reports. Ignoring cannot hide invalid UTF-8 or unsafe files. Ignored files remain eligible for source links and test witnesses. Minimum checking uses only included counts and additionally reports `ignoredTotals`.

Built-in dependency/build/generated exclusions and Git inventory rules still apply before project scope. These rules do not add otherwise ineligible files to the inventory. No tests, application configuration, source bytes or measurement history are modified by ignore/unignore. Run the actual CLI tests as before.

## Agent responsibilities and compatibility

Inspect files before choosing scope. Ignore scenario or support code only when it is genuinely outside the agreed application mapping scope. Do not ignore application runtime, CLI behavior, security checks or hard-to-test code merely to improve the denominator. Record the reason and report both included and ignored scope, real test results and remaining gaps.

Tracer's own map ignores `tests/`, including journey scenarios and test-only fixture helpers. Its `src/`, `bin/tracer.mjs`, `scripts/project-cli.mjs` and package configuration remain included. Its self-hosted `tracer app -- test` still runs all journeys.

Use Tracer 0.3.0 or newer to honor these rules. Older clients can still read the version-1 links but do not understand the new scope field. A shared installation update applies to every project using it; no per-project version pin is introduced. Rules are project-specific and do not automatically ignore similarly named paths in other projects.
