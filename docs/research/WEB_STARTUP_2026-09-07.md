---
status: validated
created: 2026-09-07
last-verified: 2026-09-07
applies-to: OpenPI Web startup and browser launch boundaries
related-issues: #450
related-prs: none
supersedes: none
---

# Web startup feedback and browser waiting

- Status: validated for the source observations below; timings are exploratory.
- Created and verified: 2026-09-07.
- Source boundary: OpenPI main `5dac5ba7fe16285947907920c1450ccd487067cf`, local macOS, Pi 0.85.1, source-installed OpenPI.
- Tracking: [Issue #450](https://github.com/openpi-dev/openpi/issues/450).
- Supersedes: none.

## Observations

`extensions/web/index.ts` stopped the TUI and cleared the terminal before spawning the Web CLI, without writing progress. `bin/openpi.js` printed ready only after awaiting `openBrowser`, although the Host was already listening. The browser launcher used `execFile` without a deadline. These are distinct from runtime initialization cost.

Four alternating local probes used fresh temporary agent directories and Jiti filesystem-cache directories per run, an empty workspace, a real Host on port zero, and explicit cleanup. Existing loading reached ready in 1273 and 1004 ms; a candidate native SDK import bound through Jiti virtual modules reached ready in 1016 and 995 ms. The native candidate asserted exported SessionManager identity and runtime instance identity. An earlier existing-loader sample took 10015 ms; that difference was not reproduced in the alternating runs.

These exploratory observations do not establish a cold-start speedup: operating-system caches and machine load were not controlled, only one machine was sampled, and user provider/extension configuration was not exercised. No formal Benchmark or general latency claim is made. SDK loading remains unchanged.

## Repair and verification boundary

The terminal handoff now writes progress immediately. Host readiness and the usable address are printed before invoking the browser opener. The native `execFile` operation has a three-second deadline and accepts cancellation during Host shutdown. An opener exit is described as an open request, not proof that a browser page loaded. Timeout stops only the owned launcher process; this does not promise cleanup of arbitrary descendants created by operating-system launch services.

`tests/web/startup.test.ts` uses an isolated real CLI and a deliberately stalled opener on POSIX to verify that the address appears and serves HTTP before the opener completes, that timeout preserves the serving Host, and that shutdown cancels the pending launch. The process test is explicitly skipped on Windows; pre-cancelled launch and ready-screen tests are portable. Extension tests check progress before spawn. Browser rendering performance and fully cold user-configured startup remain separate investigation scopes.

## Verified facts

The startup and browser-launch tests establish the readiness, timeout, cancellation, and progress boundaries described above.

## Inferences

The measured local timings support the lifecycle repair but do not prove a general cold-start speedup.

## Recommendations

Keep readiness publication independent from browser opener completion and preserve bounded cancellation on shutdown.

## Unknowns

Cold user-configured startup and browser rendering performance remain unmeasured.
