# Agent types

An agent type is a reusable subagent definition: a named preset that fixes a
child's system prompt, its model and thinking level, and — the point of the
feature — **which tools it may use at all**.

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
old name. An explicit `model` or `reasoning_effort` argument on `subagent_spawn`
overrides the type's own.

## Discovery

Two directories, scanned at extension load:

| Location | Loaded |
| --- | --- |
| `~/.pi/agent/agents/*.md` | Always. |
| `<cwd>/.pi/agents/*.md` | **Only in a trusted project.** |

A project file supplies an attacker-controllable system prompt and tool list, so
an untrusted repository contributes none. Project types override global ones of
the same name, and the override is reported rather than applied silently.

Because a tool's description is a static string fixed when the tool is
registered, the roster has to be known before the model ever sees
`subagent_spawn`. Edits to `agents/*.md` therefore take effect on `/reload` or a
new session — the same as skills.

A malformed file is skipped and reported as a warning at session start; it never
prevents the other types from loading, and never blocks spawning.

## Usage

```
subagent_spawn({ prompt: "...", name: "auth audit", agent_type: "explore" })
```

The `agent_type` parameter exists only when at least one type was discovered, so
an installation with no `agents/` directory behaves exactly as before.

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

Unrecognized tool names are kept and reported rather than rejected: a
third-party extension may register tools this package cannot enumerate, but a
typo that silently removes a capability is worth a warning.

## Implementation

- `src/agent-types.ts` — parsing, discovery, diagnostics.
- `index.ts` — discovery at registration, the conditional `agent_type`
  parameter, and merging a type into the spawn task.
- `src/backends/pi.ts` — applies `appendSystemPrompt` and the tool allowlist to
  the child session.
- `../shared/child-session.ts` — `childToolPolicy(tools?)`, where the allowlist
  and denylist compose.

Covered by `../agent-types.test.ts`, including the trust gate and the
narrowing-only property.
