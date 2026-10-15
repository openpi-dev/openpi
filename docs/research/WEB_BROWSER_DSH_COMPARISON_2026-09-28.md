# Web browser interaction comparison with DSH

- Status: validated at the frozen-source and local mechanism-observation boundaries below; adoption remains a recommendation
- Created: 2026-09-28
- Verified: 2026-09-28
- Source boundary: OpenPI PR #598 at `e526d11d22b1c7eaa35656b1c369b53766102d09`; DSH-better-sidebar `9b5834f74ad197534c821c35b8357edac1ad3919` (0.22.1); DSH `dsh-v0.1.7-rc.1`, `46a7f68b0922371ce7144b668b90e377d8e799f4`
- Issue: [#597](https://github.com/openpi-dev/openpi/issues/597)
- PR: [#598](https://github.com/openpi-dev/openpi/pull/598)
- Supersedes: none; supplements [committed text input](WEB_BROWSER_TEXT_INPUT_2026-09-27.md)
- Publication: local investigation only; the Issue backlink remains pending publication

## Question and scope

### Implementation follow-up

The later hands-on WebRTC trial was rejected by the user for interaction latency. At the user's request, the browser now uses the native iframe mechanism with local tabs, replacing the CDP/PNG transport and input proxy. [The trial and replacement record](WEB_BROWSER_VIDEO_TRIAL_2026-09-28.md) records the separate deployed failure, implementation, limitations, validation and simplification. The source observations and recommendations below remain historical at their named revisions; statements about an unchanged product describe that earlier investigation only. The current PR removes the superseded browser focus/text machinery and its dedicated tests, retaining unrelated Session, terminal and result-reading changes. Google embedding experiments remain outside this implementation.

The user asks whether OpenPI's browser feels as smooth as DSH-better-sidebar and whether its better mechanism should be reused. The product scope is Web only. Electron's native webview is therefore excluded from the adoption recommendation. This record adds no implementation or accepted architectural constraint.

## Verified source facts

The sidebar's [package manifest](https://github.com/omdsh-dev/DSH-better-sidebar/blob/9b5834f74ad197534c821c35b8357edac1ad3919/package.json) declares React 18, React DOM and TypeScript, DSH/Cordis host services, CodeMirror 6, Mermaid 11, DOMPurify, tsdown, Vitest and Playwright. The actual browser host uses React/TypeScript toolbar UI, CSS Modules and a native iframe on Web. CodeMirror and Mermaid serve other workbench features; they are not responsible for browser input or rendering smoothness.

[DSH-better-sidebar's README](https://github.com/omdsh-dev/DSH-better-sidebar/blob/9b5834f74ad197534c821c35b8357edac1ad3919/README.md) delegates browser views to the host's `ui-sidebar-browser`. Installing that sidebar plugin in OpenPI would not supply a standalone browser component: it depends on DSH's native tab, service and lifecycle APIs.

[DSH's browser reference](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/client/ui-sidebar-browser/README.md) distinguishes Web iframe rendering from Desktop Electron webview rendering. The Web package is shipped but disabled by default and can be enabled through its profile patch. Web keeps application-known navigation history; it does not claim readable cross-origin browser history.

[IframePresentation](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/client/ui-sidebar-browser/src/client/view/IframePresentation.ts) creates a real iframe with `referrerPolicy=no-referrer` and `sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"`. Pointer, text and scroll input goes directly to the embedded document. It does not encode page frames or forward each keystroke through an HTTP/CDP round trip. This is an ordinary Web primitive, not a proprietary rendering engine.

[IframeImpl](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/client/ui-sidebar-browser/src/client/browser/IframeImpl.ts) and its navigation owner mark later iframe loads as unknown-address navigation. The toolbar then disables actions that would pretend to know the current URL. History API and fragment changes without an iframe load remain unobservable to the cross-origin parent. Sites can forbid framing through their own response policy; the package does not remove that policy.

OpenPI's current `web/host/embedded-browser.ts` owns one standalone Chromium page, streams PNG frames, serializes input and navigation, and disposes the page when the controlling Session changes. `EmbeddedBrowserPanel.tsx` decodes the latest frame and forwards physical input, with a separate committed-text proxy for known editable targets. Pointer movement and wheel deltas already coalesce; hidden panels stop subscribing to frames. This is materially better than a naive screenshot poller, but remains an indirect interaction path.

Current concrete gaps include fixed native `clickCount: 1`, no remote copy/cut-to-host clipboard bridge, no projection of the remote cursor, and incomplete native IME semantics. New-window requests navigate the current page; script dialogs are dismissed and file chooser handling attempts cancellation. The last items are source observations, not independently verified live behaviors in this investigation.

## Local observations

Runtime provenance was checked before observations: the isolated test server printed the exact OpenPI revision above and one matching absolute OpenPI path from `pi list`, with `Provenance match: yes`. The user's global configuration points to another source and was not changed. Node 24 was selected because the default shell's Node 20 cannot run the installed Pi CLI.

The existing real embedded-Chromium E2E test passed. An external, bounded diagnostic then used the actual OpenPI Workbench, HTTP browser API, native Chromium and decoded UI images at a 1440 × 900 host viewport, with Chrome `153.0.8010.54`. No model or provider calls were made. Synthetic input is not evidence of a physical OS IME candidate window.

| Interaction | OpenPI actual browser path | DSH Web iframe mechanism reproduced in a separate-origin fixture |
| --- | --- | --- |
| Double-click `alpha beta gamma` | Two clicks with detail 1; no word selection or `dblclick` | `alpha` selected and a `dblclick` emitted |
| Select all then macOS `Cmd+C` | No remote `copy` event | Remote `copy` event carries the full selection |
| Fast English plus `你好😀` | Complete value received | Complete value received |
| Wheel sequence | Final scroll equals the sum of actual host wheel deltas at both display scales | Native document input; not independently timed |
| Cross-origin link navigation | Native Chromium can read its own URL/history | The parent cannot read the final URL (`SecurityError`) |
| Fixture with `X-Frame-Options: DENY` | Not separately measured in this diagnostic | Framing rejected with a browser console error |

The iframe fixture reproduces the frozen DSH Web attributes and tests the underlying browser mechanism. It is not a running DSH installation, and cannot establish complete DSH UI parity, production-site compatibility or relative product latency.

For a three-second simple moving-square fixture, the remote page generated 181 animation callbacks at each scale. OpenPI displayed 134 decoded-image source changes at DPR 1 and 139 at DPR 2, spanning about 3.00 seconds each. Observed p95 source-change gaps were 35.7 ms and 58.2 ms; maximum gaps were 100.2 ms and 136.3 ms. These are small local diagnostic samples, not display-presentation FPS, input-to-photon latency or a formal performance Benchmark. The viewport was only 519 × 807 CSS pixels. DPR 2 correctly produced 1038 × 1614 image pixels. These observations do not justify claiming that the current stream is always slow or that DSH runs at a measured 60 FPS.

Both final OpenPI diagnostic cases and both iframe mechanism cases passed. Initial diagnostic mistakes are retained: an incorrect Control+C native macOS control and an assumption that Playwright emits identical wheel delta units at DPR 1 and DPR 2. The final probe used Meta+C, compared against recorded host wheel events and waited for the open receipt. Those probe failures are not counted as product failures.

Raw diagnostic scripts, JSON observations, screenshots and logs are preserved outside the repository at `/Users/admin/Documents/ChatGPT/openpi-evidence/browser-comparison-20260928-7qVEVg`. The final records are `final-dpr1.json`, `final-dpr2.json`, `iframe-dpr1.json`, `iframe-dpr2.json`, `comparison-final.log` and `iframe.log`. Earlier attempts retain separate filenames and output directories. No private user Session or credentials were copied into that evidence bundle.

## Recommendation and integration boundary

Adopt direct iframe rendering for pages that can be embedded, especially local development previews, while retaining an explicit Chromium compatibility entry for sites that cannot. Native interaction addresses selection, clipboard, editing and touch behavior together; continuing to reproduce each browser primitive through CDP has a larger maintenance surface. This is a recommendation, not a claim that an iframe is universally better or a completed implementation.

Reuse the Web primitive and useful navigation semantics rather than importing DSH's tab/controller/provider framework. An implementation should first reuse the existing Workbar, Session identity, URL entry and external-open action. Any copied source requires a license review of its actual repository; the sidebar plugin's license alone does not license host code.

The smallest acceptable integration still needs these explicit boundaries:

- Distinguish a user-submitted URL from an unknown cross-origin location; never display invented history or infer successful loading from an iframe `load` event alone.
- Provide an explicit compatibility/external-open action. Do not automatically replay navigation, forms, text or authenticated state into another browser after a guessed timeout.
- Review the current Host `frame-src 'none'` policy and application-origin isolation before enabling frames. Do not blindly copy the DSH sandbox toggle or popup policy.
- Keep native Pi Session control and cleanup authoritative. A preview must not acquire another Session's tool authority, and an iframe must not gain access to OpenPI's bootstrap token or same-origin APIs.
- Preserve address drafts and focus when changing presentation. The direct iframe and isolated Chromium have different cookies and page state; switching is a new navigation, not continuity of the same page.

The feature decision answers are consequently bounded: the Workbar owns presentation, the Web Host owns access and browser cleanup, and Pi owns Session lifecycle. Direct rendering is an orthogonal display mechanism; choosing a target remains user/model judgment. Native frame events establish limited observations, while HTTP/CDP receipts establish separate compatibility-path facts. No second agent runtime, model routing, multi-tab framework or automatic renderer-selection state machine is needed for this conclusion.

## Validation and simplification

This investigation changed documentation only. No product implementation or new abstraction was added, so implementation ablation does not apply. The proposed design was reduced to the existing Workbar plus an iframe and an explicit compatibility action; DSH's Electron carrier and service/controller framework are unnecessary for the stated Web-only scope and are excluded.

`bun run check` and `bun run test` passed on 2026-09-28 using temporary npm-exec Bun 1.3.14 and Node 24. The test runner completed 1,983 passing native tests plus five platform skips, then 52 Vitest files / 907 passing tests. Logs are the external `check.log` and `test.log`; existing bundle-size and jsdom canvas notices remain. Their results validate repository consistency, not the iframe recommendation or untested deployment behavior. No public Issue comment or PR update was posted during this local investigation.

## Amendment: user-directed video experiment

The user subsequently rejected keeping the slow Chromium implementation merely as a compatibility entry, then explicitly requested trying video transport **before deleting Chromium**. The earlier iframe-plus-compatibility recommendation above is historical, not the current implementation plan. Product code remains at the frozen PR revision. An inactive iframe prototype was preserved outside Git; it is not loaded by the application. Whether video feels acceptable still needs the user's evaluation.

An isolated local prototype now captures an actual headless Chrome tab using `getDisplayMedia`, sends its track over WebRTC, and renders it in a separate browser's native `<video>`. It does not encode a canvas of CDP screenshots. A dedicated controller page owns capture; the visited page receives no capture script. Chromium's [tab-title selection test mechanism](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/media/webrtc/webrtc_getdisplaymedia_browsertest.cc) selects only the unique test tab in an isolated browser, and the harness rejects any capture whose `displaySurface` is not `browser`. No desktop screen, microphone, user's Chrome profile, model, or provider is involved.

The comparison reproduces the existing PNG transport mechanism: `Page.startScreencast`, immediate acknowledgement, latest-frame SSE delivery on a 16 ms timer, base64 decoding, Blob URL and image decoding. Both modes use the same target page and serialized HTTP-to-CDP input. This is a **transport reproduction**, not a patched OpenPI runtime or evidence that the complete product has these latencies. It omits application focus receipts, state polling and other Workbench workload.

The controlled target is 900 × 700 CSS pixels, tested at DPR 1 and 2 with Chrome `153.0.8010.54`. Each mode has two runs in PNG/video/video/PNG order, 24 inputs of each kind per run, and a five-second animation window. A black/white counter changes in the remote mouse-down, key-down or wheel event handler. The receiver starts its clock before posting the input and samples the decoded image/video pixels on animation frames until that counter appears. These are input-to-decoded-marker observations, not physical input-to-photon measurements, scroll-settling measurements or OS IME measurements.

| Scale and transport | Click median / p95 | Key median / p95 | Wheel-event marker median / p95 | Observed update callbacks/s, two runs |
| --- | --- | --- | --- | --- |
| DPR 1 PNG | 51.1 / 53.3 ms | 51.5 / 54.0 ms | 102.3 / 114.0 ms | 48.0, 52.0 |
| DPR 1 video | 50.4 / 67.0 ms | 49.7 / 52.1 ms | 84.9 / 102.4 ms | 44.6, 47.8 |
| DPR 2 PNG | 97.8 / 151.6 ms | 79.3 / 97.3 ms | 141.6 / 231.7 ms | 29.3, 38.9 |
| DPR 2 video | 82.9 / 102.0 ms | 68.4 / 100.8 ms | 103.3 / 134.8 ms | 49.0, 47.8 |

The input columns aggregate 48 samples per kind/mode/scale. Update callbacks mean decoded-image swaps for PNG and `requestVideoFrameCallback` for video; they are different observation surfaces and are not a display-presentation FPS claim. The video negotiated VP8, a 12 Mbit/s maximum send bitrate and a detail content hint; both decoded dimensions were asserted equal to the target's physical pixels. Static screenshots at both scales retained readable Latin and CJK text on visual inspection, but this does not establish lossless text or quality during arbitrary fast scrolling.

CDP process CPU-time deltas over the animation windows were lower for video in this diagnostic. At DPR 2, source-browser core equivalents were 2.81–3.46 for PNG and 1.10–1.35 for video; receiver-browser values were 0.94–1.15 and 0.19–0.20 respectively. These include all reported processes in each isolated browser, exclude Node/OS costs, and are not system-wide CPU percentages. The source also contains the capture controller, including while its video track is disabled for the PNG comparison.

The first attempt is retained but excluded: capture UI changed the headless content height to 613 pixels and the video was upscaled while PNG was not. Subsequent runs explicitly fixed emulated viewport bounds and capture dimensions. Data, harness snapshots, screenshots and logs live at `/Users/admin/Documents/ChatGPT/openpi-evidence/browser-video-20260928`; `results-dpr1-equal.json` and `results-dpr2-equal.json` support the table. The earlier `results-dpr1-first.json` is not comparable.

The bounded conclusion is that video is worth a hands-on trial, especially at DPR 2. It is not a demonstrated universal latency improvement: DPR 1 click latency barely changed and its video p95 worsened. It does not make forwarded input native, fix remote clipboard/IME semantics, or implement internal popup tabs. WebRTC across machines, NAT/TURN, reconnection, authorization and Pi Session cleanup remain product-integration work. The local prototype binds loopback with an unpredictable URL and origin checks; its single-viewer lifetime and automated capture selection are not a proposed production security design.

An additional DPR 2 run requested a zero-millisecond receiver [`jitterBufferTarget`](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget), with the applied value recorded as zero. Video click/key/wheel-marker medians were 97.2/84.5/117.8 ms; corresponding p95 values were 125.9/117.2/151.9 ms. This did not show a repeatable improvement over the default-buffer run. The separate run also had noisier PNG results, so it cannot establish that the hint itself causes regression. As an ablation/simplification step, the unsupported optimization claim and the hint were removed from the hands-on prototype. Frozen `measured-default/` and `measured-lowdelay/` harness directories and `results-dpr2-lowdelay.json` retain both variants. No general transport framework, setup toggle, new package dependency or product API was introduced.

The final interactive smoke (`smoke-v3.log`) passed forwarded text editing and wheel scrolling, PNG/video switching, cross-origin navigation that changes the captured tab's title, return navigation, and receiver reload/reconnection. It verified the new origin's pixels in the decoded video, not just a successful navigation receipt. Earlier smoke attempts failed because the standalone viewer omitted the existing host's select-all command mapping; the prototype now applies that mapping and retains those failures. The manual viewer additionally coalesces pending pointer/wheel input and starts its optional animation idle. These convenience changes are outside the frozen timing harness.

Repository `bun run check` and `bun run test` passed again for this documentation-only amendment. Their logs are `browser-video-20260928/check.log` and `test.log` in the external evidence directory. Product browser files have no diff from the named revision. The runnable local prototype and its instructions are retained as external evidence, without modifying the user's installed Pi source or running browser setup.
