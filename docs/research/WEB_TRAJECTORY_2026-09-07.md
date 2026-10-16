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

## Deferred and unknown

A full request inspector needs a separately bounded native capture after mutable handlers, with explicit source identity and handling of sensitive context. Historical full requests cannot be reconstructed reliably from this Web projection. Real model usage and realtime tool duration could be added through Pi's native message/event seams; unknown values must remain unknown. No claim is made about final wire payload, complete context, historical tool duration, or end-to-end performance.

## Oct12 follow-up: quieter record browsing

- Tracking: [Issue #446](https://github.com/openpi-dev/openpi/issues/446), [workbench follow-up #597](https://github.com/openpi-dev/openpi/issues/597), [PR #711](https://github.com/openpi-dev/openpi/pull/711).
- Reference inspected: DeepSeek Harness `d743267388641bc76f17c45ce8b4c231aed1d32c`, its [trajectory toolbar](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/ui-trajectory/src/client/TrajectoryToolbar.tsx), [trajectory view](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/ui-trajectory/src/client/TrajectoryView.tsx) and [official screenshot](https://www.deepseek.com/harness/images/feat-trace-en.webp). The screenshot and source were inspected; the upstream application was not run. No upstream source or artwork was copied.

The accepted direction retains the compact ledger and selected-evidence inspector, then adapts them to OpenPI's quiet outline icons, rounded selection and input surfaces, existing theme tokens and workbench hierarchy. A Lightbulb identifies returned thinking in both Chat and Trajectory. The old numbered circles, duplicate page heading and outer inspector frame are removed. Tools expose Overview / Input / Result; ordinary messages have no duplicate content tabs. The view responds to the conversation panel's actual width, so a desktop with another pane can use the same stacked layout as a narrow viewport.

Reading groups begin at native user records. Only contiguous metadata records fold together, in place. Known event titles are localized while the exact native type remains inspectable. Search filters within the original groups and includes raw arguments even when a row's compact preview shows only a command or path. Selection and a tool's chosen tab survive saved-record append. No heuristic pairs a tool result: the existing unique matching ID/name and forward-position boundary remains unchanged. Timestamps are labelled as record timestamps, and absent or ambiguous receipts remain unknown even during active execution.

Ablation removes the unlabeled miniature sequence rail, its duplicate selection controls and their styling, plus identical Overview / Content tabs on ordinary messages. The ledger retains all record selection, metadata disclosure, paging and exact evidence, with fewer controls and more room for content. Temporarily grouping only filtered matches fails the native-boundary regression: two distinct user groups become one. Restoring grouping before filtering restores all 19 focused passes. The metadata's record reference identifies a projected row (entry ID plus part suffix for a tool); the exact native tool-call ID and record timestamp are retained separately.

Validation: `bun run check` and complete `VITEST_MAX_WORKERS=2 bun run test` pass: 2,374 Node passes, nine platform skips, zero failures; 1,287 UI passes across 87 files. Six installed-Chrome regressions pass, covering desktop and touch thinking marks/disclosures, bounded paging, literal hostile-text rendering, metadata inspection, tool tabs and keyboard navigation, search, light/dark themes, 1440px and 900px desktop layouts and 390px mobile. Narrow-panel checks assert stacking independently of the viewport breakpoint. Scoped Axe checks report no violations. An initial browser run caught a heading-level gap after removing the duplicate title; the corrected hierarchy passes. Existing bundle-size and JSDOM capability notices remain.

The actual 30142 page was reloaded against the built frontend and its existing native saved Session. Served JavaScript/CSS hashes match the build; the profile's `pi list` reports the checkout as its sole OpenPI source. Five configuration-file hashes and three Session-file hashes match the previous receipt. The backend retains its earlier startup boundary: this display follow-up adds no backend restart, provider request or upload. Native-format browser fixtures and this installed-frontend receipt are distinct from live provider acceptance. Full logs, source/build/served hashes, ablation results and labelled screenshots remain outside Git in the private task archive `trajectory-polish-20261012`; new-head CI, provider acceptance and execution-duration claims are not made.
