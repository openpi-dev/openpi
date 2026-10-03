# Already-cancelled child tool dispatch

- Status: validated for deterministic source-level reproduction and focused regression tests; full-suite acceptance is recorded in the repair PR
- Created / verified: 2026-10-03
- Source boundary: `c7862b852d866123e2b32c79d309bd49a3cf515f`
- Issue: [#645](https://github.com/openpi-dev/openpi/issues/645)
- Repair PR: [#646](https://github.com/openpi-dev/openpi/pull/646)
- Supersedes: none

## Scope and verified facts

This investigation covers the shared `runWithToolCallTimeout` helper used by Direct Subagent's Pi backend and Workflow child tool guards. It does not diagnose an installed Pi runtime. The isolated repair checkout starts at the source revision above; the user's existing checkout, installed packages, settings and private Sessions are untouched. No model call or TUI smoke was performed.

At the source boundary, a caller can abort its controller before entering the helper. The helper creates an already-aborted execution signal and a rejected cancellation Promise, but still invokes `execute` while constructing the arguments to `Promise.race`.

Two deterministic tests exercise that production boundary:

- An immediately fulfilled tool executes once and wins the race, reporting success despite prior cancellation. The test requiring the original cancellation Error fails with `Missing expected rejection`.
- A pending tool also executes once. The helper returns a cancellation error, but the test requiring zero dispatches fails with `1 !== 0`.

The first minimal probe was repeated three times on Node 24.14.0 / Windows with identical results: `{"calls":1,"outcome":"executed"}`. Both focused regressions failed before the repair and passed afterward. Existing timeout, in-flight cancellation, result pass-through, fresh per-call timeout and guard idempotence tests also passed (eight tests total).

## Repair and ownership

Reject an already-aborted caller at entry, before allocating the timer or invoking the underlying tool. Preserve the original Error identity and the existing named-tool fallback error for non-Error reasons. Cancellation remains a runtime fact conveyed by Pi's AbortSignal; there is no new model-facing tool, setup option, provider layer, pause mechanism or orchestration policy.

This repairs admission at the existing child execution seam. It does not claim to forcibly stop an arbitrary tool that was already executing, undo side effects, or resolve a cancellation that happens after execution has begun. The existing in-flight timeout/cancellation behavior remains authoritative.

## Reproduction and limits

Run the focused regressions with the repository's Node runner:

```bash
node --test --experimental-strip-types tests/extensions/shared/tool-call-timeout.test.ts
```

The regressions prove the helper's dispatch and error behavior, not the frequency with which a real Pi session reaches it after cancellation. A mutating third-party tool that starts work before checking its signal could perform side effects on the old path; that consequence is an inference from the proven invocation, not an observed production incident.

Duplicate checks covered open Issues/PRs, recent closed/merged work and targeted searches for `tool-call-timeout`, `pre-aborted` and `already aborted`. [#428](https://github.com/openpi-dev/openpi/issues/428) concerns child acquisition cleanup; [#161](https://github.com/openpi-dev/openpi/issues/161) concerns global pause research; [#424](https://github.com/openpi-dev/openpi/issues/424) tracks the earlier child execution repair. None tracks this already-aborted tool invocation defect.
