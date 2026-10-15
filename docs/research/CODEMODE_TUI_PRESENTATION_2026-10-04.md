# Code Mode TUI presentation ownership

- Status: validated at source, isolated native loader and renderer-fixture boundaries; real terminal pixels remain unverified
- Created / last verified: 2026-10-04
- Source boundary: OpenPI baseline `a2e0a5c6ee92d635379e6b91f94dbe966b75700f`; installed Pi 1.0.2; locked SDK 0.99.1; implementation `80aa5cd427d1dd0300674524e9d954d9fc42e9df`
- Issue: [#673](https://github.com/openpi-dev/openpi/issues/673)
- Related PR: pending
- Supersedes: none

## Ownership and requested behavior

The maintainer requested implementation in OpenPI so package users receive the presentation improvement. The initial inference that a Pi-owned default renderer required an upstream patch was incorrect: Pi 1.0.2 exposes `ExtensionAPI.registerToolRenderer`, whose resolver receives the tool name and a `next()` renderer continuation. Tool renderers expose a `self` shell. This is a native extension seam for presentation; replacing the tool definition or modifying the installed host is unnecessary.

The installed Pi 1.0.2 renderer defaults to ten visual script lines, eight nested calls with argument previews, and five output lines. Earlier errors can fall outside the recent-call slice. Native shell color derives from outer `isError`, independently of nested-call outcomes. These source observations explain the reported density and ambiguous success presentation; they do not establish the pixels of the user's running Session.

The installed OpenPI source was independently checked through `pi list`: one source, `~/work/openpi-main-runtime`, revision `d36b58b67f87d24b4926521b965bdccfff7719e4`. The implementation checkout is separate and based on the baseline above. No installation or running Session change was used to infer behavior.

## Scope and evidence boundaries

OpenPI presentation should default to a compact status summary, bounded recent nested calls and short output. Scripts and lengthy parameters belong in the existing tool-expansion path. All calls contribute to status counts; a missing/non-array ledger is unknown, whereas an explicitly recorded empty array means zero; earlier failure/cancellation remains visible independently of the outer script result. Unknown facts must remain unknown. Outer elapsed time can be reported only from the exact native result header, not by summing parallel child durations.

Any JSON formatting is a display-only projection of complete, bounded top-level JSON. Nested field names do not justify decoding embedded strings or extracting a guessed main result. Expanded raw output remains available. Terminal controls are sanitized for display without mutating stored evidence or model results. Native image lifecycle remains with Pi.

The locked SDK 0.99.1 has no public renderer-resolver interface. It must retain native rendering; supporting 1.0.2 presentation must not replace the executor, patch private fields or force a dependency upgrade. No new configuration choice or tool is required.

Implementation tests, native loader/renderer resolution, full repository gates, and real terminal pixel acceptance are distinct evidence layers. The source and synthetic fixture evidence below does not establish live terminal acceptance.

## Validation and remaining acceptance

The implementation registers only a renderer resolver for the exact `codemode` tool name and invokes the continuation for other names. No tool, executor, command, event handler or configuration writer is registered. Compact anomalies start with status glyphs so a cancellation remains identifiable at widths one, four and eight even when later errors displace its individual row. Expanded sections retain the exact native header as well as script, arguments and original output. Native image blocks are still rendered by Pi ToolExecution.

Focused tests passed 13/13 in 1.72 seconds, including actual locked SDK 0.99.1 resource loading and its native fallback. An isolated installed SDK 1.0.2 resource loader, native Code Mode factory, public renderer resolver and ToolExecution fixture selected the OpenPI self shell while preserving executor/schema/tool-surface identity and native images. The fixture body took 242 ms, but the cold global-SDK process took 21.55 seconds; bootstrap and test work are distinct costs. This used no model requests. These are synthetic native renderer observations, not screenshots of the user's running terminal.

The local repository check passed. One complete local test run passed 2,283 Node tests (9 skipped; 128.75 seconds) and 1,158 UI tests (32.13 seconds). The candidate was under a narrow cancellation-display correction during that run; final focused tests and exact-head CI must separately cover the frozen correction. No timeout increase, disabled assertion, executor replacement or installed-host edit was used.

Real terminal pixels, keyboard expansion in the user's actual Session and package reload remain unverified. Installation was not changed.

## 2026-10-05: background continuity after truncation

- Status: validated at the ANSI renderer and isolated native SDK boundaries; live terminal pixels after reload remain unverified.
- Source boundary: main `214fac3786f80107e22d5bd2b53b472461ef16b2` plus the repair linked from [#683](https://github.com/openpi-dev/openpi/issues/683).
- Created / verified: 2026-10-05. This supplements the earlier observations without replacing their evidence.

A new user screenshot showed the card background ending immediately after a truncated Bash preview. Pi's public `truncateToWidth` inserts SGR `ESC[0m`, resetting background as well as foreground. Wrapping the complete padded row once with `theme.bg` does not restore the background after that embedded reset. The regression reproduced an unpainted ellipsis and trailing space before the fix.

The OpenPI frame now applies its owning background independently to each segment separated by the native full-style reset. The original reset is retained between segments, preserving foreground/style termination. Displayed text, width, truncation budgets, execution and result evidence are unchanged. This repair applies to main and child presentations through their shared Code Mode renderer.

The regression checks ANSI background state for every visible character, including padding, at 40/120/240 columns in collapsed and expanded views with a long Chinese-containing Bash preview. It deliberately retains escape sequences; a stripped-text comparison could not detect this defect. Focused renderer/native tests pass 21/21 on locked Pi 0.99.1 and installed Pi 1.0.2, without model calls. Full repository checks and independent review are reported on the repair PR. The installed dirty source checkout was preserved; no assertion here proves that a running Session reloaded the repair.
