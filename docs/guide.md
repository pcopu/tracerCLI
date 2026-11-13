# User guide

## Repository selection and CLI

`tracer [--root REPOSITORY] [--map PATH] [--include-ext .zig ...] COMMAND`

By default Tracer chooses the Git repository containing the current working directory, not its own installation. Explicit `--root` must name that repository's root, not a subdirectory. Paths are slash-separated, repository-relative paths. Global options go before the command. `tracer --help` and `tracer --version` need no repository.

- `init [--app-json JSON_ARGV] [--actions-json JSON_ARGV] [--minimum-traces N] [--agent codex|claude] [--install-skill] [--add-instruction]`
- `actions`
- `app -- ARGS...`
- `link SOURCE:START-END --action TEXT [--action TEXT ...] [--step TEST:START-END] --why TEXT`
- `report [--source PATH[:RANGE] | --action TEXT | --step PATH[:RANGE] | --sequence JSON_ARRAY] [--minimum-traces N] [--json]`
- `check [--require-minimum] [--minimum-traces N] [--suggest-moves] [--json]`
- `config [--minimum-traces N] [--json]`
- `unlink ID`
- `ignore PATH --why TEXT`
- `unignore EXACT_PATH`

Ranges are 1-based and inclusive, and `:N` means one line. Paths with spaces and colons work when quoted. Source and witness files must exist, be valid UTF-8, and stay inside the repository without symlinks. Witnesses may be any eligible text file, including Markdown, YAML, an extensionless script, or helper. Tracer does not infer whether a witness is actually a test or whether the selected step asserts the linked behavior.

Actions are exact nonempty single-line strings with no surrounding whitespace or control characters. Shell syntax, commas, colons and embedded spaces remain literal. Do not include credentials, personal data or sensitive arguments in tracked maps. One `--action 'first,second'` is not equivalent to two actions. Mapped action strings are never executed. Only the separate explicit `actions` and `app -- ...` commands run configured application code.

## Counts and evidence

A link is an association record. A distinct trace is the exact ordered action array, independent of link ID, source range, test range and explanation. For each source line, count each current trace at most once. Repeated actions within one sequence remain ordered steps of that one trace. Different test cases with identical action descriptions count once, a deliberately conservative rule. Represent meaningful input/precondition differences in actions rather than moving witness lines or changing an ID.

`count` is the number of distinct current manual traces at a line. `withStepCount` is the subset with at least one current test witness. A trace may have multiple witnesses; it still contributes one to each applicable count. The difference is the number of traces without a current witness. A stale witness invalidates that whole association; a separate current action-only association can still contribute one manual trace but no test witness. No count establishes a test passed, exercised a branch, or used physical rather than semantic input.

Tracer cannot determine whether two differently spelled commands are semantically equivalent. Humans and agents must review trace quality and avoid inflating counts with aliases or superficial variations. Hash equality also cannot detect a semantic change elsewhere in the application.

Project `minimumTraces` defaults to 1. `config --minimum-traces N` saves it in the sidecar. Thresholds accept positive safe integers, not fractions, exponent notation, zero or infinity. A report or threshold-enabled check may override it for that invocation. Normal `check` is link-integrity-only; threshold failure is opt-in via `--require-minimum`. Both are unrelated to actual test results.

All included nonblank inventoried physical source lines outside current declared comment ranges participate in the denominator, including unmarked comments, application tests and tooling. Whitespace-only lines (`line.trim() === ''`) are excluded automatically; agents can explicitly mark confirmed comment-only ranges with `tracer comment` and remove them with `tracer uncomment` (see [comment declarations](comments.md)); physical coordinates and hashes stay unchanged. See [blank-line counting](blank-lines.md). Empty files contribute zero lines; a final newline does not invent a line. This is intentionally not an executable-line or production-only denominator. Missing tracked source files and explicitly excluded sources are listed with reasons but do not participate. Git-ignored untracked files never appear.

Filtered reports show only the selected source scope or associations matching an action/sequence/witness. Their counts and threshold totals describe that filtered subset, not the entire repository or all traces that might exist for the same lines. `check --require-minimum` checks integrity across the full source inventory, but applies the minimum to included project mapping scope using the current global extension and sidecar options.

