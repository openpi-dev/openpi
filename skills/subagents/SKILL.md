---
name: subagents
description: Invoke this skill when the user asks to use subagents or when a self-contained task can run independently in the background.
---

# Subagents

Each subagent is headless, has its own context window, cannot see the parent conversation, cannot ask the user, and cannot spawn subagents or workflows. Give every child a self-contained prompt with paths, constraints, and the expected report.

## Pi subagents

`pi` is the only harness. Pi subagents run as isolated Pi SDK sessions while retaining this environment's configured providers, tools, skills, project context, and trust decision.

When `model` and `reasoning_effort` are omitted, a Pi subagent inherits the parent session's model and thinking level. This is the normal default. Do not hardcode or guess a model name: available models vary by installation and change over time.

Only pass a model when the user explicitly requests one or the task has a concrete model requirement. Resolve it from the current Pi model registry and prefer the unambiguous `provider/model-id` form. A bare model id is valid only when it resolves unambiguously.

Thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Omit `reasoning_effort` to inherit the parent level.

## Agent types

An environment may define agent types: named presets that give a child a specialized system prompt and, usually, restrict it to a subset of tools. When types exist, `subagent_spawn` accepts `agent_type`, and its parameter description lists each available type with its tool restriction.

Prefer a matching type over a general-purpose child. The tool restriction is enforced by the harness, not merely described — a read-only type has no write tool to call. An explicit `model` or `reasoning_effort` argument overrides the type's own.

Types are defined in `~/.pi/agent/agents/*.md` and, in trusted projects, `.pi/agents/*.md`. See `extensions/subagents/docs/agent-types.md` for the file format.

## Spawn and manage

Call `subagent_spawn` with:

- `prompt`: complete standalone task, including relevant paths and constraints
- `name`: short recognizable label
- `harness`: normally `pi`
- `working_dir`: optional directory when different from the parent cwd
- `model`: optional explicit model selection
- `reasoning_effort`: optional explicit thinking level
- `agent_type`: optional preset, when the environment defines any

At most four subagents run concurrently.

- `subagent_check({ id })`: inspect current state without blocking.
- `subagent_list()`: list tracked model-origin subagents.
- `subagent_wait({ ids })`: block only when their results are required to proceed.
- `subagent_cancel({ ids })`: stop runs while preserving partial transcripts.
- `/subagents`: inspect or take over a run interactively.

Results return automatically. After spawning, continue useful parent work instead of immediately waiting.
