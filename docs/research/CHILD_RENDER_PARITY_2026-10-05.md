# Child conversation presentation parity

- Status: validated at the isolated SDK/component boundary; live terminal acceptance remains unverified.
- Created and verified: 2026-10-05.
- Source boundary: OpenPI main `331327e590c63769fb0f7ce99d03b2ddfd4145c0` plus the change linked from Issue #681; Pi SDK 0.99.1 and installed SDK 1.0.2.
- Related Issue: [#681](https://github.com/openpi-dev/openpi/issues/681), extending [#658](https://github.com/openpi-dev/openpi/issues/658) and [#673](https://github.com/openpi-dev/openpi/issues/673).
- Superseding relationship: none; this supplements the earlier child-page and Code Mode investigations.

## Verified facts

Main TUI presentation applies the Session's public `resolveToolRenderers` chain. The previous child ledger constructed `ToolExecutionComponent` directly from captured execution definitions, skipping that chain. Consequently OpenPI's presentation-only Code Mode extension did not affect the inspected child tool cards.

Both Direct and Workflow child ledgers now resolve presentation through their own bound Session. Ordinary tool activity cards register a presentation resolver on newer hosts in both interactive and headless modes. The resolver preserves native execution definitions, parameters, model-facing metadata and result payloads. Pi 0.99.1 has no resolver API, so the child ledger applies the shared activity projection locally; it does not register replacement child tools or discard configured shell executors.

User and assistant message components now receive the child Session's thinking visibility, output padding, code-block indentation and registered Markdown transformers. Cache identity includes the scalar settings. Messages with registered transformers are not cached, because transformer behavior can change without changing the message identity. None of these values is written into the model transcript or persisted execution state.

## Validation

`tests/extensions/shared/agent-tool-renderer-native.test.ts` creates an isolated headless Session without model calls. With the same arguments, event payloads and clock, it compares the child ledger to the main public presentation chain for read, bash, write, edit, grep, find, ls and Code Mode. Coverage includes partial updates, success/error completion, widths 40/80 and collapsed/expanded/collapsed transitions. Tool executor identity and the model tool surface remain unchanged. Changing thinking visibility after a cached render takes effect.

The test passes against both locked SDK 0.99.1 and installed SDK 1.0.2. Independent source review and isolated native-host smoke also checked the two child backends, native expanded output, and the absence of child executor replacement. These results prove component output, not the currently running user's terminal pixels.

## Boundaries and unknowns

- Main Pi additionally installs a private Mermaid Markdown transformer. It is not available through the public extension runner and is not copied by this fix. Mermaid parity requires a public Pi presentation seam; ordinary Markdown uses the same native message components.
- Child pages continue to suppress native image painting. Fullscreen image ownership is a separate upstream Pi concern tracked in #657; enabling it here would reintroduce unbounded terminal ownership.
- Historical transcripts without a live renderer ledger retain their explicitly bounded previews. Full event payloads are not reconstructed from truncated persisted previews.
- Installed source provenance was checked before diagnosis. The installed checkout contains unrelated user changes and was preserved. Isolated tests explicitly loaded the repair source; the running installed Session has not been shown to reload it.
- Real terminal scrolling, image pixels and an actual running child's visual comparison still require manual acceptance. Component equivalence alone does not close those observations.
