---
name: tracer
description: Maintain source-to-CLI-action-to-test links with Tracer, identify unmapped or stale code, and build or extend an application's CLI interaction surface for end-to-end testing within the user's requested scope. Use for declared trace mapping, CLI testability and optional separate LCOV interval evidence, never to infer execution from manual links.
---

# Tracer

## Establish the real surface

Use the application's existing repository and read its agent guidance. Discover `tracer --help` (or the installed repository's `bin/tracer.mjs`) and the app's actual CLI before inventing commands. Tracer requires Node.js 20+ and Git. Default mapping is `docs/testing/code-e2e-links.json`; preserve a project's chosen `--map` and any `--include-ext` settings. Keep unrelated work intact.

When the user requests full CLI coverage, audit supported application interactions, screens, state transitions, persistence and error/recovery paths. Create or extend the app CLI and its E2E tests to expose that complete authorized interaction surface, reusing real application handlers where appropriate. List unimplemented routes, platform constraints and deliberately restricted actions. An exposed command is not proof of UI or behavioral parity. Preserve authentication, safety checks, input-route semantics and user data. Additions to an app require that app's authorized work scope; a mapping-only request is not permission to modify a different project or bypass a restricted interaction.

## Initialize, discover and delegate explicitly

For an authorized new project setup, use `tracer init` to create missing config/map files without overwriting existing ones. If connecting an app, pass an exact executable argv array such as `--app-json '["node","cli/app.mjs"]'` and its verified discovery arguments with `--actions-json`. Do not assume every app supports `actions --json`; `--help` may be the only supported discovery route. Existing conflicting config needs review, not force replacement.

Inspect and trust `tracer.json` before `tracer actions` or `tracer app -- ...`: these commands execute the configured app. The latter forwards exact arguments and stdio without shell interpolation. App execution remains within the user's task authorization and the app's authentication/safety boundaries. Mapping, reports, checks and init never execute the stored action descriptions or app code. Discovery output is evidence of advertised commands, not proof they work or cover the whole UI.

Agent setup has separate consents. `tracer init --agent codex|claude --install-skill` authorizes installing a missing skill; `--add-instruction` separately authorizes a generic pointer in the appropriate project instruction file. Do not infer either permission merely from detecting an agent. Preserve existing customized skills and instructions, and ask when the agent is unsupported or ambiguous. A global skill installation is not guaranteed automatic discovery or hot reload; suggest explicit invocation or a new session when needed.

## Link behavior, not just text

Inspect the source and test snippets before writing a link. Choose small meaningful ranges and an exact test step with an assertion when available. Record literal app CLI actions in their real order, including repeated actions, meaningful input variants and required preconditions. These strings are never executed by Tracer.

```sh
tracer link src/cart.py:10-18 \
  --action 'cart add --sku demo --quantity 2' \
  --action 'cart total' \
  --step tests/cart.spec:20-30 \
  --why 'Add two items, then assert the calculated total.'
tracer report --source src/cart.py:12
tracer report --step tests/cart.spec:25
tracer check
```

Substitute actual paths, ranges and supported commands. Omit `--step` when no test witness exists; report that gap rather than inventing one. Do not put credentials, customer records or sensitive command arguments in maps.

## Maintain links with every relevant change

As part of authorized code/test work, update the map when code is added, changed, moved or deleted, and when CLI actions, test steps, assertions or prerequisites change. Reassess semantic changes even if hashes remain unchanged.

- Inspect existing links and run `tracer check` before editing when useful.
- For additions, create or extend the actual CLI journey and regression tests, then add reviewed links for the new behavior. Do not blanket-link a whole file to raise counts.
- For changed/moved snippets, inspect both ends, use `tracer unlink ID`, then link the corrected ranges. Never blindly refresh hashes or auto-guess moved ranges.
- For deletions, remove obsolete links and update affected journeys and assertions. Preserve unrelated records. Duplicate IDs or malformed sidecars require explicit repair, not a reset.
- After edits, run `tracer check` and a full `tracer report --json`; inspect newly unlinked and below-minimum lines, stale links, witness gaps and inventory exclusions. Run affected actual tests separately and report their results.

Commit related maps with code/tests when publication is authorized. Do not change the project minimum or expand source classification merely to make a check pass.

## Exercise the real CLI through journeys

When building CLI-driven E2E coverage, make tests interact with the application's actual CLI and observable state through meaningful workflows. If its project CLI exposes a test command, run it via `tracer app -- test` (or the real advertised command), and use `tracer actions` to inspect its supported routes. Do not equate direct calls to implementation APIs with verified CLI behavior.

