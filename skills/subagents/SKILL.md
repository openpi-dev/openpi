---
name: subagents
description: Use the subagents extension to delegate autonomous background work across pi, Claude Code, and Codex harnesses. Load when spawning, choosing models or harnesses, monitoring, waiting for, or cancelling subagents.
---

# Subagents

Use subagents for self-contained work that can run independently. Each child is headless, has its own context window, cannot see the parent conversation, cannot ask the user, and cannot spawn subagents or workflows.

## Spawn

Call `subagent_spawn` with:

- `prompt`: a complete standalone task. Include context, paths, constraints, and what to report.
- `name`: a short UI label.
- `harness`: `pi`, `claude`, or `codex`.
- `working_dir` (optional): defaults to the parent's cwd.
- `model` (optional): harness-specific model hint.
- `reasoning_effort` (optional): `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

At most four subagents may run concurrently across all harnesses. Spawning is fire-and-forget: continue useful parent work rather than waiting immediately.

## Choose a Harness

- **`pi`** — Default choice. Runs an in-process pi session and inherits the current model and thinking level when omitted. It loads normal tools, settings, skills, extensions, and trusted project resources. Model hints may be `provider/model-id` or an unambiguous model id.
- **`claude`** — Use when Claude Code is requested or its agent/tooling is a better fit. Model hints are Claude aliases or model names such as `sonnet` or `opus`. Requires Claude Code to be installed and authenticated.
- **`codex`** — Use when Codex is requested or its coding workflow is a better fit. Model hints are Codex model slugs. Requires the Codex CLI to be installed and authenticated.

Reasoning effort is mapped to each harness's native setting: pi thinking level, Claude thinking budget, or the nearest supported Codex effort.

## Manage Runs

- `subagent_check({ id })`: non-blocking status and recent activity peek.
- `subagent_list()`: list all tracked runs and their harness/status.
- `subagent_wait({ ids })`: block until all listed runs settle. Use only when their results are required to proceed.
- `subagent_cancel({ ids })`: stop active runs; partial transcripts remain available.
- `/subagents`: open the interactive picker to inspect or take over a run.

Completed results are automatically queued back into the parent session unless explicitly collected with `subagent_wait`.

## Prompt Pattern

```text
In <working directory>, do <specific task>.
Read <relevant files>. Follow <constraints>.
Do not <out-of-scope actions>.
Report <findings, changed files, tests, or recommendation>.
```

Prefer parallel subagents only for independent tasks. Use the `workflow` tool instead when work needs ordered phases, dynamic fan-out, or structured aggregation.
