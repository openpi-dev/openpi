# Web browser chrome

- Status: `validated`
- Created: 2026-10-09
- Last verified: 2026-10-09; repository gates, existing browser regression and local appearance/keyboard checks; no release or new provider acceptance claimed
- Source boundary: OpenPI `e4763f44577c4fc8fd6eec353499f65aebe49411` plus the BrowserPanel/workbar stylesheet iteration on `codex/settings-resources`
- Related Issue: [#729](https://github.com/openpi-dev/openpi/issues/729)
- Related PR: [#711](https://github.com/openpi-dev/openpi/pull/711)
- Supersedes: none

## Accepted direction

The user requested a simple, softer, Apple-like appearance using supplied Codex screenshots as visual references. The existing hierarchy stays intact: workbench tool tabs, browser page tabs, navigation/address toolbar, then the page. This is a scoped presentation iteration, not an adopted new project-wide design system.

Rounded selected tabs replace the previous underlined tool tab and rectangular browser tabs. A lightly tinted chrome background distinguishes both tab rows from the page without an extra ruled line between every row. The capsule address field and grouped back/forward/reload controls have restrained borders and shadows. External-open and submit controls retain their existing positions, labels, keyboard order and actions.

Existing theme tokens supply text, surfaces, selection, hover, border and focus colors. There is no new theme option or persisted preference. The empty browser page now uses the active page theme. The loaded iframe keeps its original white viewport backdrop so transparent websites retain their previous appearance.

## Ownership and scope

BrowserPanel still owns the same page state and delegates enhanced navigation to the existing browser bridge. No browser authority, Session identity, sandbox, resource bound, extension permission, native reading state or cleanup behavior changes. The only markup addition is a plain container around the three existing navigation buttons for their shared capsule surface. Existing workbar tabs receive the same rounded treatment so Browser, Files and other tools share consistent chrome.

Keyboard focus remains visible. Tab focus outlines are inset within their scrollable row so the edge of a focused tab is not clipped. Closing a tab and Home/End navigation retain the existing lifecycle.

## Validation boundary

Local UI inspection covers light and dark empty states, the default preview size, a 1440px desktop layout and a 320px narrow layout. At 320px the document and toolbar remain 320px wide, and the address field remains 104px wide. Long address drafts stay inside the field. Creating tabs, Home/End selection and Delete with focus restoration were exercised without a model request.

`bun run check` and the complete `bun run test` passed. The latter passed 2,302 Node tests with 9 skips and all 1,167 UI tests across 83 files. The existing native iframe browser end-to-end regression also passed using installed Chrome; it covers page input, selection, scrolling, navigation, independent tabs, retained iframe state, popups and keyboard tab closure. No new tests or runtime abstractions were added for this cosmetic change.

These checks do not claim a new provider acceptance, browser-extension release or visual acceptance of every theme. Raw screenshots and command logs remain in the local `browser-chrome-20261009` evidence archive rather than the repository.

## Ablation

Removed the initial inset outline on selected tabs and changed their theme-inverted shadow to the existing workbench's subtle neutral shadow. Selection remains clear through the surface and text color, so the extra outline stayed removed. The change adds no shared component, design configuration or animation layer. The navigation wrapper remains because the three controls need one continuous capsule surface while retaining their independent buttons.