Map reviewed source ranges to the actual CLI interaction sequence and exact journey assertions, not just a generic test-runner command. Preserve failure/recovery, cancellation, permission and data-integrity assertions. If the user asks to replace older tests, verify the CLI-driven replacements before removing the superseded suite; do not silently lose critical checks or delete unrelated tests. Fixture-only network simulation must remain outside production configuration.

## Count distinct traces honestly

`tracer config --minimum-traces N` saves a positive project minimum, default 1. Use the user's agreed minimum; ask or leave the default when the policy choice is unresolved. `report --minimum-traces N` is a read-only comparison. `check --require-minimum` optionally gates the full inventory against the saved minimum.

A per-line manual trace is **one exact ordered action sequence**, not one link row or one action. Overlapping links, copied IDs, repeated actions and alternate witnesses cannot manufacture additional traces. Two tests with identical action descriptions still count once. Represent meaningful different scenarios through their real inputs/preconditions. Do not vary spelling, aliases, ranges or explanations solely to inflate counts: Tracer cannot detect semantic equivalence between different strings.

Report the total declared manual traces and the subset with current test witnesses separately. Stale/invalid associations contribute zero. Action-only links are planning/navigation information, not test evidence. Every physical inventoried source line counts, including comments, blanks, tests and tooling; excluded/ignored files are outside the denominator. Read-only filtered reports describe the selected subset, not whole-project adequacy.

## Keep four conclusions separate

1. **Mapping:** which lines have current manual links and enough distinct declared sequences.
2. **CLI surface:** which app interactions have implemented commands and what remains inaccessible.
3. **Observed test results:** which commands/tests actually ran, on which build/platform and input route, and what passed or failed.
4. **Measured execution coverage:** only what a real coverage/instrumentation tool observed, with its scope and limitations.

Never call linked-line percentages measured coverage. Never claim full application coverage, native input parity, passing tests or completed migration from mapping counts alone. Even all lines meeting a minimum can coexist with no tests having run. Preserve explicit gaps and blockers in the final result.

## Import real measured intervals separately

When authorized instrumentation can export LCOV, capture cumulative before/after snapshots around the actual ordered sequence. Preserve the exact run ID, unchanged executable hash, probe hash, capture-time per-file source manifest, tool versions/hash timing, and export hashes. Do not fabricate build-time hashes from today's checkout. A tool hash retrieved after export must say `after-export`; an unavailable hash must remain null. Preserve background/polling overlap and non-atomic snapshot limitations.

Read `docs/measured.md` in the installed Tracer package (also in the official `pcopu/tracerCLI` GitHub repository) for the manifest schema. Use `tracer measure import --before FILE --after FILE --manifest FILE --sources FILE` with an explicit `--strip-prefix` if the exporter uses an absolute source root. Never guess paths by basename. Import writes only the separate measurement dataset, not manual links. It neither runs the app nor supplies an instrumentation adapter.

Use `tracer measure report --source PATH:RANGE`, `--action TEXT` or `--sequence JSON` to navigate the interval. An individual action lookup retains the whole sequence: it does not attribute shared/background execution to that action. Do not sum overlapping intervals or interpret tool counters as universal exact execution counts. Zero increments are not observed lines; absent instrumentation is unknown. Manual minimums remain unrelated.

After source changes, run `tracer measure check`; preserve stale history and exclude it from current observations. Default import rejects changed source. Only use explicit `--allow-stale` when retaining historical evidence with its original hashes, never to make changed code appear tested. Recapture authorized instrumentation to obtain fresh evidence. Supplied hashes establish integrity and staleness, not a cryptographic source-to-build attestation or proof of assertions.

## Updating the CLI and skill

Use `tracer update --status` for local state and an explicitly requested `tracer update --check` for official GitHub availability. Managed installs are separate from npm/Git checkouts; never overwrite a development checkout or bypass update integrity checks. Automatic update configuration is user consent, not implied by a mapping request. Honor `TRACER_NO_UPDATE=1`, CI and the user's chosen off/check/apply mode.

Tracer can refresh skills it installed and registered only while they still match the original checksum. Preserve modified or unregistered skills and merge reviewed changes only within authorization. Project instruction files remain generic pointers and are never rewritten by updates. Explain that new CLI code runs on the next invocation and agents may need a new session to load a refreshed skill; do not claim active agents hot-reload.
