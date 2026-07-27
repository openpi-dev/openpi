---
name: subagents
description: Invoke this skill when the user asks to use subagents or when a self-contained task can run independently in the background.
---

# Subagents

Each subagent is headless, has its own context window, cannot see the parent conversation, cannot ask the user, and cannot spawn subagents or workflows. Give every child a self-contained prompt with paths, constraints, and the expected report.

## Default: Pi subagents

Use the `pi` harness unless the user explicitly requests Claude Code or Codex. Pi subagents run as isolated Pi SDK sessions while retaining this environment's configured providers, tools, skills, project context, and trust decision.

When `model` and `reasoning_effort` are omitted, a Pi subagent inherits the parent session's model and thinking level. This is the normal default. Do not hardcode or guess a model name: available models vary by installation and change over time.

Only pass a model when the user explicitly requests one or the task has a concrete model requirement. Resolve it from the current Pi model registry and prefer the unambiguous `provider/model-id` form. A bare model id is valid only when it resolves unambiguously.

Thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Omit `reasoning_effort` to inherit the parent level.

## External harnesses

The `claude` and `codex` harnesses remain compatibility options. Use one only when the user explicitly asks for that harness. Do not impose repository-owned default models or reasoning levels on external harnesses; omit those fields unless the user specified them. Their CLIs must be installed and authenticated independently.

## Spawn and manage

Call `subagent_spawn` with:

- `prompt`: complete standalone task, including relevant paths and constraints
- `name`: short recognizable label
- `harness`: normally `pi`
- `working_dir`: optional directory when different from the parent cwd
- `model`: optional explicit model selection
- `reasoning_effort`: optional explicit thinking level

At most four subagents run concurrently.

- `subagent_check({ id })`: inspect current state without blocking.
- `subagent_list()`: list tracked model-origin subagents.
- `subagent_wait({ ids })`: block only when their results are required to proceed.
- `subagent_cancel({ ids })`: stop runs while preserving partial transcripts.
- `/subagents`: inspect or take over a run interactively.

Results return automatically. After spawning, continue useful parent work instead of immediately waiting.