## Stale links and editing

Exact UTF-8 snippet hashes preserve CRLF, LF and BOM. Inserting lines before a range normally makes it stale; Tracer does not guess moved code. It never silently refreshes a hash or explanation. Repeating an identical link is a no-op, including old version-1 seed IDs. A duplicate identity with changed content fails. Review both snippets, remove the old link, and re-link current ranges. An unsupported sidecar version or malformed JSON fails closed.

`unlink` removes one exact ID without editing sources or tests. It can remove a stale or malformed entry with a unique ID. Duplicate IDs require explicit sidecar repair to avoid ambiguous removal. `check` diagnoses malformed records. `link` refuses to add records while structural/range errors remain, but unrelated stale hashes alone do not prevent a new association.

Mapping writes come from `link`, `unlink`, `comment`, `uncomment`, `ignore`, `unignore`, and setting `config`. Project setup and expressly approved agent integration can also create/update their own files. They use an exclusive `.lock` sidecar, write a temporary file and atomically replace the map. Read-only commands do not create directories. A lock left by a killed process requires checking that no writer is active before manually removing it. Never delete a live writer's lock. Atomic rename protects against partial JSON, not hardware failure durability; no fsync guarantee is made. This tool is not a security sandbox against simultaneous filesystem replacement.

## Inventory boundary

Project-level [mapping ignores](ignores.md) place explicit files/directories outside manual totals and minimum thresholds. `report` retains their navigation records in `ignoredFiles` and counts in `ignoredTotals`, with global rules and reasons visible in `ignoredSources`. `check` still validates ignored source and witness links. These rules do not disable tests or change measured evidence. Use `tracer ignore PATH --why TEXT` and restore with `tracer unignore EXACT_PATH`; directory rules end in `/` and no globs are supported.

Inventory comes from `git ls-files --cached --others --exclude-standard -z`, sorted and deduplicated. Working-tree bytes are read. Tracked files remain eligible even if a new Git ignore rule matches them.

Source extensions (case-insensitive): `.swift`, `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.m`, `.mm`, `.h`, `.hpp`, `.hxx`, `.c`, `.cc`, `.cpp`, `.cxx`, `.py`, `.sh`, `.bash`, `.zsh`, `.sql`, `.css`, `.scss`, `.sass`, `.html`, `.htm`, `.vue`, `.svelte`, `.rs`, `.go`, `.java`, `.kt`, `.kts`, `.rb`, `.php`, `.cs`, `.ps1`, `.lua`, `.metal`, `.proto`. Exact names `Makefile`, `Dockerfile`, `CMakeLists.txt`, `Gemfile`, `Rakefile` also count. Add extensions per invocation with repeatable `--include-ext .ext`. Use the same extension options for mapping and checking; they are not saved by `config`.

