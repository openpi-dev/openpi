# Web rerun confirmation race

- Status: validated source, controlled store regression, and mock Web E2E evidence
- Created / verified: 2026-10-09 (Asia/Shanghai)
- Source boundary: upstream/main `56a7fe09cbdddec8f5619904cb530144892c0df5`; repair source and regressions at `61005750dcaf4a341534dd0d3d987c39b7df92f5`
- Issue: [#717](https://github.com/openpi-dev/openpi/issues/717)
- Repair PR: [#718](https://github.com/openpi-dev/openpi/pull/718)
- Related history: [#685](https://github.com/openpi-dev/openpi/pull/685), [#626](https://github.com/openpi-dev/openpi/pull/626), [#643](https://github.com/openpi-dev/openpi/pull/643)
- Supersedes: none

## Verified history

PR #643 connected older-message edit and answer regeneration to the existing
native fork and ordinary prompt-admission paths. Its merged source at
`1d36e00dc1d8d42162c7969f7d6919718d239aad` contains the
[shared rerun entry point](https://github.com/openpi-dev/openpi/blob/1d36e00dc1d8d42162c7969f7d6919718d239aad/web/ui/src/store/web-store.ts#L1719-L1724),
[single fork confirmation](https://github.com/openpi-dev/openpi/blob/1d36e00dc1d8d42162c7969f7d6919718d239aad/web/ui/src/store/web-store.ts#L1824-L1834),
and [success-notice E2E assertion](https://github.com/openpi-dev/openpi/blob/1d36e00dc1d8d42162c7969f7d6919718d239aad/tests/web/message-rerun.e2e.ts#L202-L215).
No matching failure report was found in its body, Issue comments, or reviews;
the body reports final passing CI. It is an implementation source, not a
third observed failure or a confirmation-race repair.

PR #685 records a fork-result uncertainty alert in its Validation section.
Its [failure log](https://github.com/openpi-dev/openpi/actions/runs/37253606035/job/111586040186?pr=685#step:10:197)
waits for the rerun success notice at `message-rerun.e2e.ts:209:7` and reports
51 passed / 1 failed. Its four changed files only concern subagents and their
tests; it does not change Web fork confirmation.

PR #626 also records a missing rerun success notice. Its
[failure log](https://github.com/openpi-dev/openpi/actions/runs/37197557262/job/111422446583#step:10:196)
fails the same assertion and reports 51 passed / 1 failed. Its twelve changed
files concern cleanup guard, setup, configuration, docs, and their tests;
it does not change the Web rerun implementation or E2E.

These are independently reviewable historical symptoms. Neither historical
log exposes the internal snapshot generation, so they do not establish the
exact internal interleaving of each CI failure or attribute the defect to
those unrelated feature changes.

## Controlled causal evidence

At the source boundary above, a probe used real `createWebStore`,
`regenerateMessage`, and `refreshSnapshot`, with deferred responses only at
the HTTP client boundary. In each of five paired trials:

| Source | No competing refresh | Same-child competing refresh |
| --- | --- | --- |
| Upstream | accepted, one prompt | uncertain, zero prompts |
| Repair | accepted, one prompt | accepted, one prompt |

The competing refresh confirms the same correct, controlled child before
the original confirmation returns. The original response is correctly
discarded by the global generation guard, but the old fork action treats
that `false` result as terminal uncertainty and never enters prompt admission.
The fork receipt and returned child identities do not change between trials.

The formal regression in
[`session-fork.spec.ts`](../../tests/web/session-fork.spec.ts) exercises this
schedule through public actions without sleeps or mocked action results.
The original regeneration regression failed before the repair and passed
afterward. A second regression first exposed a pending-state cleanup gap:
canonical rechecking can return to the original source, where the former
path-based `finally` condition leaves `sessionSwitching` set.

## Scoped repair and safety evidence

The fork action may recheck its canonical snapshot once while its epoch and
selected child path remain owned. It then retains receipt/source/child
identity checks, runtime control, and ordinary `sendPrompt(expectedTarget)`
workspace checks. It does not fork twice, send twice, accept a cached child
without valid confirmation, or weaken global generation ordering.

Cleanup now follows the actual child transition and current epoch ownership,
including a canonical return to the original source. A newer Session
selection keeps its own switching state.

The 19 new cases, alongside the ten existing cases, cover edit/regenerate/fork
success, two superseded confirmations ending uncertain, source fallback,
Session/workspace changes during either confirmation, child ID/path/runtime
authority mismatches, and invalid receipts. Existing image and confirmed
422 rejection draft recovery remain covered.

## Validation and limits

- `bun run check`: passed.
- Session fork suite: 29 passed.
- `bun run test:ui`: 82 files / 1,177 passed.
- Final built `message-rerun.e2e.ts`: 20 repeated runs passed with one worker.
- `bun run test`: parallel Node phase 2,198 passed / 5 failed / 14 skipped.
- Separately completed Node serial phase: 99 passed / 4 skipped.
- `git diff --check`: passed.

All five Node failures were independently reproduced as this Windows host's
symlink-creation permission limitation. Four directly raise `EPERM`; the
fifth loses its intended `changed-session` assertion because its substitution
hook cannot create the symlink. The affected Git review, transcript search,
and turn-change modules and tests have no changes in this patch. The full
test command remains non-green; separately completing serial and UI coverage
does not convert that result into a passing full gate.

Before validation, `pi list` reported one OpenPI source: the local checkout
being edited. No manual installed Pi, live provider, or model smoke was run.
The causal probe and browser E2E use mock client/HTTP responses. They establish
the runtime race and its tested repair, not a real-provider incident rate.
Finite SSE fixture EOF/reconnection increases opportunities for overlap;
changing that fixture alone would not close the runtime gap.

Large raw traces and logs remain outside Git. The linked Issue preserves
the original evidence locations and limitations; the committed regression
provides a retrievable reproduction. This investigation adopts no new
architecture or configuration constraint.
