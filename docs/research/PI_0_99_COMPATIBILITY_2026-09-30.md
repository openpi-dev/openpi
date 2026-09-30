# Pi 0.99.1 compatibility

- Status: validated at the source, automated-test, and local CLI smoke boundary
- Created / verified: 2026-09-30
- Source baseline: OpenPI `1c4d3318ae9cfd207255820246f7041821fb36da` (0.9.0)
- Host boundary: `@earendil-works/pi-ai`, `pi-coding-agent`, and `pi-tui` 0.99.1, with the lockfile's native Pi transitive packages
- Fix boundary: the compatibility changes linked from the Issue below
- Issue: [#635](https://github.com/openpi-dev/openpi/issues/635)
- Related PR: [#636](https://github.com/openpi-dev/openpi/pull/636)
- Supersedes: none

## Verified upstream facts

The [versioned Pi changelog](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/CHANGELOG.md)
describes the transcript and Session lifecycle changes between OpenPI's previous
0.85.1 development baseline and 0.99.1. Provider stream callbacks now receive a
normalized transcript containing system sections and tool deltas. Pi supplies
`normalizeContext`, `getCurrentSystemPrompt`, and `getCurrentTools` to resolve it.
Tool call arguments use JSON value types.

[Pi 0.99.0](https://github.com/earendil-works/pi/releases/tag/v0.99.0) adds native
MCP, codemode, tool exposure controls, and nested `ctx.executeTool` execution.
The installed [0.99.1](https://github.com/earendil-works/pi/releases/tag/v0.99.1)
SDK reports prompt admission through `started`, `queued`, or `handled`; failed
preflight rejects the prompt without an admission callback. The callback's type
is available through the public `PromptOptions` export.

## Compatibility change and ownership

The three Pi development dependencies and peer minimums become 0.99.1. The
package continues to use the host's SDK rather than bundling a second runtime.
README and SETUP document the same minimum.

Cursor and Antigravity project the native transcript into their wire formats.
The local replay implementation and its pre-0.86 compatibility types are removed.
Pi owns section replacement, removal, and tool deltas. Existing provider tests
still verify the resulting prompt, tools, and conversation boundaries.

Web admission uses Pi's explicit disposition. `queued` retains the command trace
even if the queue length does not increase. Only `handled` input without a native
agent start settles immediately. Handled input preserves a ready Plan's approval;
rejected preflight cancels its transient authorization. Queue size remains a UI
projection, rather than evidence that a specific command was queued or completed.

Direct-tool fixtures provide the new execution-context fields with a fail-closed
placeholder executor. Real child Sessions separately exercise native nested
execution: an allowed read runs, a parent-only tool and a tool outside the child
allowlist fail, and a permission-blocked read fails through Pi's tool-call hook.
Both codemode and deferred exposure are covered. This requires no additional
OpenPI executor or authority mechanism.

## Validation and limitations

- On macOS, Node 24.20.0 and Bun 1.3.14, `bun run check` passed, including Web
  production build, configuration/documentation checks, formatting, lint, and types.
- `bun run test` passed: 1,948 Node tests and 355 Vitest tests. Eight Node tests
  skipped under their platform conditions. The suite does not prove Windows behavior.
- Cursor's compaction regression uses a real SessionManager-backed Session and
  verifies native threshold compaction with zero reported input usage. It intercepts
  the compaction call instead of making a remote summarization request.
- Web regressions cover all three admission dispositions, unchanged queue length,
  preflight failures, and handled Plan implementation input.
- The five Plan provider browser tests passed with Pi 0.99.1, local HTTP fixture
  responses, and headless Google Chrome. They cover planning context, light/dark
  plan cards, explicit implementation admission, and leaving Plan mode. They do
  not establish compatibility with a remote provider service.
- Plan rendering tests distinguish Pi's native argument preview from OpenPI's
  bounded result preview. The 24-case rendering suite passed.
- An isolated Pi agent directory reported exactly one OpenPI source: the
  compatibility checkout at the source baseline above, with the tested changes.
  The local Pi CLI reported 0.99.1. A print/JSON smoke loaded the package, retained
  normal read/bash/edit/write schemas, checked OpenPI tool registration, and
  emitted two tool starts, a successful read result, a failed read result, and
  `agent_end`. Pi's native faux provider supplied the responses; no remote model
  request or user credential was used.
- The simplification check removed the custom transcript replay and obsolete
  version-dependent compaction fixture branches. Native helpers and a real Session
  continued to satisfy the existing acceptance tests, so those abstractions remain
  deleted.
- Real Cursor/Antigravity OAuth requests, remote provider compatibility, visual
  interactive TUI acceptance, and externally configured MCP servers are unverified.
  This is a compatibility investigation, not a Benchmark or architectural Decision.
