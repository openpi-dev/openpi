# Web setup request identity across native system context

- Status: validated at native Session, Web component and isolated browser boundaries; real TUI collapsed-renderer acceptance remains unverified
- Created / last verified: 2026-10-04
- Source boundary: baseline `1d36e00dc1d8d42162c7969f7d6919718d239aad`, implementation `3a23aa95bdc69bcbce5e725f8e3b3ad070808a7a`, locked Pi 0.99.1
- Issue: [#654](https://github.com/openpi-dev/openpi/issues/654); this record covers its Web request-duplication defect only
- Related PR: pending integration review
- Supersedes: none

## Observed failure and ownership

The unchanged Questions browser tests require the original `/openpi-setup` request to appear exactly once after the native answer turn finishes. Both light and dark cases previously found two actual user message rows in the conversation. These were the native `openpi-web-command-input` entry and the displayed `openpi-setup-request`, rather than an optimistic draft or sidebar title. The duplicate also reproduced without a preceding Plan test and on the #643 integration candidate.

Pi can append a native `role: system` message for changed tool/context state between the command entry and the setup message. The previous projection inspected only the immediate parent, so it missed the owning command across this system entry. The canonical full setup prompt and its metadata were correct and remain untouched.

`extensions/setup/index.ts` emits setup details containing `requestId`, `request` and `command`. Its `requestId` is a setup-local sequence (`setup-N`), not the Web command UUID or a persisted native entry ID. It provides no `commandId` or `episodeId` for comparing those two entries. The native Session parent chain is the available identity source; equal request text alone is insufficient.

## Scoped resolution

`web/protocol/prompt-navigation.ts` follows the setup entry's exact native `parentId`, crossing only a continuous sequence of system messages. The first non-system ancestor must be a projected user command input with a valid bounded `commandId` and the exact displayed command text. An assistant, ordinary user, tool result, custom entry or any other intervening fact stops association. Each lookup must return the requested native ID. A missing branch entry, cycle or exhausted limit preserves the separate setup prompt. The resolver inspects at most 32 ancestor entries; this is a bounded projection rule, not a new setup lifecycle.

Transcript display, prompt history, previews and reading windows share this resolver. The lookup uses the current native branch map; a missing map entry cannot be repaired by supplying an unrelated or out-of-branch parent. Repeating identical text in a later command episode retains two independent command prompts. No general text deduplication, command parsing, Session mutation, authority widening or configuration change is introduced.

## Verification and efficiency boundary

Native tests construct real locked-SDK Session entries and check system ancestry, exact lookup identity, invalid command IDs, missing branch entries, cycles, the traversal bound, non-system interposition and independent same-text episodes. They separately assert that canonical full prompt text and metadata are unchanged. History tests retain exact original command entry IDs and response-preview assertions. Component tests retain command identity, original metadata and optimistic-entry assertions while covering zero, one and two system ancestors and a missing parent.

- `prompt-navigation.test.ts` plus `session-history.test.ts`: 30 passed in 36.62 s. An existing large snapshot-fitting test consumed 29.92 s of that run.
- `app-render.spec.ts` plus `transcript-navigation.spec.ts`: 126 passed in 31.50 s; test execution was 3.62 s, with most wall time in transforms, imports and environment startup.
- After adding the explicit branch-gap guard, only `prompt-navigation.test.ts` was repeated: 4 passed in 6.28 s, with about 13 ms in test bodies.
- `bun run check`: passed configuration/documentation/discipline contracts, Web build, formatting, lint and TypeScript checks.
- The two unchanged Questions end-to-end cases passed in real local Chrome: light 27.7 s, dark 23.4 s, total runner time 1.2 min including backend startup/cleanup. The strict original-request count remains one; refresh, native completion, controller isolation, reviewed answers and no-settings-change assertions are retained. The existing hermetic runner seeds a temporary agent directory with this checkout as its only package source and uses a synthetic provider, without user credentials or a real model call.

The root integration task owns the final combined `bun run test` gate. This local investigation avoids repeating a full suite or the expensive snapshot test after unrelated documentation changes. These timings describe validation cost and are not a formal performance Benchmark.

## Remaining acceptance

The user's installed package source was inspected separately with `pi list`: it resolved a single OpenPI source at `/Users/tushaokun/work/openpi-main-runtime`, revision `d36b58b67f87d24b4926521b965bdccfff7719e4`. It differs from the candidate source. This work does not install or reload that runtime.

Real TUI pixels, collapsed setup prompt appearance and interaction still need their own acceptance. Web projection evidence does not validate the TUI renderer or complete all of #654. The follow-up PR should reference the Issue without closing it until that acceptance is recorded. Private Sessions, prompts, screenshots and raw browser traces stay outside Git; the reusable identity and assertion boundaries above are sufficient for review.
