# GitHub updates and installed skills

Tracer can check GitHub and maintain a separate, per-user installation. Updates never execute downloaded install scripts, run npm, collect credentials, modify shell startup files, or require sudo. Your application's repository, `tracer.json`, mapping sidecar, `AGENTS.md` and `CLAUDE.md` are not update targets.

## Start with a check

```sh
tracer update --status
tracer update --check
tracer update --check --json
```

`--status` is local and read-only. `--check` contacts only the official public `pcopu/tracerCLI` GitHub API, resolves the source to an immutable commit, and reports the version and commit. It does not install anything. No token, login or API key is needed. GitHub's unauthenticated API limits still apply.

By default Tracer selects the latest stable, non-draft GitHub release with a `vMAJOR.MINOR.PATCH` tag. **Before the first stable release exists, it follows the official `main` branch**, resolving the branch to an exact commit before fetching any package files. This bootstrap channel is development source, not a signed release channel. Once a stable release exists, the default follows releases instead. If neither a release nor `main` exists yet, the result is `unavailable`.

Exact selections are also supported:

```sh
tracer update --check --version 0.1.0
tracer update --check --commit FULL_40_CHARACTER_LOWERCASE_COMMIT_HASH
```

Replace the uppercase placeholder with an actual, reviewed lowercase hash. An exact version requires an existing matching GitHub release. A full commit pin works before releases are published. Branch names, short hashes, version ranges and prerelease selectors are refused for these flags.

## Create the managed installation

```sh
tracer update --install-managed
# Or pin the first installation to a reviewed official commit:
tracer update --install-managed --commit FULL_40_CHARACTER_LOWERCASE_COMMIT_HASH
```

This creates:

```text
~/.local/share/tracer/
  bin/tracer
  active.json
  settings.json
  releases/VERSION-COMMIT/
```

Run the displayed managed launcher directly:

```sh
~/.local/share/tracer/bin/tracer --version
~/.local/share/tracer/bin/tracer update --status
```

You can add `~/.local/share/tracer/bin` to your PATH yourself if desired. Tracer does not change PATH, aliases, shell profiles or npm's global binary links. An existing `tracer` command may still point at an npm or Git checkout; `update --status --json` distinguishes `managed` (a managed installation exists) from `runningManaged` (this invocation is using it).

An ordinary `tracer update` does **not** overwrite an unmanaged npm install or Git checkout. It explains how to create the managed installation. If a managed installation already exists, an explicit update can maintain that separate installation without replacing the invoking npm/Git source. Existing application source and unrelated local work are untouched.

Use the managed launcher for subsequent updates:

```sh
~/.local/share/tracer/bin/tracer update
```

Node.js 20 or newer must already be installed. The updater installs Tracer's dependency-free runtime, bundled skill and text documentation, not Node, Git, dependencies, tests or the README animation. It rejects releases requiring runtime dependencies or npm lifecycle hooks.

## Opt into automatic checks or application

Automatic behavior is **off by default** and requires an explicit choice:

```sh
tracer update --auto check  # Check and report only.
tracer update --auto apply # Apply verified updates when using the managed launcher.
tracer update --auto off   # Disable automatic activity.
```

Run these as separate commands from installation or checking. The setting is saved per user, outside application repositories.

- A successful `init`, `link`, `unlink`, `actions` or `app` invocation may perform an update check **after the requested command finishes**, at most once every 24 hours. There is no background daemon, cron job or startup service. If Tracer is not invoked, nothing runs.
- `report`, `check`, `config`, `update`, help and version output do not trigger automatic update work. Map/report integrity checks remain deterministic and do not execute the application or fetch updates.
- `CI` set to a nonempty value, or `TRACER_NO_UPDATE=1`, disables automatic work for that process. For example, `TRACER_NO_UPDATE=1 tracer link ...` disables it for one command. Explicit `tracer update --check` or `tracer update` is still an explicit network request.
- Automatic `apply` works only when the invocation is using the current managed installation. An unmanaged invocation checks and reports instead; it never silently migrates or replaces npm/Git installations.
- Automatic application requires the new official commit to descend from the installed commit. Rewritten or divergent history needs review and an explicit update.
- Before the first release, a descendant `main` commit **may update even if its package version has not changed**. Same-version release retags are not automatically installed. Review and pin an exact commit explicitly if that is intentional.
- Network errors and rate limits do not change the original command's output or success status. Automatic notices go to stderr and failed checks are also throttled. `update --status --json` exposes the last result.

An enabled update can replace the managed version after a command. It never re-runs that command with new code. The new version executes only on the **next** managed-launcher invocation. Opting into `apply` therefore trusts future eligible code from the official repository; use `check` or exact manual pins if you want to review each change first.

## Verification and trust boundary

The updater uses only fixed API paths below `https://api.github.com/repos/pcopu/tracerCLI`. It does not accept download-server URLs from CLI arguments, follow redirects, send authentication headers, or run package scripts. Checks and downloads have time and size limits.

For an installation it:

1. Resolves the selected release tag, official `main`, or exact commit pin to a full immutable commit ID.
2. Verifies package name, version, repository identity and the dependency-free runtime layout.
3. Reads the pinned Git tree and recomputes each tree object's Git SHA-1 checksum, including directory structure. Truncated trees, unexpected runtime symlinks, unsafe paths and case-colliding files fail closed.
4. Fetches individual allowlisted blobs by object ID. It verifies each blob's declared size and Git SHA-1 object checksum. No archive extraction occurs.
5. Computes SHA-256 hashes for the installed file inventory and verifies the staged installation before activation.

