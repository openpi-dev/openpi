# Agent types

An agent type is a reusable subagent definition: a named preset that fixes a
child's system prompt, its model and thinking level, and — the point of the
feature — **which tools it may use at all**. Four provider-free built-in roles
are always available: `explorer`, `implementer`, `reviewer`, and `advisor`.

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

## Built-in roles

All built-ins omit a model, so they inherit the parent model unless configured
through `/my-pi-setup`. Their complete definitions can be replaced by a custom
file with the same name.

| Role | Tools | Effort | Purpose |
| --- | --- | --- | --- |
| `explorer` | `read grep find ls fd rg` | `high` | Read-only codebase tracing. Its description tells the parent to use `xhigh` for cross-module or subtle lifecycle work, and `max` only for exceptionally hard unfamiliar or ambiguous investigations. |
| `implementer` | `read bash edit write grep find ls fd rg` | `high` | Focused implementation and relevant checks. |
| `reviewer` | `read grep find ls fd rg` | `medium` | Read-only correctness, safety, and regression review. |
| `advisor` | `read grep find ls fd rg` | `xhigh` | Deep read-only analysis and technical advice. |

Built-ins have concise role prompts and no provider or model names. Their tool
allowlists still intersect with plan mode and the child denylist.

## Discovery

Definitions are layered at extension load:

| Priority | Source | Loaded |
| --- | --- | --- |
| lowest | package built-ins | Always. |
| middle | `~/.pi/agent/agents/*.md` | Always. |
| highest | `<cwd>/.pi/agents/*.md` | **Only in a trusted project.** |

A project file supplies an attacker-controllable system prompt and tool list, so
an untrusted repository contributes none. Each higher layer replaces the
**complete** same-name definition from the layer below, and every override is
reported as a diagnostic rather than applied silently.

Because a tool's description is a static string fixed when the tool is
registered, the roster has to be known before the model ever sees
`subagent_spawn`. Edits to `agents/*.md` therefore take effect on `/reload` or a
new session — the same as skills.

A malformed file is skipped and reported as a warning at session start; it never
prevents the other types from loading, and never blocks spawning.

## Model and effort precedence

For an `agent_type` spawn, model selection is: explicit `subagent_spawn.model`
→ selected role-file `model` → `/my-pi-setup` assignment for that built-in role
name → inherited parent model. Effort is: explicit `reasoning_effort` → selected
role-file effort (including a built-in) → parent effort. A custom `explorer.md`
therefore replaces the built-in definition, while an explicit spawn argument
still wins.

`/my-pi-setup` can assign any model currently present in Pi's registry to one or
more built-in roles. Assignments are partial; omitted roles stay unchanged, and
setting a role to `null` clears it back to parent-model inheritance. The
assignment is read when each child is spawned, so it applies to the next spawn
without `/reload`.

## Usage

```
subagent_spawn({ prompt: "...", name: "auth audit", agent_type: "explorer" })
```

The `agent_type` parameter is always available because the built-in roles are
always present. File changes still take effect on `/reload` or a new session.

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

- `src/agent-types.ts` — built-ins, parsing, discovery, diagnostics, and model
  precedence helpers.
- `../../shared/subagent-roles.ts` — one typed source for built-in role names.
- `index.ts` — discovery at registration, the `agent_type` parameter, and
  merging a type/config assignment into the spawn task.
- `src/backends/pi.ts` — applies `appendSystemPrompt` and the tool allowlist to
  the child session.
- `../shared/child-session.ts` — `childToolPolicy(tools?)`, where the allowlist
  and denylist compose.

Covered by `../agent-types.test.ts`, including the trust gate and the
narrowing-only property.
