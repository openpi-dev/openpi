# Codex chat typography and responsive reading

- Status: validated at the bounded shipped-source and local browser boundaries
- Created / last verified: 2026-10-14
- OpenPI baseline: `3e2f97e011c74d3ad45da2786b5197678839f8c6`, fetched from PR #711 before implementation; the earlier `ee5561cb` comparison is retained separately
- Reference: installed Codex `26.1007.30912` (20156), `com.openai.codex`
- Issue: [#767](https://github.com/openpi-dev/openpi/issues/767)
- PR: [#711](https://github.com/openpi-dev/openpi/pull/711)
- Supersedes: none; extends [the default font investigation](CODEX_DEFAULT_FONT_2026-10-13.md)

## Verified reference facts

The shipped Electron default family remains `-apple-system, BlinkMacSystemFont,
"Segoe UI", sans-serif`. Its platform CSS search did not find a Windows font
replacement. This supports native Mac faces, Segoe UI where installed on Windows,
and generic sans fallback elsewhere. It does not establish actual Windows/Linux
glyph identity or require shipping Apple's fonts. The existing OpenPI `codex`
preference already selects this stack; no additional preference or font asset is
necessary.

The actual assistant renderer selects the same Markdown text style for
commentary and final answers. Its root **and paragraph/list/table children** use
the chat font size with line height 1.625. Electron body weight is 430; the
normal-weight token 400 is not that body default. At 14px this means a 22.75px
line box. Assistant paragraph spacing scales with font size (approximately 1em),
with first/last margins trimmed. A separate rich user-text wrapper uses 20px
paragraph spacing and is not the assistant reference.

Independent conversation blocks use 16px separation. Grouped activity has 4px
between rows and above its body; ordinary 14px tool labels have a 21px line box
without vertical row padding, producing a 25px repeated pitch. Headings use
1.5/1.25/1.125 times chat size, with semibold 600. Consecutive tight list items
have no extra top margin.

Electron's thread wrapper falls back to 16px inline padding. The 640px compact
content cap and 856px **container** breakpoint found elsewhere are browser-mode
overrides, not Electron defaults. The traced layout responds through available
content width and wrapping, without shrinking all text as the window narrows.

## OpenPI implementation and comparison

The source-backed baseline exposed a concrete cascade bug: a parent requested
1.625 line height, but the component library set actual paragraphs to 14px/20px
and weight 400. List items also had independent UI presets. Scoped inheritance
now gives those text nodes the selected chat size, line height and body weight.
Code keeps its monospace face; emphasis and headings retain a separate weight.

Paragraph/list spacing and first/last trimming avoid adding a trailing paragraph
margin to the gap before a tool group. Response/activity siblings now have 16px
separation; grouped tools use a 21px row and 4px gap at default size. Existing
tool-kind chips, disclosure behavior, evidence colors and native state remain.
Coarse-pointer targets retain a 40px minimum, independently of viewport width.

The existing configurable chat-width limit is preserved. Normal chat insets are
16px; below a 560px **chat container**, insets become 12px. The latter is an
OpenPI adaptation, not a claim about an exact Codex mobile breakpoint. Narrowing
a pane inside a wide window now uses the same rule as a narrow window. Font size
continues to be the user's chosen value.

Comparison uses one locally constructed native Pi Session (no model calls), the
same text, expanded tool groups, Chrome, 2x device scale, 1100px height, font14,
and the first assistant paragraph as the scroll anchor. Viewport widths are
1440, 1040 and 390px. A fourth case constrains the chat container to 480px inside
a 1440px window; it is a controlled container test, not a claim of dragging the
native app's pane. Baseline source provenance reports exactly one OpenPI source
through `pi list`, matching the named checkout.

| Measurement | Before | After |
| --- | --- | --- |
| Actual paragraph font / line height / weight | 14px / 20px / 400 | 14px / 22.75px / 430 |
| Desktop grouped tool row / repeated pitch | 30px / 30px | 21px / 25px |
| 480px pane text width | 432px | 456px |
| Wide-window configured text limit | 820px | 820px |

`bun run check` passes. The complete `bun run test`, using an isolated Pi agent
directory, passes 2,516 Node tests (nine platform skips) and 1,453 UI tests across
94 files. An initial run inherited personal configuration and failed six native
renderer/footer assertions; those failures disappear with an isolated directory,
without changing runtime code or weakening assertions.

Ten Chrome browser cases pass, covering actual paragraph/list metrics at
12/14/20px, heading/emphasis scales, small panes inside wide windows, no horizontal
overflow, file-link identity, folded/expanded process spacing, desktop keyboard
disclosures, 40px touch targets, theme persistence and legacy font preferences.
Paired light/dark, narrow and split-pane screenshots were visually inspected.
The comparison keeps the new upstream tool chips and file cues; it does not
substitute the earlier tool presentation for the latest branch.

Ablation removes the scoped text-inheritance rule in the browser: actual
paragraphs regress from 22.75px/430 to 20px/400, so the rule is retained. Removing
the container rule makes a narrow pane lose its 12px inset. An unnecessary
letter-spacing override was removed without changing rendered spacing or
acceptance results. No font loader, breakpoint framework or new preference was
introduced.

## Evidence and limitations

Private evidence identity: `codex-typography-2026-10-14`, under the operator's
`~/.local/share/openpi/evidence/`. It includes provenance, seeded Session,
`before-latest-*` / `after-*` screenshots and computed metrics, checks, and a
reference report with bounded source excerpts, offsets, hashes and archive
member identities. Proprietary source extracts, private settings and raw logs
are not repository assets. This is a local visual comparison, not a formal
Benchmark or a cross-platform rasterization claim.

REA parent Evidence: `ev_783377c9ba9347a806013fe23e0d8a110a06d7c6ac698c9da2179b8fde3fddfe`;
root digest `8d946000f128ca5aadc92ea56c515a90fc1241e195562b324fe4a098bb302910`.
Thirteen selected JS modules parsed without failures; semantic coverage is
partial due to budgets and missing dependencies. Secondary CSS spans were
checked directly. Native Codex runtime customization/zoom and Windows/Linux
rendered faces remain unobserved. The earlier unrelated ASAR native-module
integrity mismatch is not resolved by this focused analysis.
