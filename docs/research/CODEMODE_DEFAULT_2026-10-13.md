# Native Code Mode defaults in CLI and Web

- Status: validated at the native SDK, CLI print and Web runtime boundaries; not a performance Benchmark or a new architecture Decision.
- Created / verified: 2026-10-13.
- Tracking: [#763](https://github.com/openpi-dev/openpi/issues/763); implementation: [PR #711](https://github.com/openpi-dev/openpi/pull/711).
- Source boundary: PR baseline `6e3f2cd9606ca13abdf8f8430a0de90753ef7388` plus this change; frozen Pi 0.99.1, Node 24.20.0 and Bun 1.3.14. The private patch receipt identifies the tested working tree.
- Relationship: follows the activation observations in [Web execution activity](WEB_CODEX_ACTIVITY_2026-10-08.md), without replacing its historical presentation-only conclusions.

## Observation and interpretation

A retained 21m36s Web turn made 73 main model calls: 70 successful responses and three 502 responses. The timing reconstruction attributes about 908s to model intervals, 315s to tools, 64s to two compactions and 9s to other gaps. No `codemode` call occurred; the ordinary active tools were read, bash, edit and write. This is one private diagnostic trace, not a comparative Benchmark or evidence that every tool batch could have been combined.

Pi registers native `codemode` inactive. Loading its extension therefore did not make it available in ordinary OpenPI turns. A shared package extension now activates that registered executor on `session_start` in CLI and Web. `codeMode.enabled` defaults to true, including existing configuration documents without the field. `/openpi-setup` exposes `code_mode_enabled`, reports the default and applies changes through the existing setup event.

The executor, schemas, nested tool dispatch, cancellation and saved results remain Pi-owned. Ordinary tools stay available and the model chooses whether to compose calls. No new executor, provider, prompt router, tool card or persistent activation store was added. Existing native `defaultTools` selections and CLI/SDK tool restrictions take precedence. An opt-out removes only activation performed by OpenPI; it preserves an already active native CLI/SDK selection. A disabled or absent native factory is not loaded automatically. Activation makes no model request and writes no native settings. Children keep the PR's existing native factory loading and inherited tool limits.

Making composition available can reduce avoidable model round trips, but does not reduce provider latency by itself or guarantee fewer calls. The CLI smoke also exposed an independent existing behavior: a prompt saying not to use subagents still triggered capability guidance and one extra skill read. That observation is retained as a separate investigation lead; this change does not alter capability intent handling.

## Validation and ablation

Native SDK regressions execute a real script, toggle the default through setup events, reload, preserve native settings bytes, respect native selections and exclusions, tolerate a missing factory, and reject a nested write outside an inherited read-only allowlist. Setup regressions check persistence, omitted-field preservation, invalid input rejection, legacy defaults and status output. Removing startup activation reproduced the missing default tool; restoring it passed. Removing the activation ownership bit reproduced loss of an explicitly selected CLI/SDK tool when the package default was off; restoring it passed. The retained implementation is one small lifecycle consumer of existing Pi and setup seams.

Final `bun run check` passed. Complete `bun run test` passed with **2,493 Node passes, nine platform skips and all 94 UI files / 1,421 tests**. The runner used an isolated `PI_CODING_AGENT_DIR`, task-owned `TMPDIR` and `VITEST_MAX_WORKERS=2`. The first unisolated run exposed two stale configuration expectations, local preference dependencies in six display tests and a shared-temp-directory race; updated expectations and isolated revalidation passed. Existing bundle-size and JSDOM capability notices remain.

Both real entry checks used independent agent directories whose `pi list` reported exactly one OpenPI source: the tested checkout. With `local-codex/gpt-6.1-sol`, high thinking, the same bounded prompt requested a single Code Mode batch to read two fixture files and return their sum:

- Web: two model responses, one successful native `codemode` execution containing both reads, final answer `46`.
- CLI print: three model responses, one additional skill read followed by one successful native `codemode` execution containing both reads, final answer `46`. The initial strict one-tool verifier rejected the extra skill read; the retained native events were reverified without another model run. A prior CLI harness attempt waited for stdin EOF and timed out before model execution; the harness was corrected to close stdin.

These checks prove loading and native execution in both entry paths. They do not replay the original PR task, estimate its new completion time, demonstrate automatic batching on arbitrary prompts, verify an interactive TUI presentation change, or deploy the resident Web service. The Web smoke took about 25.5s including startup, but no speedup is claimed from a different task or from concurrent runs.

The provider smokes preceded the final guard preserving already-active native selections on opt-out; the final SDK regressions and full gates cover that guard. Default-on execution was unchanged by it.

Private evidence: `~/.local/state/openpi-web/evidence/codemode-default-20261013/`, retaining source/provenance receipts, native fixture results, successful and failed gate logs, ablations and CLI/Web execution receipts. The original timing reconstruction remains in `~/.local/state/openpi-web/diagnostics/2026-10-13-01a134a7/`. Credentials, private settings and raw Session data stay outside Git; test-owned credential copies were removed after the smokes.
