# Reading Tracer's own journey map

Run the suite through the actual project connection:

```sh
node bin/tracer.mjs actions
node bin/tracer.mjs app -- test
node bin/tracer.mjs check
```

The map at `docs/testing/code-e2e-links.json` records reviewed implementation ranges, meaningful CLI interaction subsequences and exact assertion ranges. It does not map whole files only to the test runner, measure execution coverage, or claim that every branch in a linked range ran. Reports keep physical trace information visible, including blank lines, while manual totals count nonblank lines. Unmarked comments remain counted; current explicit comment declarations are separately excluded.

## Descriptor conventions

A map action beginning `tracer` abbreviates the fixture's actual launcher and repository selection. This is usually the current Node executable plus the repository's `bin/tracer.mjs`, with either `--root` or the fixture's working directory selecting the disposable Git repository. Update journeys also invoke the newly installed managed launcher; global status/version requests need no repository. The linked harness determines the exact prefix. Most assertions invoke argv arrays directly rather than a shell. The labels use ordinary shell quoting only to make the literal arguments readable. Shell metacharacters inside forwarded test arguments are quoted literally.

The optional terminal-consent journeys use Linux's util-linux `script` utility to give the unchanged CLI real stdin/stdout terminals. The harness shell-quotes its fixed launcher arguments and sends each answer only after observing the corresponding prompt. These journeys explicitly skip on other platforms or when that utility is unavailable; ordinary Node/Git journeys still run. A Linux terminal result does not establish macOS or Windows terminal behavior. Ordered `stdin (TTY): "..."` action records describe the exact JSON-escaped terminal input after the preceding CLI command; they are not CLI flags or automatically replayed commands.

Runner journeys connect the public Tracer CLI to an unchanged copy of the shipped project runner and synthetic Node test files. They assert named/all journey selection, failure exits and owned-process cleanup after cancellation without recursively launching the repository's full suite. The signal-cleanup journey skips Windows; it does not claim repeated-signal escalation or graceful execution of a cancelled test worker's own signal handlers.

The packaged-install journey runs offline npm pack/install with lifecycle scripts, audit and funding disabled, using isolated directories. It verifies the real installed aliases, packaged runtime/skill/documentation files and manifest, then drives mapping and separately consented agent setup. Manifest script declarations are checked as metadata; repository-only scripts/tests are deliberately not installed. That journey skips Windows.

The concurrent-init journey uses a loopback-only Node inspector breakpoint to schedule a real second writer immediately before exclusive config creation. It neither patches filesystem functions nor invokes production APIs. Exact config and map bytes survive the refusal, then a reviewed retry succeeds. The race journey skips runtimes without global WebSocket; the directory-permission recovery journey skips Windows and root, where its POSIX denial would not apply.

## What complete manual mapping means

Imports, declarations, comments and closing boundaries remain in the included nonblank inventory. Their small reviewed links name the related real CLI scenario, not a claim that every branch executed. In particular, a successful agent setup evaluates its valid-input guard but does not reach the invalid helper-input branch preempted by CLI validation. The self-host runner registers a spawn-error callback, but the ordinary named/all dispatch scenario does not claim that callback fired.

A map with every included line linked and a passing complete CLI suite establishes reviewed navigation plus those observed assertions on that runtime. It is not measured statement/branch coverage, all-platform acceptance, or proof that every failure path ran. This repository does not import its synthetic LCOV fixture counters as measurements of Tracer itself. Keep platform skips, defensive branches and any future measured execution report separate.

Fixture-specific values are deliberately named instead of committing temporary paths or generated IDs:

- `$PACKS`, `$CACHE`, `$PREFIX` and `$TARBALL`: isolated package output, npm cache, install prefix and the local packed archive. Package operations are offline with lifecycle scripts disabled.
- `$FULL_SHA`: the synthetic full lowercase commit string used only to assert rejection of a conflicting refresh pin.
- `$APP_ARGV`: the JSON array of the current Node executable and `app.mjs` supplied by the project fixture.
- `$LINK_ID`: the actual generated or preserved ID read from that fixture's sidecar.
- `$COMMENT_ID`: the actual comment declaration ID read from that fixture's sidecar.
- `$ORDERED_ACTIONS`: the exact JSON action array constructed in the linked journey, including repetitions.
- `$REVIEWED_SHA`: the full immutable commit generated by the synthetic GitHub fixture.
- `$TRACER_PID`: the owned wrapper process in the cancellation fixture. The test injects the documented signal through the process API, equivalent to the displayed `kill` command.

The linked test range supplies the fixture preparation and expected result. Labels may show a meaningful subsequence rather than every intervening report or filesystem mutation. They must still preserve the actual action arguments: omitting a default action, substituting different source ranges, or changing `--add-instruction` into `--install-skill` would describe a different test.

Map strings never execute automatically. Run the named journey through `tracer app -- test mapping`, `comments`, `ignore`, `measured`, `project`, `update`, `scenarios`, or `self-host`; do not treat placeholder labels as a replay script. When reviewing changed behavior, inspect both source and witness before using `tracer unlink` and `tracer link`. Passing link integrity proves only that those reviewed snippets still match, while the E2E runner's result reports the observed test outcome separately.

The `scenarios` group includes reusable-step compiler and callback-adapter journeys plus proposal planning. Proposal preparation, integrity checks and bounded audit packets are read-only planning operations. Their fixture assertions establish the checked contracts, not semantic approval of an arbitrary proposed map. Proposed associations, reviewed manual links and actual execution remain independent.
