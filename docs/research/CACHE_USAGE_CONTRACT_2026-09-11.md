# Cache usage fields and synthetic replay boundary

- Status: validated for the named source inspection and deterministic synthetic tests only; no provider experiment or comparative Session replay.
- Created and verified: 2026-09-11.
- Source boundary: OpenPI `5bf2fe29e52801d79826c2eb573be403f53285e5` and the scoped tests accompanying this record. Pi `@earendil-works/pi-ai` 0.85.1 is locked in `bun.lock`; its [published metadata](https://registry.npmjs.org/@earendil-works/pi-ai/0.85.1) and `v0.85.1` tag identify source commit `d981de1229ef899957bbe968bc8dcda02a21f477`. The installed package's relevant compiled mappings were also inspected.
- Related: [Issue #156](https://github.com/openpi-dev/openpi/issues/156), [diagnostic core PR #372](https://github.com/openpi-dev/openpi/pull/372), and the [remaining-evidence boundary](https://github.com/openpi-dev/openpi/issues/156#issuecomment-5594640168). This record does not close #156.
- Supersedes: none. This is a new source snapshot, not a reinterpretation of the older Pi revision cited in the Issue.

## What OpenPI can observe

Pi owns provider normalization. OpenPI's existing tracker consumes normalized `Usage` from assistant `turn_end` events other than errors and aborts, when a turn identity is available; it does not inspect raw API usage or determine provider billing. The [Pi type](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/types.ts#L383) carries required numeric counters but no per-counter presence flags, cache key, expiry timestamp, or invalidation reason.

| Normalized field | Use and limitation at this source boundary |
| --- | --- |
| `input` | The adapter's uncached input component, with the provider-specific mappings below. Do not add raw `prompt_tokens` or `input_tokens` again. |
| `cacheRead` | Reported cache-read tokens after adapter normalization. A positive value supports a read observation; zero alone cannot distinguish an omitted field, unsupported reporting, or an actual zero. |
| `cacheWrite` | Reported cache-creation/write tokens where mapped. Zero is not proof that no provider-side caching happened. |
| `cacheWrite1h` | Optional subset of `cacheWrite`, populated by the inspected Anthropic path. It is not an additional prompt component and does not identify why a later read disappeared. |
| `output`, `reasoning` | Output accounting; optional `reasoning` is already a subset of `output`. Neither belongs in the prompt-cache denominator. |
| `totalTokens` | Adapter-reported or computed total. OpenPI derives prompt tokens from `input + cacheRead + cacheWrite`, not from this field. |
| `cost.*` | Pi cost accounting, not a cache-causality signal. The inspected adapters call [Pi's model-rate calculation](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/models.ts#L891); these numbers are not an independently verified invoice or proof of savings. |

## Provider/API field matrix

These are source-verified adapter assignments, not assertions that every endpoint emits every field. Optional raw counters generally default to zero. Adapter/API identity and OpenPI's provider-name classification are separate: sharing an API does not promote a provider to `explicit-prefix`.

| Pi adapter and source | `input` mapping | `cacheRead` mapping | `cacheWrite` mapping and unknown boundary |
| --- | --- | --- | --- |
| [Anthropic Messages](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/api/anthropic-messages.ts#L606) | `input_tokens` | `cache_read_input_tokens` | `cache_creation_input_tokens`; `cache_creation.ephemeral_1h_input_tokens` initializes the optional write subset. Later message deltas update the reported input/read/write counters when present. No expiry cause is supplied to OpenPI. |
| [OpenAI-compatible Completions](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/api/openai-completions.ts#L1507) | `max(0, prompt_tokens - read - write)` | First non-nullish value of `prompt_tokens_details.cached_tokens`, `prompt_cache_hit_tokens`, `cached_tokens`; otherwise zero | `prompt_tokens_details.cache_write_tokens`, default zero. Mapping a compatibility field does not establish which upstream provider performed a write. |
| [OpenAI Responses shared handler](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/api/openai-responses-shared.ts#L559) | `max(0, input_tokens - read - write)` | `input_tokens_details.cached_tokens` | `input_tokens_details.cache_write_tokens`, default zero. [Azure](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/api/azure-openai-responses.ts#L131) and [Codex](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/api/openai-codex-responses.ts#L660) also use this handler. |
| [Google Generative AI](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/api/google-generative-ai.ts#L223) | `promptTokenCount - cachedContentTokenCount` from `usageMetadata`, with absent values zero | `cachedContentTokenCount` | Always zero in this mapping. A zero write count cannot establish that caching is disabled or that creation was free. |
| [Google Vertex](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/api/google-vertex.ts#L240) | Same Google metadata subtraction | `cachedContentTokenCount` | Always zero in this mapping. Despite the similar adapter fields, `google-vertex` remains an unknown provider in OpenPI's current classifier. |
| [Bedrock Converse](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/api/bedrock-converse-stream.ts#L685) | `inputTokens` | `cacheReadInputTokens` | `cacheWriteInputTokens`. These are direct assignments; `amazon-bedrock` remains unknown to OpenPI's classifier even when its underlying model is Anthropic. |

Other adapters, custom endpoints, and account-specific billing have not been verified by this matrix. In particular, the current OpenPI name allowlist retains `google-antigravity`, `google-gemini-cli`, and `openai-responses`; their presence in that list is not evidence of a corresponding built-in provider at the pinned Pi revision.

## Existing detector contract, not a new policy

The [OpenPI classifier](../../extensions/model-info/cache-diagnostics.ts) has these provider-name boundaries:

- Only normalized `anthropic` is `explicit-prefix`.
- `azure-openai-responses`, `google`, `google-antigravity`, `google-gemini-cli`, `openai`, `openai-codex`, and `openai-responses` are `implicit-best-effort`.
- Every other name is `unknown`, including compatible proxies. This record does not expand the allowlist.

The first accepted observation is `first-turn`, even if it contains a positive read. A subsequent zero-read turn is `cold` when the previous read was below 2,048 tokens. At or above that boundary, a zero read becomes `miss-after-warm-prefix` only for `explicit-prefix`; otherwise it remains `unknown`. A positive read lower than the previous read is `partial-hit`; other positive reads are `warm`.

For `miss-after-warm-prefix`, `reprocessedTokens` is the current normalized `input`, not total prompt tokens, cache writes, or a proven count of an identical prefix processed twice. The current detector does not require `cacheWrite > 0`, unlike the OMP predicate linked in #156. Model, thinking, tool, system-prompt, compaction, and branch changes are correlations only. Every result has `evidence: "observation"` and `verifiedCause: null`.

The [extension event seam](../../extensions/model-info/index.ts) skips error/aborted replies without replacing the last accepted baseline. Compaction and branch movement add pending correlations; they do not reset that baseline. Session start and shutdown reset it. A new Session start does not reconstruct diagnostic continuity from saved history, even though the separate [active-branch metric](../../extensions/model-info/session-metrics.ts) reads persisted usage. That metric includes assistant, tool-result, compaction, and branch-summary usage; it is not the same population as diagnostic assistant turns, a whole Session tree, or all child/account costs.

The tracker normalizes non-finite or nonpositive prompt counters to zero. This is defensive arithmetic, not recovered evidence that the provider actually reported zero. Its observation input has no timestamp or retention metadata. A long delay, a read of zero, or a reported one-hour write subset therefore cannot establish `TTL expiry` as a separate verified kind.

## Reproducible synthetic evidence

The fixtures are small, hand-authored TypeScript vectors in the existing tests. They contain no user transcript, API response capture, credentials, or model invocation. They exercise the shipped tracker and extension handlers, not a reimplementation of the detector.

| Test surface | Additional assurance |
| --- | --- |
| [`cache-diagnostics.test.ts`](../../tests/extensions/model-info/cache-diagnostics.test.ts) | Six observations for each of the seven implicit names and four unknown examples retain unknown/cold/partial-hit boundaries, even with positive write counters. Exact 2,047/2,048 threshold, prompt-component arithmetic, excluded subsets, immutable input, and malformed-number handling are checked separately. |
| [`index.test.ts`](../../tests/extensions/model-info/index.test.ts) | Seven-turn event replay combines warm/cold transitions, repeated compaction marks, partial reads, tool/system changes, a branch move, and a one-day synthetic timestamp gap. Correlations are consumed once and never become a verified cause. Restart coverage keeps persisted aggregate usage separate from a fresh live baseline. Existing error/aborted tests cover skipped replies. |
| [`session-metrics.test.ts`](../../tests/extensions/model-info/session-metrics.test.ts) | Existing regressions separately retain active-branch usage from assistant/tool/compaction/branch-summary entries and branch changes. |

Run from the checkout with the repository-supported Node version:

```sh
node --test --experimental-strip-types tests/extensions/model-info/cache-diagnostics.test.ts tests/extensions/model-info/index.test.ts tests/extensions/model-info/session-metrics.test.ts
```

The focused run passed 39 tests (23 pre-existing, 16 added). Repository-wide `bun run check` and `bun run test` receipts belong to the accompanying PR. The synthetic cases show deterministic contracts only: they measure neither provider false-positive/false-negative rates nor cache cost or latency.

## Still required for #156

No genuine OpenPI / Bare Pi / OMP Session set was collected or replayed here. A future comparison needs independently retrievable, privacy-reviewed evidence with each checkout/package identity, actual loaded OpenPI source (`pi list`), Pi version, provider/API/model identity, task and verifier identity, normalized usage, failures, and relevant lifecycle boundaries. Keep source facts, correlations, and any provider-confirmed cause distinct. A saved Session may not contain the tool/system fingerprints needed to reconstruct every live correlation; absence must remain unknown rather than being filled in from the current environment.

Preserve raw Sessions outside Git under stable evidence identities and publish only authorized bounded receipts. Do not treat synthetic timestamps as TTL evidence or label an invented trace as a real OpenPI/Bare Pi/OMP run. The real comparative replay, any separately evidenced TTL classification, and the acceptance gate before opt-in UI remain open. There is no new UI, command, model-visible context, provider behavior, or persisted configuration in this contribution.
