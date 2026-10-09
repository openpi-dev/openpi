# Pi browser tools and OpenPI embedded pages

- Status: validated local investigation; integration recommendations are not an accepted Decision
- Created: 2026-10-09
- Verified: 2026-10-09
- Source: OpenPI `3cb2ecfe1bfbb98252651885311d309f83749428`, its frozen Pi `0.99.1` dependencies, and installed `@injaneity/pi-computer-use` `0.5.1`
- Issues: [#169](https://github.com/openpi-dev/openpi/issues/169), [#597](https://github.com/openpi-dev/openpi/issues/597)
- Related PR: none; no runtime implementation change
- Supersedes: none; complements the [native iframe trial](WEB_BROWSER_VIDEO_TRIAL_2026-09-28.md)
- Evidence: local archive `/Users/admin/Documents/ChatGPT/openpi-evidence/browser-tools-20261009`; raw observations, images, and isolated agent data remain outside Git

## Question and verified facts

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