These checks provide official GitHub HTTPS provenance, immutable source selection and integrity checks. **They are not an independent publisher signature, a GitHub artifact attestation, a malware review or protection from a compromised official repository/GitHub account.** Git's existing object identity is SHA-1; the separate SHA-256 inventory detects later local edits but is not a detached upstream signature. No signing key or attestation infrastructure is claimed or required.

The updater rejects symlinked state/installation paths and uses a private per-user writer lock. It is not a sandbox against another process with the same user's permissions racing filesystem changes.

## Atomic activation, errors and rollback

Files download and verify into a new version directory. Only after the full installation is verified does Tracer atomically replace the small `active.json` pointer. The stable launcher uses that pointer on its next invocation. No new application or CLI code is executed to validate an update.

An error before activation leaves the previous active runtime unchanged. Existing version directories are retained, so a failed download does not require re-downloading the prior version. Modified managed runtime files or an edited launcher are preserved by refusing an update rather than overwriting them. Explicit version downgrades are also refused, including when an old npm copy invokes the updater against a newer managed installation.

Rollback is a local-only operation:

```sh
~/.local/share/tracer/bin/tracer update --rollback
```

It verifies the previous installation and swaps the pointer back. Both versions remain on disk. Rollback does not modify installed agent skills or project instruction files. If `apply` remains enabled, a later eligible invocation can advance again; set `--auto off` first when investigating a problematic release. Old versions are not automatically garbage-collected.

The lock is `~/.local/share/tracer/.update-lock`. An interrupted process can leave it behind. Read its `owner.json`, confirm that the owning update process is no longer running, and only then remove that stale lock directory manually. Never remove a lock held by a running update. Tracer will not break locks or kill processes automatically. Interrupted staging directories are inactive and are not executed.

## Installed skill updates

A newly installed bundled skill from `tracer init --agent codex|claude --install-skill` records its exact SHA-256 checksum and destination. Existing, unregistered skills are not adopted automatically.

On a managed update, Tracer refreshes **only registered skills whose current contents still match their last installed checksum**:

- An unchanged registered skill receives the new bundled `SKILL.md` through an atomic file replacement.
- A skill with local edits is preserved and reported as `modified`. Review and merge the new bundled skill manually if wanted.
- Missing files are not recreated and symlinked paths are not followed.
- Unregistered/custom skills, other agent files, `AGENTS.md` and `CLAUDE.md` are never modified by the updater.
- A skill failure does not undo an already activated CLI update. The result lists preserved/failed skill updates separately.

Run `tracer update --refresh-skills` (optionally `--json`) to explicitly refresh registered skills from the bundled skill in the currently invoked installation, without checking or downloading a release. It uses the same lock, checksum checks and preservation rules above. Registered skills from a newer version are preserved, so invoking an older installation cannot downgrade them. It never registers existing unregistered skills or changes project instructions. Actual destination or metadata failures return `skills-partial` and a nonzero exit, with details for each preserved destination; customized, missing or newer skills are explicitly reported nonfatal preservation outcomes. This local operation cannot be combined with other update modes, version pins or commit pins.

CLI activation and updates at separate skill destinations are not one filesystem transaction. Each replacement is atomic, with any failure reported. The generic project pointer remains the same as the skill evolves. **A changed skill takes effect when the agent next loads that file**, often in a new session or after a restart; this is not a live instruction hot-swap and discovery is agent-dependent.

## Maintainer and embedding notes

There is no mandatory release-asset format or generated manifest to publish. Commit the source to the official repository and keep `package.json`'s version, name, repository and bin layout correct. Publish a stable `vVERSION` GitHub release to move users from bootstrap `main` to the release channel. A version bump is required for ordinary release-to-release advancement; don't silently retag a published release. No GitHub Actions workflow is installed.

`src/update.mjs` exports:

- `checkForUpdate(options)` and `updateCLI(options)`: asynchronous checks and managed updates. Options include `version`, `commit`, `installManaged`, and `currentVersion` for integration. Updates derive downgrade protection from the managed target's verified manifest.
- `updateStatus(options)`, `configureUpdates('off'|'check'|'apply', options)` and `rollbackUpdate(options)`: local status, persisted opt-in behavior and rollback.
- `maybeAutoUpdate({ command, ...options })`: optional post-command hook that returns notices without printing or changing the caller's exit status.
- `registerInstalledSkill(absoluteSkillPath, { version, ...options })`: call only immediately after an authorized installation of the bundled skill. Re-registration cannot bless later edits.
- `refreshRegisteredSkills({ source, version, ...options })`: conservative refresh from a caller-supplied bundled skill file (or the current installation when called without arguments); never register arbitrary existing files first.

The `fetch`, `updateHome`, `installRoot`, `home`, time and environment seams support isolated tests and trusted embedders; none are arbitrary-server CLI flags. `fetch` is a trusted code-injection seam, not an alternative security boundary. Production CLI networking always uses the fixed official endpoint.

Run `node bin/tracer.mjs app -- test update` for synthetic, offline verification, or `npm run check` for the complete suite. The journeys invoke real CLI subprocesses with isolated homes and test-only GitHub transport fixtures; they never import production update APIs. They cover real Git tree/blob hashes, exact pins, main fallback, package identity, unsafe paths and symlinks, corruption, atomic activation, downgrade guards, rollback, edited skills, opt-in/throttled automation, preserved npm/Git source and a loopback-only HTTP transport fixture. They do not prove that a future upstream release is bug-free or signed.
