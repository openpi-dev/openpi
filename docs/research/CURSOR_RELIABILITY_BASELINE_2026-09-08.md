---
status: draft
created: 2026-09-08
last-verified: 2026-09-08
applies-to: isolated v0.8.1 worktree a3edee28 plus local OPENPI_CURSOR_WIRE_LOG instrumentation; not the user's daily runtime
related-issues: "#234"
related-prs: "#484, #485"
supersedes: none
---

# OpenPI Cursor reliability experiment baseline

Exploratory research setup and first live samples. Not a formal Benchmark.

## Question

Can parent-agent and subagent tasks on Cursor Grok configs be systematically accepted against machine-checkable acceptors on released OpenPI v0.8.1, and which failure classes are OpenPI-fixable?

## Observed facts

### User checkout (untouched)

Commands run in `/Users/tushaokun/work/my-pi-setup` without writing to it:

- Branch: `codex/knowledge-evidence-contract`
- HEAD: `a9b40f0044ee59c360a6077c1c0bdbdbd30da10b`
- Dirty: yes (docs/research, architecture visuals, `.hive/`, repro scripts). Left intact.
- Local `main`: `2a69d3f32994da4123f1312b7fa84ef3d6119be1` (stale vs origin)
- `origin/main`: `0d17f4577fe31315fe6c95370d251bdb4e2413cf` (contains v0.8.1)

### Release identity

- Annotated tag `v0.8.1` → `a3edee28fec813582db6b3b1341754cef4597f81` (`chore(release): bump version to 0.8.1 (#485)`, 2026-09-08)
- Package version at that commit: `0.8.1`
- Installed Pi CLI: `0.85.1` (`/Users/tushaokun/.bun/bin/pi`)

### Unique daily OpenPI source (do not use for these experiments)

`pi list` (user config, no `PI_CODING_AGENT_DIR`):

```
User packages:
  npm:pi-web-access
    /Users/tushaokun/.pi/agent/npm/node_modules/pi-web-access
  ../../work/openpi-main-runtime
    /Users/tushaokun/work/openpi-main-runtime
```

One OpenPI source: `/Users/tushaokun/work/openpi-main-runtime` at `ed9dbc1018f890fd54375f5371990ddfee8af5df`, package `0.7.0`, branch `main` behind origin by 1. Not v0.8.1. User `settings.json` packages were unchanged after isolated install.

### Isolated experiment assets

| Asset | Path |
| --- | --- |
| Worktree | `/tmp/openpi-reliability-20260908/src` on `research/openpi-cursor-reliability-20260908` @ `a3edee28` |
| Isolated Pi agent dir | `/tmp/openpi-reliability-20260908/pi-agent` via `PI_CODING_AGENT_DIR` |
| Synthetic git repo | `/tmp/openpi-reliability-20260908/synthetic` (HEAD `509b2472d17f50411916ee77c44ec09301b129e4`) |
| Harness | `/tmp/openpi-reliability-20260908/harness` |
| Results | `/tmp/openpi-reliability-20260908/results` |
| Continuation | `/tmp/openpi-reliability-20260908/CONTINUATION.md` |

Isolation probe: `PI_CODING_AGENT_DIR` empty dir listed `No packages installed`; user packages and 939 user Sessions unchanged.

Isolated `pi install` of the worktree then listed only:

```
User packages:
  ../src
    /tmp/openpi-reliability-20260908/src
```

Credentials: isolated `auth.json` is a copy of the user file (providers present: cursor, kimi-code, openai-codex, xai). User `auth.json` / `models-store.json` / `settings.json` mtimes were not changed by isolated `pi update --models` or catalog seed.

### Cursor Grok config availability

Targets: `cursor-grok-4.6-high`, `cursor-grok-4.6-high-fast`, `cursor-grok-4.6-medium-fast`. No substitutions.

| Probe | Result |
| --- | --- |
| User `pi --list-models cursor-grok` | All three IDs present (account catalog, 217 Cursor models, `checkedAt` 1788861139372) |
| Isolated `pi update --models` | Refreshed built-in `openai-codex` and `xai` only. No `cursor` key written. |
| Isolated `pi --list-models cursor` before seed | Only static `cursor/default` from OpenPI |
| Isolated `fetchCursorUsableModels` | Failed: `discovery_transport_or_protocol_failure` in 1141 ms (`results/live-discovery.json`) |
| Isolated `pi --list-models cursor-grok` after seeding the three IDs + `default` from the user catalog | All three IDs listed |
| `pi auth check --provider cursor` | `provider_not_found` in both user and isolated CLIs (Cursor is an OpenPI-registered provider, not a Pi built-in auth provider) |

Availability for selection in the isolated CLI is therefore: **listed after catalog seed**, **not confirmed by live GetUsableModels**. First live AgentService run (below) did stream on `cursor-grok-4.6-high-fast`, which is stronger than list-models alone for that one ID.

### First live parent sample (cell A)

- Run: `results/cells/A-cursor-grok-4.6-high-fast-01-1788881803136`
- Model: `cursor-grok-4.6-high-fast`, thinking `high`, tools `read,bash,rg,fd`
- Duration: 180059 ms, harness SIGTERM, exit 143
- Ledger classification: `timeout`
- Acceptor `A-read-search-bash` v `2026-09-08.1`: `ACCEPT_A.txt` missing; nonce file and forbidden file unchanged
- Native wire log: none (no `OPENPI_CURSOR_WIRE_LOG` events)
- Discriminative evidence: 24 turns, 46 successful Pi tool executions (`read` 23, `rg` 23, 0 errors). The model repeatedly stated it had used Cursor-native / wrong wrappers and must switch to "openpi MCP tools", then called `read`+`rg` again. It never called `bash` and never wrote `ACCEPT_A.txt`.
- Refined class: **model strategy failure** that the harness cut off as **timeout**. Not an agent connection timeout, not a remote disconnect, not a native-rejection hang.
- Likely related OpenPI text: `CURSOR_PI_TOOLS_SYSTEM_PROMPT` tells the model to use "openpi MCP tools" and not Cursor-native tools. Advertised names remain `read` / `rg`. Whether that wording induces the loop is **under investigation**.

### Limits

- Matrix not complete. One parent cell, one model, one attempt.
- Live usable-model discovery failed; catalog seed is not a substitute for GetUsableModels.
- User daily runtime remains OpenPI 0.7.0 at `ed9dbc10`. These runs do not accept that runtime.
- Isolated worktree has uncommitted env-gated `OPENPI_CURSOR_WIRE_LOG` instrumentation in `extensions/ai-providers/cursor/provider.ts`. Behavior is unchanged when the env var is unset.
- Formal Benchmark identities are not claimed.

## Inferences

The v0.8.1 native-rejection path was not exercised in this A sample. The blocking live failure seen so far is a tool-identity loop after successful Pi MCP calls.

## Unknowns

- Whether high / medium-fast show the same loop
- Whether a prompt naming the actual tool IDs stops the loop
- Why isolated GetUsableModels failed while AgentService/Run streamed
- Cancel / disconnect / timeout / cleanup deterministic suite not yet re-run in this worktree this session

## Next

See `/tmp/openpi-reliability-20260908/CONTINUATION.md`.
