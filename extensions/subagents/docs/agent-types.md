# Agent types

An agent type is a reusable child-agent definition shared by
`subagent_spawn` and Workflow `agent()`: a named preset that fixes a child's
system prompt, its model and thinking level, and — the point of the feature —
**which tools it may use at all**. Four provider-free built-in roles are always
available: `explorer`, `implementer`, `reviewer`, and `advisor`.

Without one, every subagent is the same thing: it inherits the parent model and
the full child tool set, so a "read-only research" subagent still holds `write`,
`edit`, and `bash`, restrained only by how the prompt was worded. A type turns
that into an enforced boundary.

## File format

Types are markdown files with YAML frontmatter, one per file:

```markdown
---
name: explore
description: Read-only codebase exploration. Returns file:line references.
tools: [read, grep, find, ls, fd, rg]
model: anthropic/claude-sonnet-5   # optional
reasoning_effort: medium           # optional
---

You are a read-only exploration agent. Locate code and report concrete
file:line references. You cannot modify files — do not attempt to.
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | `[a-z0-9-]`, ≤64 chars, and must equal the filename stem. |
| `description` | yes | Shown to the parent model when it picks a type. ≤1024 chars. |
| `tools` | no | Tool allowlist. **Omit to inherit the normal tool set.** |
| `model` | no | `provider/model-id`, or a bare id resolved against the current provider. |
| `reasoning_effort` | no | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| body | no | Appended to the child's system prompt. ≤16384 chars. |

`name` must match the filename so a renamed file cannot keep answering to its
old name. An explicit `model` or `reasoning_effort` argument on `subagent_spawn`,
or `model`/`provider` or `effort` on Workflow `agent()`, overrides the type's own.

## Built-in roles

All built-ins omit a model, so they inherit the parent model unless configured
through `/my-pi-setup`. Their complete definitions can be replaced by a custom
file with the same name.

| Role | Tools | Effort | Purpose |
| --- | --- | --- | --- |
| `explorer` | `read grep find ls fd rg` | `high` | Read-only codebase tracing. Use `high` for routine, local, direct tracing; `xhigh` for interacting state transitions, concurrency or trust boundaries, or subtle multi-path lifecycle/control-flow; `max` only for exceptionally difficult broad unfamiliar architecture with unresolved competing flows. |
| `implementer` | `read bash edit write grep find ls fd rg` | `high` | Focused implementation and relevant checks. |
| `reviewer` | `read grep find ls fd rg` | `medium` | Read-only correctness, safety, and regression review. |
| `advisor` | `read grep find ls fd rg` | `xhigh` | Deep read-only analysis and technical advice. |

Built-ins have concise role prompts and no provider or model names. Their tool
allowlists still intersect with plan mode and the child denylist.

## Discovery

Definitions are layered at each `session_start`:

| Priority | Source | Loaded |
| --- | --- | --- |
| lowest | package built-ins | Always. |
| middle | `~/.pi/agent/agents/*.md` | Always. |
| highest | `<cwd>/.pi/agents/*.md` | **Only in a trusted project.** |

A project file supplies an attacker-controllable system prompt and tool list, so
an untrusted repository contributes none. Each higher layer replaces the
**complete** same-name definition from the layer below, and every override is
reported as a diagnostic rather than applied silently.

The Subagent extension initially registers only built-in and global types, then
re-registers `subagent_spawn` at `session_start` from `ctx.cwd` and
`ctx.isProjectTrusted()`. The Workflow extension resolves the same layers at
`session_start` and snapshots that roster for each run. This honors temporary
session-only trust decisions and cross-cwd session replacements without ever
loading an untrusted project's prompt before trust resolves. Edits take effect
on `/reload` or a new session — the same as skills.

A malformed file is skipped and reported as a warning at session start; it never
prevents the other types from loading, and never blocks spawning. Unknown
frontmatter keys make that file malformed rather than being ignored: this fails
closed when `tools` or another restriction field is misspelled instead of
silently giving the child the inherited full tool set.

## Model and effort precedence

For an `agent_type` child, model selection is: explicit call model → selected
type file `model` → `/my-pi-setup` assignment for that built-in role name →
inherited parent model. Effort is: explicit call effort → selected type default
(including a built-in) → parent effort. The generated `subagent_spawn.agent_type`
roster shows each type's default effort or explicit parent inheritance; Workflow
uses the same names and definitions. A custom `explorer.md` therefore replaces
the built-in definition, while an explicit call argument still wins.

`/my-pi-setup` can assign any model currently present in Pi's registry to one or
more built-in roles. Assignments are partial; omitted roles stay unchanged, and
setting a role to `null` clears it back to parent-model inheritance. The
assignment is read when each child is created, so it applies to the next spawn
or Workflow `agent()` call without `/reload`.

## Usage

```
subagent_spawn({ prompt: "...", name: "auth audit", agent_type: "explorer" })
```

Workflow scripts use the same role without hardcoding its configured model:

```js
await agent("Map the auth flow", { agent_type: "explorer" })
```

The `agent_type` parameter is always available because the built-in roles are
always present. Agent Type file changes take effect on `/reload` or a new
session for both direct Subagents and Workflows; each Workflow snapshots that
session roster when its run starts.

## What `tools:` actually guarantees

The list is passed to pi as a session-level allowlist, which it composes with
this package's existing child denylist:

```js
// pi: dist/core/agent-session.js
const isAllowedTool = (name) =>
    (!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name);
```

Two consequences worth being precise about:

- **It can only narrow.** Listing a denied tool (`subagent_spawn`, `bg_start`,
  `ask_user`, …) does not grant it. The child boundary in
  `extensions/shared/child-session.ts` stays authoritative, and the drift guard
  that protects it is unaffected.
- **It also unlocks.** Pi's default active set is only
  `read, bash, edit, write`, so `grep`, `find`, and `ls` are otherwise
  unreachable in a child. Naming them in `tools:` activates them.

So `tools: [read, grep, find, ls]` yields a child that genuinely has no
`write`, `edit`, or `bash` tool to call — not one that has been asked not to.
Parent-only names are removed before the generated roster and spawn result are
shown, so a type that lists `subagent_spawn` never advertises it as usable.
A structured Workflow child additionally receives only its terminating
`structured_output` tool; this does not restore any denied repository tool.

While `/plan` is armed, `isolation: "worktree"` is rejected before Git is
changed. A selected type whose declared tools plan mode would narrow (such as
`implementer`) is also rejected rather than spawning it with a contradictory
implementation prompt; use `explorer`, `reviewer`, `advisor`, or omit the type
for read-only investigation.

Unrecognized tool names are kept at parse time because a third-party extension
may register them. After child extensions initialize, every explicitly listed
child-safe tool is checked against the final active child registry before the
first model prompt. An extension-registered tool therefore works normally; a
typo or unavailable tool fails that direct Subagent or Workflow agent launch
with a bounded error and sends no model tokens. Parent-only names remain denied
and are not treated as missing, so the child denylist stays authoritative.

## Implementation

- `src/agent-types.ts` — built-ins, parsing, discovery, diagnostics, and model
  precedence helpers.
- `../../shared/subagent-roles.ts` — one typed source for built-in role names.
- `index.ts` — safe initial discovery, session-scoped roster refresh and
  re-registration, the `agent_type` parameter, and merging a type/config
  assignment into the spawn task.
- `src/backends/pi.ts` — applies `appendSystemPrompt` and the tool allowlist to
  a direct subagent session.
- `../../workflows/index.ts` and `../../workflows/runner.ts` — resolve the same
  type for each Workflow call and enforce its prompt, model, effort, and tools.
- `../../shared/child-session.ts` — `childToolPolicy(tools?)`, where the allowlist
  and denylist compose.

Covered by `../agent-types.test.ts`, including the trust gate and the
narrowing-only property.
