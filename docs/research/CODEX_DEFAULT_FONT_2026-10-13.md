# Codex desktop default font and OpenPI appearance

- Status: validated at the bounded static-source and local OpenPI browser boundaries
- Created: 2026-10-13
- Last verified: 2026-10-13
- Source baseline: OpenPI `f628467167e9200b589606cf0523394e0e9e9bba`, with the font change in the linked PR
- Reference: installed Codex `26.1007.30912` (`20156`), bundle ID `com.openai.codex`
- Issue: [#767](https://github.com/openpi-dev/openpi/issues/767)
- PR: [#711](https://github.com/openpi-dev/openpi/pull/711)
- Supersedes: none

## Observations

The installed desktop CSS declares `--font-sans-default` as
`-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`. The default
content family resolves through the UI family unless separately overridden.
Its browser-window-specific override has a different stack; that selector is
not the desktop reference. The shipped base UI font setting defaults to 14px.
OpenAI Sans is present as a separate opt-in CSS family, not this default.

The font picker and selected-face loader retain a distinction between a default
family and an explicitly selected local face. Custom faces use `FontFace` with
local PostScript/full-name sources. Matching the ordinary desktop default does
not require copying font files, enumerating local fonts, or a new loader.

On this Mac, Chrome's `CSS.getPlatformFontsForNode` resolves **both** OpenPI's
previous `ui-sans-serif`-first stack and the desktop Codex stack to `.SF NS`
(`.SFNS-Regular`, San Francisco/SF Pro) and `PingFang SC`. A different CSS stack
string therefore does not prove a visible improvement on this platform. The
new OpenPI native-Session preview confirms those actual text faces; its code
block still uses Menlo with PingFang for Chinese glyphs.

## Implementation and validation

`ui.webAppearance.font` defaults to `codex`, labelled **Codex default / Codex
默认**. Reading an older `system` value and importing an older version-1 theme
maps it to `codex`, preserving the other appearance fields. Reading does not
rewrite the settings file. Explicit sans/serif/mono selections remain valid.
The existing canonical writer, setup tool and no-argument status own this
preference; there is no new browser preference store.

One CSS default serves the initial page and the provider's default/legacy font
choices. Body, themed components, sidebar, settings and ordinary text inherit
it; code retains its existing monospace stack. Font size remains 14px and the
light/dark **mode** can still follow the system. Font glyphs depend on the
platform; this does not bundle Apple's fonts for Windows or Linux.

- Configuration regressions cover defaults/status, legacy reads without file
  mutation, explicit saves and preservation of custom choices.
- `bun run check` passes. The complete `bun run test` passes with 2,500 Node
  tests, nine platform skips and 1,421 UI tests across 94 files. Earlier runs
  exposed four stale default-value assertions; those were updated to `codex`.
- Five installed-Chrome appearance cases pass, including default menu labels,
  legacy import/reload, rejected writes, dark mode and narrow/touch layouts.
- An isolated Pi 1.2.0 Web process reports exactly one OpenPI source through
  `pi list`, matching the named checkout. Real UI saves switch to serif and
  back to Codex, survive reload and persist `font: "codex"` on disk. Its
  locally constructed native Session contains mixed Chinese/English prose and
  code without making a model request. Desktop/narrow and light/dark screenshots
  were visually inspected.
- Ablation restores the old stack in the preview: actual font faces remain
  the same, so no claim of a cosmetic font-face improvement is made. Removing
  the CSS default before the provider's override causes a Times fallback;
  retaining the first-paint definition is necessary. No font loading framework
  or proprietary assets are added.

## Evidence and limits

Private archive identity: `codex-font-2026-10-13`, under the operator's local
OpenPI evidence directory. It retains the selected exact asset bytes, REA
bundle, test logs, source-backed preview receipts and screenshots. These raw
artifacts are not redistributed in Git.

- ASAR SHA-256: `75e397e2280dde93b70a85aa926f4282c728eacc84dfeb15ba7fb6ddd84628af`.
- CSS `app-shared-9a94b907ed47.css` SHA-256:
  `69f929f71947824fed18365d54c8aa0c975a856649339e585a50f6f547e215d7`.
- Font helper `theme-font-family-483011cfdef9.js` SHA-256:
  `71ac347e6aeb63b0dbd44b67521b11e47854ec3212e82ed75f610152e2d731da`.
- REA subset analysis:
  `ev_f65d2dd1a8a740736d3e1be8b1e555cd09487c1cc6488d788a89d7ad2892f044`.
  It parses five exact extracted font-related JavaScript files. The large
  general-settings module retains static facts with partial semantic coverage.

Whole-ASAR analysis encountered an unrelated unpacked native-member integrity
mismatch; a record-and-continue attempt timed out without a retained result.
The successful subset investigation does not validate whole-archive integrity.
REA observations and CSS inspection are static, not live Codex execution.
No desktop CDP endpoint was available; the user's personal Codex font override,
zoom and smoothing settings were not inspected. Windows/Linux glyph rendering
and pixel-level parity with the user's screenshots remain unverified.
