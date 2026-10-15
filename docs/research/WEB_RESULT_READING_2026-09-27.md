# Web result reading and inspection

- Status: validated against the named source, repository gates, and bounded desktop observations
- Created: 2026-09-27
- Verified: 2026-09-27
- Source boundary: PR #598 at `fa0fbc22f45333dac08d934eedc878e44f16d9a0` plus this change; Pi SDK 0.85.1; frozen Pi Web `a345b2ac363b644d5ef43b1da75b9bc53cd055c4`
- Issue: [#597](https://github.com/openpi-dev/openpi/issues/597)
- PR: [#598](https://github.com/openpi-dev/openpi/pull/598)
- Supersedes: none; supplements [execution recovery](WEB_EXECUTION_RECOVERY_2026-09-26.md) and [turn evidence and item recovery](WEB_TURN_EVIDENCE_AND_ITEM_RECOVERY_2026-09-23.md), without adopting a new project constraint

## Findings And Sources

Pi Web's frozen [ChatView.ts](https://github.com/jmfederico/pi-web/blob/a345b2ac363b644d5ef43b1da75b9bc53cd055c4/src/client/src/components/ChatView.ts) opens image inspection in a native dialog, focuses its close control, and distinguishes closing the image from navigating the conversation. OpenPI already uses Astryx Dialog and native draft image data, so the useful comparison is the interaction, not Pi Web's framework or a new artifact grant.

Source and regression observations found these concrete gaps:

- Draft images were only removable thumbnails. A first full-image implementation also let a tall image enlarge its grid track and crop the bottom. After containing the whole image, a long screenshot remained too small to read at fit size.
- A bounded `plan_ready` preview could omit a legitimate large plan. The native plan validator permits up to 48,000 UTF-8 bytes, but the ordinary projected details budget is smaller. Reading tool arguments, English result prose, or the latest Session plan would not prove this exact result was ready.
- Historical tool calls without terminal results appeared animated or completed, while live partial tools had inconsistent row/card states. A successful `bg_status` query of a failed process lost the known failure in its collapsed group summary.
- The final full-text page removed its loading button without a reading-focus handoff. Per-turn review opening/return similarly lost focus, and Escape did not work from the review header.
- Healthy browser frames cleared explicit address/input errors. Older navigation and resize receipts could overwrite a newer native page; passive input receipts could erase newer explicit feedback.
- Two existing UI test files had `.spec.tsx` names but contained no JSX. The repository runner, discovery, and formatting scope use `.spec.ts`, so those suites were outside the ordinary gate.
- A full gate exposed a question test that observed the new form before old passive cleanup had settled. Production already changes request identity synchronously before displaying a canonical successor. The test now settles that existing lifecycle rather than treating a new DOM node as cleanup evidence; abort, cache retirement and late-receipt assertions remain unchanged.

## Interaction And Ownership

Draft image inspection reuses the existing data URI and a permanently mounted native Dialog. Fit is the default; an icon mode switch exposes original size with native two-axis, keyboard-focusable scrolling. Closing returns to the exact thumbnail only while its Session/image still exists and no newer input owns focus. Sending/removing the image or changing its owner closes the view without restoring stale focus. There is no new image fetch, historical image authority, zoom framework, or saved preference.

Long plans reuse the existing exact Session-item pagination API with optional `purpose=plan`. The adapter accepts only a current-branch native entry containing a successful `plan_ready` result, `details.status=ready`, and the existing bounded-plan validator's valid `details.plan`. Ordinary messages retain their existing contract; generic tools, failed receipts, extra/duplicate query fields, arguments and prose are not plan authority. Every page checks its exact entry and ready marker. Partial copies contain only displayed text; complete copies contain the canonical plan body. Complete projected native details take precedence over earlier local partial text. Reading never approves or executes a plan.

Full-text loading keeps its button focused while pending and moves focus into the completed body only if that button still owns focus. Old identity reads abort. Per-turn review uses the existing requested path for its return target, retains expansion, and handles plain Escape across the whole review, with composition/modifier guards. Delayed reads do not steal focus from new input.

Tool rows, specialized cards, and group summaries use exact live execution state or persisted terminal evidence. Missing historical results remain neutral; only all-confirmed completed rows produce a completed group. Native process failure can mark a group failed even when the status-query tool itself succeeded; a native workflow's explicit uncertainty retains the existing warning marker. No lifecycle event or tool receipt is rewritten.

Browser feedback has separate address, input, and frame ownership. A healthy frame clears only frame errors. Only the current meaningful input receipt clears input feedback; passive pointer/key release results do not erase explicit failures. Native navigation ownership is separate from the user's address draft revision. Polls, old navigation receipts, and obsolete resize receipts cannot roll back a newer page or draft. Resize cleanup aborts its existing request and ignores old observers. These are transient UI protections, not a new browser execution queue.

## Validation And Ablation

- `bun run check`: passed configuration/docs/discipline contracts, Web/root types, production build, format and lint. The existing bundle-size warning remains.
- `bun run test`: 1960 native tests passed, 5 platform tests skipped; 51 UI suites / 841 tests passed. The test-name alignment makes the two formerly undiscovered suites part of this gate.
- Focused final reading regression: 6 UI suites / 91 tests passed. Native history and ready-plan boundary suites also passed. The question selection passed 25 tests and the corrected lifecycle case passed 20 independent repetitions without extending its timeout.
- Image regressions cover opening/closing, exact owner/image invalidation, failed send/decode, return focus, fit/original modes and reset on reopening. Removing the opening blur caused 2 failures; removing owner protections caused failures; removing mode reset caused 3 failures. Necessary guards were restored.
- Plan regressions distinguish paired/unpaired persisted results, readiness provenance, partial/full copying, current canonical details and late reads/copies. Removing the returned readiness check failed a regression; removing reading-focus/copy ownership failed 2. Necessary guards were restored.
- Removing a duplicate per-turn opener-path ref left all 6 return-focus tests passing, so that ref was deleted. Removing the process-failure group condition failed the 2 native-status regressions; removing native workflow uncertainty aggregation failed 2. Both were restored.
- Browser ablations: clearing operation errors during healthy paint failed 2 tests; removing resize receipt ownership failed 3; letting passive input clear newer errors failed 1; accepting an old navigation receipt failed 1. All guards were restored and the focused suite re-passed. The older implementation already passed the new poll-specific cases; those tests strengthen coverage but do not prove an old poll bug.
- Final independent review reproduced an old initial-restore rejection contaminating a successfully opened, healthy new page. Its catch now observes the same current-state guard as its success handler. The new regression failed on the old source and on guard removal; restoring it passed the 32 browser-input cases.

Final gate logs are local evidence at `/private/tmp/openpi-pr598-reading-final-{check,test}-20260927.log` and `/private/tmp/openpi-pr598-reading-focused-20260927.log`; browser ablation logs use `/private/tmp/openpi-pr598-browser-{frame,resize,input,navigation}-ablation-20260926.log`, and workflow uncertainty uses `/private/tmp/openpi-pr598-reading-uncertainty-ablation-20260927.log`. These are reproducible engineering test receipts, not a formal Benchmark or published raw Session evidence.

## Desktop Observation And Limits

On 2026-09-26, the isolated 57162 preview used this checkout as its only OpenPI source (`pi list`, isolated `PI_CODING_AGENT_DIR`), with no model prompt submitted. At the actual 1280x720 viewport, a local synthetic 300x1600 PNG reproduced the initial image cropping. The minmax grid tracks contained the entire image; original-size mode rendered 300x1600 and keyboard End reached the bottom. Closing restored its exact thumbnail; reopening defaulted to Fit. A local dynamic fixture in the native embedded browser produced changing, decoded frames while the invalid-address alert remained visible. Address editing cleared that alert without allowing polling to overwrite the unsent draft; successful corrected navigation retained a healthy frame.

Temporary fixture HTML and agent-created tabs were removed, and the viewport override reset. The resident 57161 service and user's original browser tab were not modified. The requested 390x844 browser override did not actually take effect: DOM dimensions remained 1280x720. Therefore this batch does not claim mobile manual acceptance. Plan and per-turn focus evidence here is component/protocol testing, not a live model-generated plan workflow.

Native Codex automation returned an application-level safety rejection for `com.openai.codex`; no bypass or live native comparison is claimed. Pi Web was a frozen read-only source reference, not launched in this batch. No browser E2E, Safari, full IME, historical image recovery, page-reload draft recovery, or new child-relative file grant is claimed. Broader Web interaction iteration remains open in #597.