Configuration sources: `.yaml`, `.yml`, `.json`, `.jsonc`, `.toml`, `.ini`, `.xml`, `.tf`, `.tfvars` count beneath top-level `src/`, `app/`, `apps/`, `lib/`, `config/`, `configs/`, `cloud/`, `cli/` or `.github/`, except beneath `docs`, `test`, `tests`, `__tests__`, `fixtures`, `test-data` or `artifacts` components. Root-level config is limited to `package.json`, `pyproject.toml`, `Cargo.toml`, `composer.json`, `deno.json`, `deno.jsonc`, `biome.json`, `biome.jsonc`, `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, `compose.yaml`, `wrangler.toml`, `wrangler.json`, `wrangler.jsonc`, and `tsconfig.json`/`tsconfig.*.json`. Configuration filenames with a dot/hyphen-separated `lock` token are excluded. Explicitly adding a configuration extension via `--include-ext` deliberately expands this boundary to that extension everywhere eligible.

Excluded directory components: `.git`, `node_modules`, `.build`, `.swiftpm`, `.wrangler`, `build`, `dist`, `coverage`, `target`, `Pods`, `Carthage`, `vendor`, `vendors`, `third_party`, `generated`, `__generated__`, `DerivedData`, `test-results`, `playwright-report`, `__pycache__`. Filenames containing `.generated.` or `_generated.` are excluded case-insensitively. The chosen sidecar and its dot-suffixed working files are excluded. These rules apply to witnesses too. Unmarked generated code is included rather than guessed away.

Symlinks, dangling symlinks, files behind symlinked directories, missing tracked files and nonregular files are excluded. Invalid UTF-8 and NUL-containing sources fail the command instead of silently shrinking the denominator. Control characters and traversal components in file names are rejected. Submodule contents are not recursively inventoried.

## Exit codes and integration

Exit 0 means the requested operation completed. `report` remains informational even when it lists invalid links or below-minimum lines. `check` exits 1 for stale/invalid links or comment declarations; with `--require-minimum`, it also exits 1 when any included nonblank inventoried line is below the minimum. Usage, Git, file and sidecar errors exit 1 and print `tracer: ...` on stderr. `--json` emits one JSON object on stdout for a successfully constructed report/check/config, including failed integrity or threshold checks. Fatal errors are stderr text, not JSON.

No test runner or CI is installed. You may add `tracer check` to your own existing validation workflow, and opt into a threshold only after agreeing on the inventory and meaningful trace conventions. Running actual tests, native builds and coverage instrumentation remains a separate operation.

## Project setup and app delegation

An application CLI is the command interface that lets agents and tests operate the app. Start execution coverage from existing supported CLI routes and capture adapters. Inspect missing features and extend their CLI routes within authorization while independent supported scenarios proceed. Tracer explains this during setup; it does not build an application CLI automatically.

`tracer init` creates absent `tracer.json` and map files without running the app. Existing valid files remain byte-for-byte unchanged, including custom fields and links. Supplied app/discovery/minimum settings must match existing settings or init fails. It never has a force-overwrite mode. To change an existing app connection, inspect and edit `tracer.json` explicitly. To change a minimum, use `tracer config --minimum-traces N`.

When no `app` arguments are configured, setup says no CLI is connected, not that the repository has no CLI. Inspect the repository first. If a CLI exists, review its executable and discovery arguments; if not, explain that one must be built and obtain any missing authorization. After a mapping-only init, explicitly review/edit the preserved `tracer.json` to connect it. For a new configuration, use `init --app-json`. Configured apps are described as unexecuted and unverified: setup does not run discovery or claim feature parity.

Keep CLI commands, discovery/help, behavior, E2E journeys and related mappings current as app features are added, changed or removed. Preserve consent, authentication and safety checks. Restricted routes, missing permissions and platform limits are explicit gaps, never reasons to bypass safeguards or claim complete coverage. Independent read-only diagnostics may continue while changes are blocked. These are instructions to the user/agent, not an automatic app-code generator or a verified feature audit.

Project configuration:

```json
{
  "version": 1,
  "app": ["node", "cli/app.mjs"],
  "actions": ["actions", "--json"]
}
```

`app` is an executable plus zero or more fixed arguments, not a shell command string. `actions` is optional discovery arguments appended to it. With no configured discovery, `tracer actions` appends `--help`. Configure only arguments the app actually supports. Discovery failure is returned as-is, without guessing or retrying a different command. App stdout remains untouched, including JSON output. No standard action JSON schema is imposed.

`tracer app -- ARGS...` appends exact arguments to the configured app. Empty arguments, shell metacharacters and spaces remain literal; no interpolation occurs. The child inherits stdio, runs from the repository root, and its exit code or signal becomes the wrapper's result. SIGINT/SIGTERM sent only to the wrapper are forwarded to the owned child and Tracer waits for it to finish; a second cancellation escalates that child to SIGKILL. The app remains responsible for its own helper lifecycle. Tracer is not a process sandbox.

Treat project argv configuration as executable code. Review it before discovery/forwarding in an unfamiliar repository. `init`, `link`, `unlink`, `report`, `check` and minimum `config` do not execute the app or load its configuration as code. A configured CLI does not grant account access, bypass app authentication or authorize purchases, communication, deletion or other consequential work. A CLI route also does not establish native mouse/keyboard/UI parity.

## Consent-based agent setup

After initializing project files, an interactive `tracer init` can guide agent setup. It detects existing Codex/Claude configuration directories, asks the user when ambiguous or absent, and treats unsupported agents as a reason to stop agent setup. Directory detection is only a hint; it does not query or gain access to an agent.

A missing skill is installed only after its own affirmative prompt or `--install-skill`. Appending a generic project pointer is a separate prompt or `--add-instruction`. Noninteractive invocations never answer prompts automatically. Use `--agent codex` or `--agent claude` to choose explicitly. No other agent is inferred. Skill installation without instruction consent leaves all project instruction files unchanged.

Codex uses `${CODEX_HOME:-$HOME/.codex}/skills/tracer/SKILL.md` and repository `AGENTS.md`. Claude uses `~/.claude/skills/tracer/SKILL.md` and repository `CLAUDE.md`. Existing skills are preserved, including customized contents. An existing incomplete skill directory is a blocker rather than an excuse to overwrite it. Instruction appends preserve preceding bytes and newline convention, and a marker prevents duplicate additions. Symlinked destinations or parents are rejected. No global permissions or security settings are changed.

The project instruction is only a short pointer to the installed skill and CLI; the workflow lives in the versioned skill. Skill discovery is agent-dependent. A new agent session or restart may be needed, and active agents are not guaranteed to hot-reload changed skill files.

## Actual instrumented observations

Before proposing a new test for a source range or claiming code is already covered, look up existing captures. Query a range with `measure where`, or summarize the capture scope with `measure union`.

```sh
tracer measure where --capture-set /analysis/captures.json --source src/model.swift:40-90
tracer measure union --capture-set /analysis/captures.json --json
```

The default source lookup is concise plaintext grouped by journey/outcome, merged ranges and interval count. Add `--json` for detailed programmatic inspection. Keep detailed interval/actions JSON in external artifacts and report the relevant summary.

A reusable external capture set avoids rebuilding a long list of input-root arguments.

```json
{"version":1,"inputRoots":["first/source","second/source"],"outcomes":"outcomes.json","scope":"source-lines"}
```

Paths inside the spec resolve relative to its directory. Outcomes are optional producer declarations with digest-bound evidence. Scope retains the existing strict/source-lines rules. Union also accepts direct repeatable `--input-root` arguments. Without a capture set, `tracer measure where --source PATH:START-END` checks the selected root's conventional measurement dataset, returning unknown ranges when usable instrumentation is absent. Keep capture-set selection separate from direct roots/outcomes/scope flags.

Reuse observed intervals and their bound scenarios first. Choose supported routes or focused variants for unobserved instrumented ranges. Missing captures, uninstrumented lines and stale source remain unknown for current coverage. Preserve historical evidence and separate provenance groups. A line hit establishes counter presence during an interval, with passing status and assertion adequacy reported independently. This lookup requires no manual map, semantic audit or application launch and provides no forced production-branch execution.

Capture new observations through the application's supported instrumentation adapter, then use `tracer measure import`, `report`, `check` and `union` for provenance-bound LCOV evidence. These operations leave manual trace counts separate. See [measured evidence](measured.md).


## Inspect exact moved-range candidates

`tracer check --suggest-moves --json` adds read-only `moveSuggestions` for stale manual-link source and witness references. It searches the same eligible file for the stored exact snippet hash at the original physical range length, preserving CRLF, Unicode, BOM and final-newline bytes. Original integrity findings and exit codes remain unchanged. Each candidate needs independent semantic review before an explicit unlink/relink repair.

Statuses distinguish a complete `unique` match, complete `ambiguous` matches, complete `no-match`, an `unavailable` reference or file, and an `incomplete` budget-limited scan. Partial scans expose unknown `matchCount` and lower-bound `matchesFound`. Repeated references share one file-and-range-length scan. Missing or renamed files remain unavailable in this same-file search.

The additive output contains the exact map hash, current file hashes, work counters and limits. It returns at most 1000 references and five coordinates per reference, with explicit omitted counts and candidate truncation. Shared scan work stops at 250000 windows or 128 MiB of hashed window bytes. Every partial group remains incomplete. Comment and retained-dead-code declarations retain their existing integrity checks, while move suggestions cover manual-link source and witness ranges.
