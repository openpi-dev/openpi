# Web model entry

- Status: validated against the named native source, regressions, repository gates, and bounded observations
- Created: 2026-09-27
- Verified: 2026-09-27
- Source boundary: PR #598 at `6ee6dbf5cca664e1af8f7baa55d60a18518caa08` plus this change; installed Pi SDK 0.85.1 and its native Agent implementation
- Issue: [#597](https://github.com/openpi-dev/openpi/issues/597)
- PR: [#598](https://github.com/openpi-dev/openpi/pull/598)
- Supersedes: none; supplements [result reading](WEB_RESULT_READING_2026-09-27.md), without adopting a new project constraint

## Verified Sources And Findings

Pi's installed `pi-agent-core/dist/agent.js` defines a default Model with the `unknown` identity/API, empty URL/input, no reasoning, zero token limits and zero costs. SDK creation can pass an absent model into Agent; `AgentSession.model` returns its state model. Web previously inserted this placeholder into the available catalog as the current selection. This observation concerns the default placeholder, not a rule that custom native providers with unusual metadata cannot execute.

The existing Web Composer also fell back to `models[0]` when no model was current, making an available model appear selected. Its empty model picker was disabled, although the existing settings workflow could configure models without issuing a model request. A refreshed empty catalog could retain contradictory zero-search-result feedback while hiding the search input. Desktop observation additionally exposed a redundant inner frame inside the design system's popup.

## Interaction And Authority

The runtime projection recognizes only the known native placeholder identity and shape. It does not classify models by names, API alone, credentials, history, or membership in the available catalog. Other selected models, including direct/custom selections outside that catalog, retain their current marker. The native Session model and selection/execution paths are unchanged.

The Composer displays only an explicit draft/current selection. Before a catalog arrives its picker reports loading and remains disabled. A confirmed empty catalog instead opens an actionable configuration popup without a meaningless search field; a populated but unselected catalog says Select model. Existing exact-Session, pending-admission, model-selection, and running restrictions remain.

Model settings stays available in an open picker with a populated catalog or zero search matches. Its command closes the popup before invoking the existing settings callback, which opens the Models tab. The native dialog handles initial/return focus. Only model options scroll, leaving search and configuration visible. Catalog refresh can suppress obsolete search feedback without deleting the user's query. The design system owns the popup frame; the duplicate inner frame and unused placeholder prop were removed.

No default model, credential copy, new form, configuration store, model-facing tool, or Send preflight was added. Pi still owns prompt admission, including extension commands and input handlers that can run without a model. A model request can still fail native auth/provider preflight; this UI does not promise successful execution merely because a selection is displayed.

## Validation And Ablation

- Native focused projection/runtime suite: 55 passed, using an actual Agent default with a fail-on-call stream function. Cases cover placeholder omission, same-identity catalog models remaining unselected, real current models outside the available catalog, and identity/metadata differences.
- Picker suite: 26 passed. Earlier combined Composer/draft/context/settings selection: 5 suites / 189 passed before the final dynamic-catalog regression was added.
- Final `bun run test`: 1963 native tests passed, 5 platform tests skipped; 51 UI suites / 851 tests passed. `bun run check`: configuration/docs/discipline contracts, Web/root types, build, format, and lint passed. The existing bundle-size warning remains.
- Removing placeholder projection failed its native regression. Independent review narrowed the initial shape-only check to the known placeholder identity/metadata, preserving custom native model authority.
- Removing close-before-settings failed opener/focus ownership. Restoring the first-model fallback failed the unselected-catalog regression. Both necessary behaviors were restored.
- The stale empty-catalog search-feedback regression failed on its preceding source. Removing the unused selector placeholder and redundant inner popup frame retained the target interactions; those removals remain.

Local engineering gate logs are `/private/tmp/openpi-pr598-model-entry-final-{check,test}-20260927.log`. Native projection receipts are `/private/tmp/openpi-pr598-model-entry-focused-native-20260927.log` and `/private/tmp/openpi-pr598-model-entry-ablation-native-20260927.log`. These are reproducible test receipts, not a formal Benchmark or published private Session evidence.

## Manual Observation And Limits

The isolated 57162 UI/57163 backend was explicitly restarted, with this checkout as the only OpenPI source in `pi list`. At the actual 1280x720 desktop viewport, an empty picker focused Model settings, and Escape returned to its model trigger. In a same-origin 390x844 application iframe, opening the existing Models settings and closing it preserved a synthetic unsent text draft and returned to the exact model trigger. A 320x680 application iframe contained the empty popup without horizontal overflow.

A temporary, explicitly synthetic 50-model component fixture at 320x680 used the actual ModelPicker and styles, not live credentials or a fabricated native catalog. Keyboard ArrowDown then End focused the last option and changed only the options scroll position: 305px visible height, 1898px content, scrollTop 1593px; the configuration command stayed at the same bounds. Removing the inner frame retained readable, contained layouts. Temporary fixtures and agent-created tabs were removed; the user's original tab and resident 57161 service were untouched.

This proves responsive CSS and bounded desktop interaction, not a physical phone keyboard, IME, live authentication save, or model execution. Browser E2E was not run. The embedded screenshot browser still lacks a complete direct composition/text-input host; a separate text-insertion form was considered but not implemented because it would not reproduce native typing. Native Codex window automation again returned its application-level safety rejection; no bypass or live native comparison is claimed. Broader Web iteration remains open in #597.
