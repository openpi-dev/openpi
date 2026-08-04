---
name: subagents
description: Invoke this skill when the user asks to use subagents or when a substantial, self-contained task can run independently in the background.
---

# Subagents

The tool definitions are canonical for parameters, limits, model syntax, isolation, and lifecycle commands. This skill governs delegation decisions only.

- Delegate substantial independent work, not a lookup or edit the parent can do directly.
- Give the child a standalone prompt with paths, constraints, relevant context, and the expected report; it cannot see the parent conversation or ask the user.
- Inherit the parent model and thinking level by default. Override them only for an explicit user request or concrete task requirement.
- Prefer a matching agent type when one exists; its tool restriction is enforced. Types live in `~/.pi/agent/agents/*.md` and, for trusted projects, `.pi/agents/*.md`; see `extensions/subagents/docs/agent-types.md`.
- Isolate concurrent writers in worktrees according to the `subagent_spawn` schema so they cannot overwrite one checkout or git index.
- After spawning, continue useful parent work. Let automatic result delivery drive the next turn; block only when the immediate next step truly depends on that result.
