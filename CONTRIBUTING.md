# Contributing to OpenPI

Thank you for contributing to OpenPI. Start with the guide that matches your change:

- [Fast-Forward and Linear Git History](docs/contributing/linear-git-history.md) - branch preparation, safe rebasing, pull request merge methods, and local updates.
- [Feishu PR notifications](docs/contributing/feishu-pr-notifications.md) - repository secret setup for pull request group bot messages.

The contribution guides are recommendations for the current repository workflow. Repository administrators must configure GitHub settings separately before those recommendations become enforced policy.

Before opening a pull request, run the checks documented in the guide and use the pull request template in `.github/PULL_REQUEST_TEMPLATE.md`.

## Line endings

The repository enforces LF line endings for text files through the root `.gitattributes` file. This keeps checkouts identical on Windows, macOS, and Linux regardless of a user's global `core.autocrlf` setting.

Pulling this policy into an existing checkout can leave CRLF files unchanged, even when `git status` is clean. To get an LF checkout, keep the existing directory intact and clone into a new, unused directory from its parent directory:

```bash
git clone https://github.com/openpi-dev/openpi.git openpi-lf
git -C openpi-lf ls-files --eol
```

The cloned revision must include this policy. The final command should report `w/lf` for tracked text files with line endings; files without line endings can report `w/none`, and binary files are excluded from this policy.

A fresh clone only includes commits available on the remote. It does not copy unpushed commits, uncommitted changes, untracked files, or ignored files such as local configuration and evidence. Keep the old checkout until you have deliberately transferred any local work you need.

## Development runtime: npm vs current source

The npm artifact, a GitHub install, and a local checkout are three distinct runtime assets. An updated source tree, passing tests, or a matching version number do not prove that the running Pi has loaded this code. All local development, provider-compatibility triage, manual smoke tests, and UI acceptance use the same evidence chain below.

**1. Pin the source and the loaded origin first**

```bash
git status --short --branch
git rev-parse --short HEAD
pi list
```

Done when: you know which checkout, branch, and commit you are changing; `pi list` shows exactly one OpenPI source and you can say whether it is npm, GitHub, or a local absolute path. Other Pi packages (for example `pi-intercom`) are not duplicate OpenPI sources.

**2. Load the current checkout during development**

```bash
git clone https://github.com/openpi-dev/openpi.git ~/work/openpi
cd ~/work/openpi
bun install --frozen-lockfile

# If pi list shows an older OpenPI, set the variable to the package spec
# or absolute path it reports.
OLD_OPENPI_SOURCE=/absolute/path/to/old/openpi
pi remove "$OLD_OPENPI_SOURCE"
pi install "$PWD"
pi list
```

When the current checkout is already installed, there is no need to remove/install repeatedly. After switching branches or editing sources, run `/reload` or restart Pi to reload the extensions — UI and tool surfaces observed before `/reload` only prove the old in-memory state.

Done when: the only OpenPI path in `pi list` is the current checkout, and its HEAD matches the expected commit. Do not edit `~/.pi/agent/npm/node_modules/@tt-a1i/openpi` to impersonate a source fix.

**3. Verify changes in layers**

```bash
# Development loop: run the tests closest to the change first, using the
# runners declared in package.json.
node --test --experimental-strip-types path/to/relevant.test.ts
bunx vitest run path/to/relevant.spec.ts

# Repository gates: both must pass before committing or handing off.
bun run check
bun run test
```

Green automation only proves the code, type, and test contracts. When a change touches the runtime or the UI, also complete the matching smoke in a real, `/reload`ed Pi:

- Tool or lifecycle changes: actually trigger the success, failure, and termination paths in normal tool mode;
- Provider-compatibility changes: keep the normal tool schema; do not bypass problems with `--no-tools`;
- UI changes: trigger the target state in a real TUI and inspect it visually, saving a screenshot when needed;
- Configuration changes: write through `/openpi-setup`, then check the no-argument status output and the actual behavior.

Done when: you record the checkout HEAD, the `pi list` source, the focused tests, `bun run check`, the full test run, and the manual smoke separately. A layer that was not executed is reported as "unverified" — a green result on another layer is not a substitute.

**4. Keep the workspace recoverable**

- Check for a dirty worktree before starting; preserve the user's uncommitted, untracked, and ignored files;
- Local benchmarks, logs, and raw results may be hidden via `.git/info/exclude`, but ignore is not a backup;
- Use `git clean -nd` only to preview ordinary untracked files; never run `git clean -fdx`, which deletes ignored assets;
- Keep a stable running copy and a development checkout side by side only when isolation is genuinely needed, and always state which one Pi loads via `pi list`;
- Re-check the diff before committing so local configuration, secrets, model results, and raw evaluation data never enter version control.

The Host SDK and TypeBox are declared as peer dependencies per the Pi package contract; the repository's dev dependencies are not shipped with the package.

## Repository layout and development

```text
extensions/
├── ai-providers/          # Antigravity and experimental Cursor OAuth model providers
├── setup/                 # /openpi-setup and the restricted config writer
├── subagents/             # Pi-native backend, roles, /subagents
├── workflows/             # DSL, ledger, graph, replay, artifacts
├── plan-mode/ + cron/     # Approval gate and session-scheduled prompts
├── ask-user/              # Reviewed input and human handoff
├── git-read/              # Read-only git show / diff / log inside /plan
├── sessions/              # Session search and switching
├── suggestions/           # Ephemeral next-action suggestion
├── ui-customization/      # Header, footer, terminal title
├── usage/                 # /usage subscription quota and allowance query
└── shared/                # Child policy, config, worktree, terminal sanitizing

bin/openpi.js              # Standalone Web CLI entry
web/                       # Web host, Pi runtime adapter, protocol, and browser UI
site/                      # Project website; published by the Pages workflow after merge to main
skills/                    # Subagent and workflow guides
themes/                    # github-dark-default
```

Day-to-day Web development — frontend/backend boundaries, Vite HMR, and backend auto-restart — is documented in [`docs/development/OPENPI_WEB_DEVELOPMENT.md`](docs/development/OPENPI_WEB_DEVELOPMENT.md). Production runs still use `openpi web [workspace]`; Vite is for local UI development only.

The toolchain uses Bun `1.3.14` for dependencies and scripts, and Biome for TypeScript / JavaScript / JSON formatting and basic linting. The product runtime is still Node, and tests run under `node:test` and Vitest.

The root `tsconfig.json` is the single TypeScript project configuration for every extension; do not add per-extension `tsconfig.json` files. For a standalone type check use `bun run typecheck` at the root; for full validation run:

```bash
bun install --frozen-lockfile
bun run check
bun run test
```

npm is still used for `pack` and clean-install verification of the published package, because users install OpenPI from the npm registry.

Test coverage spans process-tree termination and races, subagent lifecycle and tool boundaries, the workflow sandbox / ledger / graph / replay / acceptance, worktree data preservation, session state recovery, configuration migration, and TUI rendering. Design records live in [docs/design/](https://github.com/openpi-dev/openpi/tree/main/docs/design/); file problems at [GitHub Issues](https://github.com/openpi-dev/openpi/issues).
