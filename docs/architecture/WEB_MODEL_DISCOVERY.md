# Bounded Web model discovery

- Status: `validated`
- Created: 2026-09-09
- Verified: 2026-09-09
- Source boundary: implementation commit `bcfa2d73a8ae0b307018fe92b9325f1966839947`, based on `0d17f4577fe31315fe6c95370d251bdb4e2413cf`
- Affected Pi primitive: Pi's available-model snapshot and active Web Session model selection
- Related Issue: [#459](https://github.com/openpi-dev/openpi/issues/459)
- Related Decision: [0001 - documentation and evidence governance](../decisions/0001-documentation-and-evidence-governance.md)
- Supersedes: none

## Ownership

Pi remains the only source of truth for available models and the active Session model. `PiWebRuntime` reads `modelRuntime.getAvailableSnapshot()` and performs model selection through the active Pi Session. OpenPI does not persist a second model catalog, introduce a provider stack, or infer availability from browser state.

`PiWebAdapter` keeps the Web snapshot bounded to `WEB_MAX_MODELS` entries while retaining the current model. `snapshot.truncation.modelsOmitted` reports how many available models are absent after count or snapshot-byte limiting. The browser treats that value as projection evidence, not as a model total it computed locally.

## Discovery contract

When a snapshot omits models, the browser can query the authenticated `GET /api/models` endpoint. The request may include a query of at most 200 characters, a result limit no greater than 50, and the expected active Session id. A stale Session id fails with `409 SESSION_CHANGED`.

The runtime searches provider, model id, name, and label in Pi's complete available-model snapshot. Results remain bounded by both the requested count and a 64 KiB response budget. The response reports `totalAvailable`, `totalMatches`, and `truncation.matchesOmitted`, so count and byte truncation stay observable. Selection still sends the exact provider, model id, and active Session id through the existing model mutation path.

The model picker exposes search only when `modelsOmitted` is positive. It waits 250 ms after the latest input, cancels superseded requests, and rejects responses from older queries or Session/workspace epochs. Waiting, empty, truncated-result, and error states are separate browser projections. Closing the picker or clearing the query cancels pending search work and restores the bounded snapshot list. An ordinary complete model list keeps the simpler selector without a search field.

## Evidence and limits

The adapter fixture projects 1,000 synthetic models into a 250-model snapshot, retains the current model, reports 750 omitted models, and stays inside the snapshot-byte bound. Runtime and Host tests cover full-catalog matching, result-count and byte bounds, invalid limits, oversized queries, and stale Session rejection. Store and component tests cover debounce timing, cancellation, out-of-order responses, workspace changes, empty results, errors, and exact model identity.

The production-WebHost Playwright scenario provides 250 visible synthetic models and one search-only model. It verifies the truncation message, bounded Session-scoped request, absence of the hidden model before search, and exact selection of that model afterward. The browser scenario intercepts deterministic model API responses; it is not a claim that a real provider account with 251 configured models was exercised. The adapter, runtime, Host, store, component, and browser tests form the complete evidence chain.
