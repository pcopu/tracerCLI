# Tracer CLI

Use Node.js 20+ and Git. No runtime dependencies, language parsers or telemetry. Mapping never executes app code. Only explicit app/discovery commands run reviewed argv, without a shell; any update network activity must be opt-in and integrity-verified. Run `npm run check` before publication and exercise a packaged install when changing packaging.

Tracer records human-authored links, not execution evidence. Never describe linked-line counts as coverage, passing tests or proof that a path ran. Preserve ordered action strings exactly, including repeats. Hash exact text bytes. Do not silently repair stale links or guess relocated ranges.

Keep the version-1 sidecar compatible with `docs/testing/code-e2e-links.json` from the original prototype. Tests must drive the public CLI through interaction-based E2E journeys, using isolated temporary Git repositories and synthetic data. Run them through this repository’s own Tracer app connection (`node bin/tracer.mjs app -- test`). Do not substitute production API calls for CLI interaction or link whole files only to the runner. Do not add private application data, credentials or diagnostic outputs. The README GIF is an illustrative animation, not a recording of observed execution.

Agent skill installation and project instruction insertion require separate affirmative consent. Never overwrite customized skills or existing project instructions. Preserve stdio, exit status and cancellation when forwarding to an application.
