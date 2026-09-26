---
status: validated
created: 2026-09-07
last-verified: 2026-09-07
applies-to: OpenPI Web trajectory evidence projection
related-issues: #446, #76
related-prs: none
supersedes: none
---

# Web trajectory evidence boundary

- Status: source-verified design; deterministic implementation validation belongs to the linked PR. Not a performance benchmark or provider acceptance result.
- Created and verified: 2026-09-07.
- Source: OpenPI main `0796a5e48ff62353bf926ad39e7020e1c5a605d6`, Pi `0.85.1`, DeepSeek Harness `d347e703908d0406b7a7ef80e3a0e594d86b2215`.
- Tracking: [Issue #446](https://github.com/openpi-dev/openpi/issues/446), under [Web roadmap #76](https://github.com/openpi-dev/openpi/issues/76).
- Supersedes: none.

## Observations

[DeepSeek Harness ui-trajectory](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/client/ui-trajectory/README.md) consumes its own Session event projection to display record order, timing and selected input/output details. This investigation did not run its UI or compare rendering performance.

OpenPI `web/protocol/types.ts` projects bounded Session entries, text, returned thinking, tool arguments, tool-call IDs, results and error flags. The projection omits parent IDs, request context, model usage and execution start/end times. Entry timestamps are record timestamps, not tool execution durations. A missing result in a bounded history does not prove an active tool. A successful return may only acknowledge background-work admission.

Pi's `context` event precedes `convertToLlm`; `before_agent_start` exposes an assembled system prompt that subsequent handlers may modify. The native Agent `streamFn` receives converted context. SDK `onPayload` invokes the `before_provider_request` handler chain, whose handlers may replace the payload. An arbitrary observer in that chain cannot attest to the final payload sent to the provider. Relevant installed source: `pi-agent-core/dist/agent-loop.js`, `pi-coding-agent/dist/core/sdk.js`, and `pi-coding-agent/dist/core/extensions/runner.js`.

## First implementation boundary

The trajectory is a browser-only projection of the already loaded saved records. It preserves repeated text, pairs tools only with unique matching IDs and names, keeps unmatched results, and leaves outcomes unknown when evidence is absent. The graph encodes record order, not dependency or parallel execution. It opens on the last 50 nodes and reveals earlier loaded nodes on demand. Only selected evidence is expanded. Existing snapshot refresh events supply saved updates; in-flight text remains in Chat.

Existing Chat's content-based live deduplication and synthesized live timestamps are unsuitable as an audit source. This implementation does not reuse that merger or silently change Chat behavior. It also adds no full-history scan, endpoint, model tool, request capture, persistence, timer or provider implementation.

## Verified facts

The source review establishes the bounded trajectory projection and its evidence omissions.

## Inferences

The projection is suitable for the recorded browser inspection boundary but cannot attest to final provider payloads or complete execution history.

## Recommendations

Keep future request inspection behind a separately bounded native capture with explicit source and sensitivity rules.

## Unknowns

Historical full requests, complete tool durations, and final wire payloads remain unknown.

## Deferred and unknown

A full request inspector needs a separately bounded native capture after mutable handlers, with explicit source identity and handling of sensitive context. Historical full requests cannot be reconstructed reliably from this Web projection. Real model usage and realtime tool duration could be added through Pi's native message/event seams; unknown values must remain unknown. No claim is made about final wire payload, complete context, historical tool duration, or end-to-end performance.
