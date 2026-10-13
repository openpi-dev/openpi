# Web Configuration reference and state matrix

- Status: validated at the named static-source, local Pi request and browser-fixture boundaries; Codex runtime and remote-provider acceptance remain unknown.
- Created: 2026-10-13; verified: 2026-10-13 at the boundaries recorded below.
- Source Issue: [#754](https://github.com/openpi-dev/openpi/issues/754).
- Baseline: [PR #711](https://github.com/openpi-dev/openpi/pull/711), `d526ec8d852c5582d713bae2182f178be7b6b4b6`.
- Supersedes: none. This research record does not adopt a new runtime or permission constraint.
- Local evidence archive: `configuration-settings-20261013`; packaged assets, member hashes, REA receipts and browser captures stay outside Git.

## Source boundary and observations

The supplied screenshots identify the existing OpenPI settings shell and Codex's Configuration page. The selected desktop artifact is `com.openai.codex` 26.1002.52244, build 13536. Its bundled CLI reports 0.162.0-alpha.2; the binary contains the official tag's commit `74e804deeb1241d5fe699b31fb319f7d46454c42`. The binary SHA-256 is `cb4e4994627e770800a940b42969c77855a3fc09a6e60b02aa6319f670d6b6ab`.

REA initially rejected the complete ASAR because an unpacked native `permissions.node` disagreed with its declared hash. A record-and-continue whole-package pass was cancelled; it produced no retained result. This does not establish a complete analysis of the desktop package. A separate exact-member extraction verifies the declared hashes of the configuration entry and its direct imports. Three large shared chunks are inspected separately as inert source, rather than claiming they were covered by the small REA graph.

REA parent `ev_1d60d6369b915cf0dd2dac5a3ce8a632a568b7976d4d45f833f10bed7e01f9b6` covers 22 extracted files / 226,432 bytes. Its summary `ev_62e83f384d27ad8c1b09df8677656ddb58cb85c0b364c8ff1ec76d2cbd17ac1a` is **complete within that summary view**, while application and semantic coverage remain partial. The TOML parser exceeded its worker heap; two unrelated dialog modules exceeded the aggregate semantic-result budget. A literal `model_verbosity` graph trace found no graph match, despite the actual source containing the setting; this negative is not evidence of absence. Source AST inspection supplies the exact declarations and import/export identities below.

### Feature chains

| Feature | Entry, component and conditions | Event and persistence |
| --- | --- | --- |
| Configuration navigation | The `agent` route lazily loads `ConfigurationPanel` from `configuration-panel-b3d1af7d2342.js`; `Tr` selects Codex/Work and `Qn` renders the configuration sections. | `rr` reads config layers, origins and requirements for the selected host/workspace; user/project/admin scope changes select a source without writing. |
| Five configuration rows | `rr` derives values from the selected layer, then merged config; `ir` renders the common row and right-aligned menu. Managed origin, no writable scope, unsupported options and in-flight writes disable controls. | `Ke` prevents a duplicate write per row and captures errors. The shared mutation serializes writes, uses `config/value/write` with file/version, and re-reads/invalidate queries after success. Project writes use the desktop's TOML edit/save boundary. |
| Appearance | Shared `fLi` is the actual label/description/control row: 16px horizontal inset, 12px vertical spacing, split flex layout. `DLi` supplies the 16px rounded bordered group and internal dividers. `p7` supplies the menu, focus and dismissal plumbing. | These are static class/handler observations. Exact rendered colors, transition timing and pointer behavior are unobserved. |
| Reasoning choices | `Gn` renders a checkbox menu of available reasoning efforts. `Hli` changes the hidden desktop preference `enabled-reasoning-efforts`; this is distinct from model capability and active effort. | The model-control builder filters the native catalog. Disabling max/ultra can also reset Codex's future default; OpenPI will preserve its current Session setting instead. |
| Workspace dependencies | `tr` uses the desktop `primaryRuntime` adapter; it tracks loading, diagnostic, install/update/reset/cancel and failure receipts. | `diagnoseDependencies`, `runUpdateNow` and `resetDependencies` belong to that adapter. The open-source feature flag alone does not supply these mechanisms to Pi. |

The same-version app-server confirms [configuration RPCs](https://github.com/openai/codex/blob/74e804deeb1241d5fe699b31fb319f7d46454c42/codex-rs/app-server-protocol/src/protocol/v2/config.rs), [validation and file/version boundaries](https://github.com/openai/codex/blob/74e804deeb1241d5fe699b31fb319f7d46454c42/codex-rs/app-server/src/config_manager_service.rs), [TOML replacement](https://github.com/openai/codex/blob/74e804deeb1241d5fe699b31fb319f7d46454c42/codex-rs/core/src/config/edit.rs) and [partial runtime refresh](https://github.com/openai/codex/blob/74e804deeb1241d5fe699b31fb319f7d46454c42/codex-rs/core/src/config/runtime_refresh.rs). A successful file write can be overridden by another layer, and a successful write does not prove every existing Session setting was refreshed.

Desktop UI interaction was unavailable because the UI tool denies access to `com.openai.codex`. No alternate UI access was attempted. Codex hover/focus pixels, menu keyboard behavior, animation, actual cancel/error rendering and refresh transitions remain **unknown at runtime**. The supplied screenshot proves only its visible ordinary state.

## Implementation scope and Pi ownership

Add one Configuration tab inside the existing settings shell. Use grouped, rounded rows with subdued descriptions and compact right-hand controls. Preserve the other pages.

| Codex item | OpenPI behavior for this iteration | Owner and default |
| --- | --- | --- |
| Approval policy | Show the Pi extension permission boundary; no fictitious global approval selector. | Pi tools and extension review; no new permission setting. |
| Sandbox | State that no OS sandbox is supplied. Do not rename Plan mode, a worktree or a child tool list as a sandbox. | Existing runtime invariants; no new sandbox setting. |
| Web search | Reuse the canonical current-model search preference and actual support status. Cached/indexed modes have no Pi equivalent. | Existing `webSearch.enabled`, default off; setup episode. |
| Output verbosity | Optional default/low/medium/high override at Pi's native provider request hook, limited to Responses payloads. | Canonical `response.verbosity`, default `default` leaves Pi's payload unchanged. |
| Reasoning summary | Optional default/auto/concise/detailed/none override on an existing native reasoning request; none removes summary only. | Canonical `response.reasoningSummary`, default `default` leaves Pi's payload unchanged. |
| Visible reasoning levels | A presentation filter over Pi's supported levels. Preserve native order, capabilities and current Session effort. Keep a current hidden level visible for accurate state. | Canonical `ui.webHiddenThinkingLevels`, default empty; shared presentation writer. |
| Workspace dependencies | Show environment ownership and open the existing runtime status view. No pretend bundled-runtime toggle, installer or repair action. | Existing environment and Pi runtime. |

The runtime owns validation, provider/API boundaries, authoritative write receipts and recovery. The model interprets non-presentation setup requests through the existing episode. No new provider client, tool, credential store, settings store, keyword parser or orchestration workflow is introduced. Better models can use the same orthogonal request parameters without a framework change.

## Pre-implementation state matrix

This matrix was recorded before implementation. Tests use these transitions as the acceptance source; they must not infer success from a newly written component's local state.

| ID | State | Required OpenPI result | Evidence / validation |
| --- | --- | --- | --- |
| C01 | Loading / ordinary | Keep loading and failure distinct from confirmed defaults. Render one Configuration tab, existing shell and grouped rows. | Source/screenshot reference; component loading test. |
| C02 | Hover | Row controls remain legible in light/dark themes; no navigation or mutation on hover. | Codex runtime unknown; OpenPI browser observation required. |
| C03 | Focus | Tab navigation, control labels and visible focus work by keyboard; mobile has the same page entry. | Existing shell contract; component and browser checks. |
| C04 | Menu open | Show the canonical selected value and native reasoning order; open/close alone sends no write. | Static menu chain; component/browser checks. |
| C05 | Expanded / collapsed | Reasoning checkbox disclosure reports its open state, closes with Escape/outside interaction and preserves focused control. | Codex runtime unknown; explicit OpenPI interaction tests. |
| C06 | Setup admitted / pending | A submitted response/search request is not labelled saved. Disable duplicate changes; canonical values change only after the real receipt/catalog refresh. | Existing setup lifecycle, success and pending component cases. |
| C07 | Cancelled / dismissed | Menu dismissal does not write. A cancelled setup retains saved values and reports cancellation through the existing receipt. | UI and setup-receipt tests. |
| C08 | Failure / retry | A failed presentation save retains the previous canonical filter and displays an error. Setup errors/cancellation retain canonical response values. Retry remains possible. | Persistence and component failure tests. |
| C09 | Refresh / reopen | Reload from the canonical setup file and native Session; no competing localStorage preference. Hidden levels still preserve the current native value. | Writer, catalog, picker and browser recovery checks. |
| C10 | Unsupported / restricted | No editable approval/sandbox/installer claim. Provider overrides do not mutate unsupported APIs or a request without native reasoning. | Actual hook payload tests and UI capability text. |
| C11 | Request composition | Defaults return no override; supported changes preserve tools, inputs, reasoning effort and unrelated text fields. `none` removes only summary. | Pi hook test with real event boundary and shaped native payloads. |
| C12 | Session/model switch | Late catalog responses cannot overwrite another Session. Reasoning display filters never widen native availability or change current effort. | Existing abort/identity contract plus picker regressions. |

## Validation results and limitations

### Source and runtime identity

Initial implementation and validation used an uncommitted change on `codex/configuration-settings` in `/Users/admin/.codex/worktrees/configuration-settings/openpi`, based on the PR #711 commit above. Node.js 24.20.0, Bun 1.3.14 and the worktree's Pi 0.99.1 dependencies were used. An isolated `PI_CODING_AGENT_DIR` reports this absolute worktree as its sole OpenPI source through `pi list`. The original checkout and the installed Web runtime were not modified. Subsequent PR integration is recorded below without widening the initial evidence boundary.

The local archive is `/Users/admin/Documents/ChatGPT/openpi-evidence/configuration-settings-20261013`. `manifest.json` identifies the final patch, source receipts, validation logs and captures by SHA-256. The 666,270,512-byte `rea-evidence.json` stays in that archive, alongside the exact-member extraction receipt. Its exported top-level unknown list is empty; this does not erase the parent's 9,057 semantic unknowns or widen its partial coverage.

### Results against the frozen matrix

| Boundary | Validated result | Retained evidence |
| --- | --- | --- |
| Repository gates | `bun run check` passes configuration/docs contracts, discipline checks, browser build, formatting, lint and both TypeScript projects. The configuration contract covers 32 persisted fields. | `check-final.log` |
| Full tests | `bun run test` passes: 2,381 Node tests passed, 9 skipped, zero failed; 1,296 UI tests passed across 87 files. | `test-isolated-final.log` |
| C01, C06-C10, C12 component states | Loading and unreadable configuration cannot appear as saved defaults; accepted requests remain pending after a timer/catalog refresh; failed/cancelled/unconfirmed receipts take priority over unrelated display-save feedback; late old-model catalogs are rejected. | `tests/web/provider-settings-page.spec.ts`, included in the full suite |
| C02-C09 browser states | Four Configuration cases and four existing settings-parity cases pass in Chrome 154: hover, keyboard focus, menu selection/order, Escape/outside dismissal without writes, light/dark/narrow layouts, pending receipt, failed persistence, retry and reload. Axe reports no violations in the inspected settings dialog. | `browser-final.log`; `browser-final/` captures |
| C12 same-model API edit | A fifth Configuration browser case switches the API while retaining provider/model ID; returning to Configuration shows the newly unsupported response controls disabled. | `browser-model-refresh-3.log` |
| C10-C11 native requests | Actual Pi Sessions load the setup extension through `DefaultResourceLoader` and send native Responses requests to a loopback HTTP/SSE fixture. Defaults, explicit preferences, reopen, native text fields, tools, inputs and reasoning effort are preserved as specified; `none` removes only summary. API/identity gates are also exercised at the registered hook. | `tests/extensions/setup/response-preferences.test.ts`; `backend-validation.md` |
| C06-C09 rejection/recovery | Malformed JSON, an invalid known value, Plan mode and an unverified writer each produce a recoverable canonical failed receipt, including after Session reopen. They start no model request/agent turn, activate no writer and preserve the original file. Presentation saves retain shared validation, locking, atomicity and unknown-field preservation. | Native Pi tests and Web-host tests in the full suite |
| Child boundary | The setup extension remains parent-only; real Pi child loading and the fail-closed tool-classification guard pass. | `tests/extensions/shared/child-session.test.ts` |

An earlier full run inherited this machine's existing Pi display preferences and failed six old footer/renderer assertions. The same three files passed all nine tests with an isolated agent directory; the final complete suite uses that isolation and passes. No user preference file was changed to make the suite pass. Initial browser-fixture failures concerned a locator and the existing provider-save envelope; both fixtures were corrected before the final C12 pass.

### Ablation

Removing the model identity from the settings-catalog owner prevented a model switch from fetching new capabilities; C12 failed. The owner includes Session and model identity again, and the passing full suite covers the restored boundary. `ablation-model-catalog-2.log` is the completed failing experiment. The earlier `ablation-model-catalog.log` restored source before test loading and is not valid ablation evidence.

Removing the provider payload/model identity guard applied current preferences to an old-model request; C12 failed. The guard was restored. `backend-validation.md` records the observed tool result and explicitly distinguishes that receipt from a raw shell log. An unnecessary simulated request hook in the native HTTP fixture was deleted; Pi's existing `samplingParams` supplies the fields instead. Redundant legend CSS and a reasoning-label translation wrapper were also deleted; the final browser run passes with those simplifications.

### Remaining limits

Browser evidence uses the worktree's built UI and isolated fixture endpoints; it does not establish a deployed server upgrade or an interactive TUI smoke. The native HTTP fixture exercises real Pi transport with ordinary tool schemas but calls no paid model. Codex Responses is checked at the Pi hook boundary; remote gateways' acceptance of every optional verbosity/summary value remains unverified. Response preferences remain parent-only, while the visible-level filter is presentation-only. Codex's actual hover/focus, animation, cancellation/error rendering and refresh transitions remain unobserved for the tool-access reason above; numerical visual parity is not claimed.

## PR #711 integration — 2026-10-13

Implementation commit `41cc796b8ffb9b22a9ec612c47274011e03da886` incorporates PR #711's newer `ad069f841cec26421834b39715af60ac9a2c1a11` compaction/reconnect change. The seven upstream-only files remain byte-identical; shared source changes merge without conflicts. Conflicts in generated `web/dist/app.js` and `styles.css` were resolved by rebuilding from the integrated source. The isolated `pi list` again reports this worktree as the sole OpenPI source.

On that integrated implementation, `bun run check` passes and the complete isolated `bun run test` passes: **2,382 Node passes, 9 skips, zero failures; 1,300 UI passes across 87 files**. All **9** installed-Chrome Configuration/settings-parity cases pass together. The earlier ablation and provider observations retain their original source boundaries; this integration does not establish remote-provider, TUI or deployed-runtime acceptance.

The same archive retains `check-pr711.log`, `test-pr711.log`, `browser-pr711.log` and the `browser-pr711/` captures. `pr711-integration-manifest.json` identifies the integrated implementation and publication receipts separately from the initial uncommitted manifest. The subsequent record-only update is checked by `check-pr711-record.log`; source and test behavior are unchanged by that update. PR #711 and Issue #754 link back to this record.
