---
name: subagents
description: Invoke this skill when the user asks to use subagents or when a substantial, self-contained task can run independently in the background.
---

# Subagents

The tool definitions are canonical for parameters, limits, model syntax, isolation, and lifecycle commands. This skill governs delegation decisions only.

- Delegate substantial independent work, not a lookup or edit the parent can do directly.
- Give the child a standalone prompt with paths, constraints, relevant context, and the expected report; it cannot see the parent conversation or ask the user.
- Inherit the parent model by default. When choosing the child's reasoning effort, honor an explicit user requirement first; otherwise use the selected role's relative guidance and the task's difficulty, choosing from levels supported by the resolved child model.
- Prefer a matching agent type when one exists; its tool restriction is enforced. Model precedence is explicit spawn override, selected type-file model, configured built-in role model, then parent model. Reasoning precedence is explicit spawn override, selected type default, then parent effort. Types live in `~/.pi/agent/agents/*.md` and, for trusted projects, `.pi/agents/*.md`; see [Agent types](REFERENCE.md).
- Isolate concurrent writers in worktrees according to the `subagent_spawn` schema so they cannot overwrite one checkout or git index. While Plan Mode is active, use only read-only exploration types (or no type); worktree isolation and types narrowed by Plan Mode are rejected.
- After spawning, continue useful parent work. In an interactive session, if none remains, tell the user the child is still running and end the turn; automatic result delivery will re-invoke the parent when it settles. Do not block merely because the next step depends on the result or because there is nothing else to do. Use `subagent_wait` only when the user explicitly asks to keep the current response open for the result, or when non-interactive automation must return it in the same invocation.
- Use optional `output_schema` when downstream work needs a machine-validated result rather than prose. The child then receives one terminating `structured_output` tool, and the run fails if it finishes without submitting a matching value. Keep schemas small and task-specific; the validated JSON is delivered to the parent and preserved in a private content-addressed artifact. Omit the option for ordinary text reports.

## Worktree isolation

Concurrent writers without isolation share the same checkout and Git index, so edits and `git add` operations can overwrite each other. Set `isolation: "worktree"` and tell every writing child to commit.

The worktree is branched from `HEAD`, requires a Git repository, and starts clean without gitignored files such as build output or `.env`. A successful committed child leaves a branch for the parent to merge. An empty branch can be deleted; dirty, untracked, ignored, detached, timed-out, or uninspectable work is preserved instead of being destroyed. Direct subagents retain their checkout for later `subagent_send` review and only reclaim it on Session retirement after a bounded empty-work proof.
