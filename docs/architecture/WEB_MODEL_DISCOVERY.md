# Bounded Web model discovery

- Status: `validated`
- Created: 2026-09-09
- Verified: 2026-09-10
- Source boundary: implementation commit `c50af9d87bf2521710bef96bc788858c3cc3c143`, based on `5bf2fe29e52801d79826c2eb573be403f53285e5`
- Affected Pi primitive: Pi's available-model snapshot and active Web Session model selection
- Related Issue: [#459](https://github.com/openpi-dev/openpi/issues/459)
- Related PR: [#521](https://github.com/openpi-dev/openpi/pull/521)
- Related Decision: [0001 - documentation and evidence governance](../decisions/0001-documentation-and-evidence-governance.md)
- Supersedes: none

## Ownership

Pi remains the only source of truth for available models and the active Session model. `PiWebRuntime` reads `modelRuntime.getAvailableSnapshot()` and performs model selection through the active Pi Session. OpenPI does not persist a second model catalog, introduce a provider stack, or infer availability from browser state.

`PiWebAdapter` keeps the Web snapshot bounded to `WEB_MAX_MODELS` entries while retaining the current model. `snapshot.truncation.modelsOmitted` reports how many available models are absent after count or snapshot-byte limiting. The browser treats that value as projection evidence, not as a model total it computed locally.

## Discovery contract

When a snapshot omits models, the browser can query the authenticated `GET /api/models` endpoint. The request may include a query of at most 200 characters, a result limit no greater than 50, and the expected active Session id. A stale Session id fails with `409 SESSION_CHANGED`.

`WebRuntimeController.searchModels()` is a required runtime contract; Web Host has no optional unbounded fallback. The runtime searches provider, model id, name, and label in Pi's complete available-model snapshot through one shared projector. Results remain bounded by both the requested count and a 64 KiB response budget. The response reports `totalAvailable`, `totalMatches`, and `truncation.matchesOmitted`, while `truncation.bytes` equals the complete serialized response including totals and truncation metadata.

Provider and model id remain exact canonical selection identities and are never shortened into display strings. Only model name and label are bounded display projections. A model whose exact identity cannot fit in the response budget is omitted with truncation evidence rather than returned under a mutated identity. Selection sends the exact provider, model id, and active Session id through the existing model mutation path.

The model picker exposes search only when `modelsOmitted` is positive. It waits 250 ms after the latest input, cancels superseded requests, and rejects responses from older queries, snapshots, or Session/workspace epochs. Every accepted snapshot and `runtime_changed` event invalidates retained search results. If the picker remains open with a query, the new snapshot generation triggers one new debounced search. Waiting, empty, truncated-result, and error states are separate browser projections. Closing the picker or clearing the query cancels pending search work and restores the bounded snapshot list. An ordinary complete model list keeps the simpler selector without a search field.

## Review correction

The initial implementation at `bcfa2d73a8ae0b307018fe92b9325f1966839947` did not satisfy all invariants stated by this record. Its optional Host fallback did not enforce the byte budget, canonical provider/model identities were truncated to display bounds, byte evidence excluded response metadata, and search results survived same-Session catalog refreshes. PR #521 review identified these gaps. The source boundary above names the corrective implementation; the earlier commit is retained here as historical provenance, not as validated evidence.

## Evidence and limits

The adapter fixture projects 1,000 synthetic models into a 250-model snapshot, retains the current model, reports 750 omitted models, and stays inside the snapshot-byte bound. Runtime and Host tests cover the required search contract, full-catalog matching, exact long identities, result-count bounds, complete-response byte accounting, invalid limits, oversized queries, and stale Session rejection. Store and component tests cover debounce timing, cancellation, out-of-order responses, workspace and snapshot-generation changes, automatic re-query, empty results, errors, and exact model identity.

The production-WebHost Playwright scenario provides 250 visible synthetic models and one search-only model. It verifies the truncation message, bounded Session-scoped request, absence of the hidden model before search, and exact selection of that model afterward. The browser scenario intercepts deterministic model API responses; it is not a claim that a real provider account with 251 configured models was exercised. The adapter, runtime, Host, store, component, and browser tests form the complete evidence chain.

At the corrected source boundary, `bun run check` passed; `bun run test` reported 1,528 Node tests passed, zero failed, and one Windows-only test skipped, plus 138 Vitest tests passed; the final complete `bun run test:web:e2e` rerun reported 12 passed. An earlier complete E2E attempt hit an unrelated timeout inside the trajectory view's axe analysis; that test then passed alone in 1.8 seconds and in the final complete rerun.
