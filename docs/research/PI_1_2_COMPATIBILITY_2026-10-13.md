# Pi 1.2.0 compatibility and managed Web startup

- Status: validated at the source, isolated package, native Session, and local browser boundaries
- Created: 2026-10-13
- Last verified: 2026-10-13
- Source baseline: OpenPI `6e3f2cd9606ca13abdf8f8430a0de90753ef7388`, with the fix commits linked from the Issue
- Published reproduction: `@tt-a1i/openpi@0.10.0`; npm release provenance identifies `d96b9fcc7ed4116b090c300b103b612056e34fc3`
- Host boundary: official Pi 1.2.0 packages; Pi 0.99.1 is a separate startup control
- Issue: [#765](https://github.com/openpi-dev/openpi/issues/765)
- Fix PR: [#711](https://github.com/openpi-dev/openpi/pull/711)
- Supersedes: none; the [0.99.1 investigation](PI_0_99_COMPATIBILITY_2026-09-30.md) retains its historical boundary

## Reproduced cause

Native Pi package installation omits peer dependencies. OpenPI's Web subprocess
forwarded the selected host's `pi-coding-agent` entry but directly imported
`@earendil-works/pi-ai/providers/all` without the corresponding host resolution.
The published npm package therefore failed to start when the host was installed
separately. Both Pi 0.99.1 and 1.2.0 reproduced the screenshot's missing-module
error. Adding only the missing peer link made startup succeed; removing it
restored the failure. The duplicate `todo` warning was not needed to reproduce it.

Pi 1.2.0 contains the provider module. Its import-only ESM export means a failed
CommonJS `require.resolve` probe is not evidence that the module is absent.
The fix resolves this one direct import through the already validated host entry
and its ESM exports. Pi still owns the SDK and provider registry. No second Pi
installation, broad module search, or provider stack is introduced.

## Pi lifecycle and presentation changes

The official 1.2.0 package's changelog and installed SDK establish that
`before_agent_start` now includes custom-message runs and that the Session is
already busy during startup. OpenPI's prompt-only capability activation and Plan
approval binding therefore check for a user prompt. Custom messages cannot
consume a user's implementation approval.

The Plan preflight callback may consume a busy run's approval only when its
revision and exact user prompt have already matched the native startup event.
Other busy Plan changes remain rejected. A browser regression reproduced the
previous busy rejection after the user submitted an approved plan.

Web and child Sessions consume the native `agent_settled.aborted` receipt even
when no aborted assistant message exists. Older hosts retain their existing
assistant/retry cancellation evidence. Capability highlighting preserves Pi's
new fake-cursor markers alongside hardware-cursor and legacy reverse-video
markers. The bundled theme uses Pi's published schema URL.

The development dependencies and lockfile move to Pi 1.2.0. The declared minimum
remains 0.99.1: raising it would not repair this installation-layout defect.

## Validation and limits

- The isolated npm reproduction and candidate each report exactly one OpenPI
  source through `pi list`. The candidate has no local Pi peers. Its Web process
  starts and stops cleanly with both host versions.
- A real Pi 1.2.0 interactive terminal starts `/web`; HTML, JavaScript and CSS
  return HTTP 200. Ctrl+C stops Web and returns to the Pi terminal.
- Real native Session regressions cover custom-message startup and cancellation
  during startup. Unit tests independently cover child terminal evidence,
  prompt-bound Plan approval, and native editor marker preservation.
- Removing the provider alias, custom-message guard, native abort receipt,
  fake-cursor handling, or admitted Plan busy exception reproduces the
  corresponding failure. Each necessary
  change was restored without adding a compatibility framework.
- After integrating the `cfc5537a` base, `bun run check` passed and `bun run test`
  passed with 2,499 Node tests, nine platform skips, and 1,421 UI tests. All 18
  native browser scenarios passed in one run. Provider tests use local HTTP
  fixtures, not a remote model service. The same implementation at `4dc8486c`
  passed [CI run 38406090624](https://github.com/openpi-dev/openpi/actions/runs/38406090624)
  before consolidation into PR #711; new-head CI is tracked on that PR.
- Local validation uses macOS, Node 24.20.0 and Bun 1.3.14. The older host control
  proves startup, not every feature on 0.99.1. Remote provider credentials,
  externally configured MCP servers, and Windows behavior are outside the local
  acceptance boundary; CI supplies its own platform evidence.

Private reproduction logs, isolated installations, terminal captures, and
ablation receipts are retained outside Git under evidence identity
`web-peer-resolution-2026-10-13`. This is a compatibility investigation, not a
Benchmark, release receipt, or new architectural Decision.
