# Local Chromium WebRTC trial

- Status: superseded local trial; isolated smoke validated, deployed acceptance failed; not a production adoption Decision
- Created: 2026-09-28
- Verified: 2026-09-28
- Source: `250731fcf572d773a59e7c2521e1e6db100fe4da` plus the local `codex/browser-video-trial` diff in `/Users/admin/.local/share/openpi/web-runtime`
- Issue: [#597](https://github.com/openpi-dev/openpi/issues/597)
- Related PR: [#598](https://github.com/openpi-dev/openpi/pull/598); this deployment has an older baseline than that PR's investigation worktree
- Supersedes: no prior record; implements the user's request for a local video trial while preserving Chromium and PNG
- Publication: local only; Issue backlink pending publication

## Scope and ownership

### Amendment: video rejected, native iframe selected

The user tried the updated service at port 57161 and rejected its interaction latency. The subsequent deployed Baidu smoke also timed out waiting for decoded video, despite the isolated fixture test below passing. Those two boundaries must not be conflated. The user then explicitly requested the DSH-style native iframe route. The remainder of this record preserves the video experiment as historical evidence, not the current implementation.

The replacement uses a React/TypeScript toolbar and native iframe, with bounded local tabs and manually entered address history. It removes the server Chromium manager, capture controller, video/PNG APIs and input forwarding. Closing the tool or changing its owning Session unmounts the frames. Hiding the workbar preserves them. No model orchestration, provider, persistent configuration or package dependency is introduced. HTTP(S) embedding is permitted by frame-src, while OpenPI itself retains frame-ancestors none, DENY, and document bootstrap checks; its own origin and embedded credentials are rejected in the address bar.

Cross-origin frames do not expose reliable live location/history or popup interception. Their popups remain external browser tabs, and sites may refuse framing. Toolbar history is explicitly limited to entered addresses; after a frame navigation reload reopens that entered address. These limitations are surfaced in the panel, without stripping site security headers or adding a proxy. This follows the direct rendering mechanism demonstrated by DSH, not a claim of full Codex browser feature parity.

The rejected integration source and generated assets are retained outside Git in `browser-video-integrated-20260928/rejected-video-source`. Removing the entire transport/controller abstraction is the simplification experiment for the replacement: native input, selection, scrolling and independent tabs still pass without it, so it is removed.

Replacement validation on 2026-09-28: `bun run check` passed; `bun run test` passed 1,923 native tests (five skipped) and 479 Vitest tests. The real-browser iframe test covers native Chinese text entry, word selection, actual wheel scrolling, independent tabs, external popups, manually entered back/forward history, page navigation uncertainty, blocked framing, pane hide/reopen and closing the final tab. A separate smoke against the restarted port 57161 loaded Baidu's real document and verified native input/selection, retained tab state, frame release on tool close, no video viewport and zero legacy browser API requests. The previous capture Chromium exited after graceful service shutdown. Receipts are at `/Users/admin/Documents/ChatGPT/openpi-evidence/browser-iframe-integrated-20260928` (`check.log`, `test.log`, `e2e-fixed.log`, `live-smoke.json`, and screenshots). These checks establish local behavior, not a general latency or CPU benchmark. No iframe CPU percentage is claimed; removing capture, encode/decode and the extra server browser removes those specific overheads, while normal webpage rendering still consumes resources.

The user explicitly requested updating the existing service at `http://127.0.0.1:57161/` to try WebRTC in the ordinary browser panel. The service's launch agent runs this dedicated checkout, with `PI_CODING_AGENT_DIR=/Users/admin/.local/state/openpi-web/agent`. Provenance was checked using that environment: one OpenPI source matching this checkout and the revision above. Global Pi preferences are unrelated and were not changed.

The existing `EmbeddedBrowserManager` owns Chromium, its isolated profile and active Pi Session lifetime. A private loopback controller page captures only the uniquely named initial tab before user navigation, using Chromium's automated tab selection. The visited page is not instrumented for capture. A video track goes over WebRTC into the existing React viewport; address, history, physical input and committed text remain on the existing APIs. Capture requests no microphone or desktop/window surface, and rejects any surface other than a browser tab. No Playwright runtime dependency is added.

The Host keeps ordinary bearer/controller authorization and exact active-Session validation for bounded offer, ping and close requests. Four peer connections are allowed, abandoned leases expire after 20 seconds plus the two-second sweep interval, and browser/session disposal closes the controller and its HTTP server before process/profile cleanup. Offers use no external STUN/TURN servers. The receiver disconnects when its panel or document is hidden; its stream closes and the captured track becomes disabled when no viewers remain. The page remains alive. This stops encoding/transmission; it does not claim complete suspension of the page or the native capture source.

Video is bounded to 1920 pixels per axis and 60 requested frames/second with a 12 Mbit/s send ceiling. These are upper bounds/hints, not promises of delivered resolution, frame rate or bitrate. PNG code remains available internally. This branch's Host requests video by default for the user's trial, without adding a user configuration toggle or automatic navigation replay.

## Validation and local observations

### PR integration validation

The iframe replacement was transferred onto PR #598's newer `e526d11d22b1c7eaa35656b1c369b53766102d09` baseline without replacing its unrelated Session/settings changes. The superseded browser text/focus proxy and its transport-specific tests were also removed. `bun run check` passed; `bun run test` passed 1,955 native tests (five skipped) and 823 Vitest tests. Four targeted real-Chromium scenarios passed: native iframe interaction/lifecycle, desktop pane resizing, workbar tool lifecycle, and production keyboard/accessibility behavior. Initial failures exposed a missing test wait for post-close tab focus and an outdated English workspace-menu selector in the Chinese test locale; both test assertions were corrected and the affected scenarios passed on rerun. The obsolete cold-start CI step was removed with its manager, while native Web E2E coverage remains. These integration receipts are in `/Users/admin/Documents/ChatGPT/openpi-evidence/browser-iframe-pr598-20260928`. Google embedding/header experiments are not part of this commit.

### Historical video observations

The real Web UI test receives video pixels that change after select-all/type/undo, forwards drag and pointer release correctly, resizes the viewport, closes the video lease when its browser tab is closed, and receives pixels again after reopening. It samples decoded video, rather than treating an SDP answer as proof of rendering. Host tests reject unauthenticated, stale-Session, malformed and oversized signaling requests. A separate real-Chromium diagnostic checks peer limits, close handling, abandoned lease expiry and cleanup.

CPU was sampled over six-second windows with a 900 × 700 CSS viewport at DPR 2, Chrome `153.0.8010.54`, the actual modified manager, and a separate minimal video receiver. Both browser process trees run on the same Mac. Values are process CPU-time deltas divided by wall time: one core equivalent equals 100% of one logical CPU, not 100% of the whole computer. They exclude Node/OS costs and most of the Workbench UI. This is a bounded local diagnostic, not a formal Benchmark or an estimate for every website.

| Activity | Source Chromium core equivalents | Receiver browser core equivalents |
| --- | ---: | ---: |
| Visible static text page | 0.076 | 0.026 |
| Continuous wheel scrolling | 0.871 | 0.120 |
| Visible moving-square animation | 1.766 | 0.163 |
| Hidden static page | 0.025 | 0.003 |
| Hidden page whose animation remains active | 0.104 | 0.019 |

The verified scrolling run checks actual remote wheel events and nonzero scroll distance. An earlier probe mistakenly used an unsupported action type and did not scroll; its scrolling sample is excluded, and the original harness/log are retained. Values can vary with page complexity, display size, hardware and concurrent workloads. Video improves the high-DPI transport mechanism observed in the earlier comparison; it does not make input native, implement popup tabs or complete OS clipboard/IME parity.

Raw evidence lives outside Git at `/Users/admin/Documents/ChatGPT/openpi-evidence/browser-video-integrated-20260928`. Relevant records are `e2e-lifecycle.log`, `host-video-test-fixed.log`, `cpu-and-lifecycle-verified.json` and the final check/test logs. The standalone comparison is separately preserved in `browser-video-20260928` beside it.

## Simplification and remaining boundary

Dynamic `applyConstraints` calls for idle frame rate and changing capture dimensions produced Chromium `OverconstrainedError: Source failed to restart` and blank video on resize. Removing those calls, setting one initial resolution/frame-rate bound and letting tab capture follow the source viewport passed the real input/resize/reconnect checks. The viewport also reserves its grid row and positions the video independently of intrinsic dimensions, preventing a video/resize feedback loop. This is the ablation result: the simpler capture path is retained, without a dynamic quality controller or general transport framework.

This local trial has no public rollout, no cross-platform/network acceptance and no TURN/restricted-network fallback. Capture failure is visible; it does not silently pretend to be a working video. The native source tab, private controller and viewer are distinct browser contexts/pages; the exact controlled Session remains the authority boundary. Better models can use the existing independent navigation/input primitives without a new orchestration workflow.
