# Pi browser tools and OpenPI embedded pages

- Status: validated local investigation and browser adapter; not an accepted Decision or deployment receipt
- Created: 2026-10-09
- Verified: 2026-10-09
- Source: OpenPI `3cb2ecfe1bfbb98252651885311d309f83749428`, its frozen Pi `0.99.1` dependencies, and installed `@injaneity/pi-computer-use` `0.5.1`
- Issues: [#169](https://github.com/openpi-dev/openpi/issues/169), [#597](https://github.com/openpi-dev/openpi/issues/597)
- Related PR: draft browser adaptation on `codex/browser-tools-probe`; initial investigation made no runtime implementation change
- Supersedes: none; complements the [native iframe trial](WEB_BROWSER_VIDEO_TRIAL_2026-09-28.md)
- Evidence: local archive `/Users/admin/Documents/ChatGPT/openpi-evidence/browser-tools-20261009`; raw observations, images, and isolated agent data remain outside Git

## Question and verified facts

The initial observations below apply to OpenPI `3cb2ecfe` before the follow-up adapter. They are retained as the original package/iframe boundary result.

The user asked whether Pi offers browser tools for reading, clicking, input, and screenshots, and whether those tools can operate the existing OpenPI browser panel. Reconnection presentation is a separate request and was excluded from this investigation.

Pi `0.99.1`'s ordinary built-in tool inventory has no browser automation tool. Its native package loader can register external browser tools. The installed [pi-computer-use package](https://github.com/injaneity/pi-computer-use) provides `find_roots`, `observe_ui`, `search_ui`, `act_ui`, `read_text`, `launch_browser`, `navigate_browser`, and `evaluate_browser`, among other tools. This is a capability alternative, not the same tool implementation shown in the user's Codex screenshots.

OpenPI Web calls Pi's `createAgentSessionServices` and native resource loader. In an isolated Web agent directory, installing no new package and configuring the already installed package by its absolute path made those tools available and executable through the native Session. No OpenPI tool adapter was necessary.

The deployed Web process uses its own agent directory. Its `pi list` reported only its OpenPI checkout at revision `eac5066978f9266be5d8d9c54a72465542f5ed64`; it did not include the computer-use package installed in the separate global Pi directory. Global installation therefore does not establish availability in that Web process.

The existing browser panel is a native iframe. Its optional Chrome/Edge Browser Bridge handles navigation, titles, popups, and limited XFO changes. It does not expose model tools for reading, clicking, typing, or capturing the embedded document. See [`web/browser-extension/README.md`](../../web/browser-extension/README.md), [`BrowserPanel.tsx`](../../web/ui/src/features/workbar/BrowserPanel.tsx), and [`pi-runtime.ts`](../../web/runtime/pi-runtime.ts).

## Local execution evidence

The probe loaded the current checkout as the single OpenPI source, confirmed by `scripts/provenance.mjs` and `pi list`. It used a fresh agent directory, local fixture pages, a separate temporary Chrome profile, and directly invoked the registered Session tools. It made no model calls and did not change the deployed Web agent's packages or preferences.

| Boundary | Observed result |
| --- | --- |
| External tools in the OpenPI Web Session | Passed native registration and execution. |
| Package-managed standalone Chrome page | Passed page read, exact Chinese input, and save-button activation. The page's resulting value and output were checked. |
| Embedded iframe through the top-page CDP observation | Failed input discovery. The observation omitted the fixture input; `search_ui` attempted desktop recovery and threw `No current controlled window`. |
| Native Chrome window screenshot | Returned an image of the actual OpenPI window and embedded fixture. |
| Native semantic targets in that window | No editable fixture target was exposed. The match was an OCR-bearing group without input actions. |
| Screenshot-grounded native input | Failed the exact-value verifier: requested `面板工具中文输入`, observed `22面板工具中文输入`. The provider reported an `unknown` execution outcome. Button completion was not established. |

These results establish usable external browser tools and an incomplete embedded-panel path at the named versions. They do not establish that every external browser provider fails on iframes, or that desktop input is generally broken. The screenshot-grounded native path is not an accepted replacement for direct frame control.

The initial UI preparation run used an ambiguous selector shared by two buttons. The selector was corrected before the embedded-page observations above. That harness failure is retained separately and is not a product result.

Evidence includes `provenance.txt`, `source-identities.json`, the probe source `smoke.mjs`, and numbered tool arguments/results in `panel-run3/` and `panel-run4/`. `panel-run4/report.json` contains the final stage classifications. Native screenshots and the independent verifier's panel screenshot are retained beside the report. Earlier failed runs remain intact. The probe's final successful process exit describes completion of the investigation, not success of every stage.

## Interpretation, recommendation, and limits

The missing tools in the deployed Web Session are explained by its separate package configuration. The iframe failure is a different boundary: loading the package does not give its top-page CDP observation a frame-specific target.

The recommended integration seam remains Pi's package/MCP tool loading. For reliable operation of the existing embedded panel, a provider must identify the intended frame and support operations on that frame. Reusing the existing Browser Bridge is one candidate to investigate; this record does not select it or adopt a new OpenPI tool. A design must establish native Session and controlling-tab ownership, bounded requests/results, cancellation, frame closure, and exact operation evidence before implementation.

The simplification experiment used the existing native loader and provider tools with no new OpenPI browser manager, tool wrapper, or routing layer. Standalone browser acceptance still passed, so those additional mechanisms are unnecessary for that route. Embedded acceptance still failed, so that result must not be extended to the panel route.

The probe did not validate a real model turn, child authority, concurrent Sessions, replay, provider cancellation, browser-process cleanup, or other operating systems. No current Web deployment was enabled or restarted. No Codex tool implementation was ported. These remain separate validation boundaries for any later integration.

## Follow-up: embedded adapter, 2026-10-09

The user subsequently requested a pi-computer-use adaptation for the actual embedded browser. The locally validated implementation is OpenPI `4163abb38c06c966fe23e263e82305a1eedc71cb`, including upstream main `a18f457687b45c877bc8a15d689a7580c4f0659a`, frozen Pi `0.99.1`, and Chrome `154.0.8037.98` on macOS. This changes the embedded route; it does not change the earlier standalone-package findings.

At version `0.5.1`, pi-computer-use has no injectable transport for OpenPI's bound iframe. The adapter therefore ports its small CDP element resolve/click/text/scroll pattern under MIT into the existing Browser Bridge. It does not load the complete package or redirect its desktop and managed-Chrome tools. The original notice is retained in [`LICENSE.pi-computer-use`](../../web/browser-extension/LICENSE.pi-computer-use) and [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md).

Pi owns the model tool and Session. `/openpi-setup` applies the default-off `browser.control` preference and exposes one `openpi_browser` tool after explicit enablement. It offers `tabs`, `open`, `observe`, `act`, and `navigate`; actions are `press`, `setText`, `typeText`, and `scroll`. Clicks and text require observation refs. The native Browser Bridge 0.2.0 separately owns Chrome's reviewed `debugger` permission. No desktop helper, additional browser server, standalone native tab, or separate agent runtime is needed.

The existing authenticated Web connection carries a bounded request to the initiating controller. The existing native extension port identifies the Chrome tab and bound document. CDP resolves that exact iframe and uses its isolated context; cross-process frames use Chrome's flattened child-target sessions. Element calls also require their owner document to equal that context's document. Observation authority is ephemeral and scoped to Session, turn, controller and document. A write consumes its state even if delivery is interrupted. The tool is excluded from children, and unknown tools remain blocked by the existing Plan guard.

The mechanism leaves strategy to the model. Runtime responsibilities are request/result limits, owner checks, one pending operation, timeout, cancellation, state consumption and debugger cleanup. Navigating returns a dispatch receipt; a fresh observation must establish what actually loaded. Page text remains untrusted model input.

### Validated boundaries

| Boundary | Evidence |
| --- | --- |
| Native Pi model surface | Tool absent by default; setup apply exposes it; disabling removes it. An unbound Session fails explicitly. |
| Controller and turn authority | Sibling-controller results, replay and stale refs rejected; document/turn changes, timeout and host closure revoke pending requests. |
| Embedded operations | Native Session tool reads AX/text, returns an actual iframe PNG, sets exact Chinese text and activates the save button. Independent DOM values/output verify effects. |
| Internal page lifecycle | `open` creates a second internal page; same-process and cross-process roots remain distinct. Navigation consumes old state. Chrome retains one top-level workbench tab. |
| Native screenshot | PNG decoded independently; fixture pixels at both bottom corners exclude the surrounding workbench. Three consecutive native regressions passed. |
| Cancellation | A page-local signal cancels during a slow cross-process action; the following input step does not execute. The Session signal/real Web polling path also passes in the isolated harness. Previously dispatched effects are not claimed to be undone. |
| Cleanup | After normal operations and cancellation, extension-scoped `chrome.debugger.sendCommand` rejects with `Debugger is not attached`. The native workbench, rather than Playwright's separate connection, owns this check. |
| Existing enhancement | Installed bridge navigation, popup handling, XFO scope and cleanup regression passes. |

`bun run check` passed. The complete test run on the updated main passed 2,320 Node tests (nine skipped) and 1,158 UI tests. The targeted native-browser run passed both the new embedded provider and the existing installed-enhancement test. Broker and tool-surface tests are separate from the independent browser-effect verifiers.

Final native receipts are in `adaptation-run11/`: `manifest.json` freezes the clean checkout, per-file identities and the copied verifier `embedded-adapter-smoke.frozen.mjs`; `provenance.txt` proves that checkout and the single OpenPI source reported by `pi list`. Numbered tool records, `report.json`, actual screenshots and `debugger-cleanup.txt` retain the results. `adapter-e2e12.log` records the independent native regression. All are under the local archive named above. Model calls and token usage are zero; the harness directly invokes native Pi tools with a simulated active Web turn/controller admission.

### Simplification and limitations

Removing child-target binding made the cross-process frame fail with `No frame for given id found` (`adaptation-run5`), so that transport remains. A second browser manager, desktop helper, provider stack and additional WebSocket server were unnecessary. An intermediate bitmap/canvas cropping path was removed: Chrome now captures the explicit visible iframe clip after a paint boundary.

The native screenshot verifier initially failed when a second CDP client emulated a viewport, and an immediate capture could race Chrome's debugger-induced layout change. The final protocol uses a real native window, waits for paint, and keeps the pixel verifier. The first cancellation verifier injected a late Playwright command and did not prevent a later input; the final verifier sends cancellation inside the actual parent page when the slow frame reports entry. These failed and revised runs remain in the archive; they are not counted as successful acceptance.

This is local integration validation, not a formal Benchmark, real model/provider acceptance or a release claim. Concurrent independent Web Sessions, Edge/other platforms, nested frame control and arbitrary website compatibility remain unvalidated. CSP and authentication policies still apply. The deployed Web source and browser permissions were not changed, and reconnection presentation remains outside this work.
