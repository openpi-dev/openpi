# Workflow TUI projections and image ownership

- Status: validated at source/component boundaries; real terminal pixels and fullscreen graphics acceptance remain unverified
- Created / verified: 2026-10-04
- Source boundary: `71d12eed69827dfea9b5d85236d1cbb5b94a6a11`, locked Pi packages 0.99.1
- Issues: [#656](https://github.com/openpi-dev/openpi/issues/656), [#657](https://github.com/openpi-dev/openpi/issues/657), [#658](https://github.com/openpi-dev/openpi/issues/658), [#660](https://github.com/openpi-dev/openpi/issues/660)
- Supersedes: none

## Operator projections

The normal Workflow activity strip retains the selected run name and management entry. Phase, count, elapsed time and usage remain in the existing dashboard. Footer running counts do not duplicate the strip; aggregate failure/uncertainty remains visible even when another run is selected. No canonical usage, model context, execution or persistence contract changes.

Completion notices carry display-only severity derived from structured cleanup facts. A finalized committed handoff is information. Inspected, preserved dirty/ignored files can be information; failed capture, finalization or removal remains a warning. Actual execution failure remains an error. Missing legacy severity is conservative warning. Text labels accompany color. The operator projection does not rewrite stored results or imply tests/review/business acceptance.

## Image seam and partial resolution of #657

The locked Pi public `compositeTuiLine` returns image lines unchanged, even under a full-width overlay. A regression fixture proves this with Kitty and iTerm protocol sequences and executes the actual SDK `InteractiveMode.showExtensionCustom` mounting path.

Regular mode uses the native custom-editor page instead. Its height subtracts trailing mounted widgets/footer through public Container/TUI components; the same budget reaches child details. The native renderer's public clear-on-shrink policy is temporarily enabled while this page owns the editor. After Pi restores the editor, a native render restores the visible chat images and the previous policy is restored. No graphic escape deletion, image capability toggle, attachment/session mutation, or host method replacement occurs in production.

Fullscreen uses its existing native overlay boundary, owned by the custom page's disposable handle. The fullscreen chat viewport reserves transcript space and shrinks an inline editor dock; using the regular solution there would leave an image row and clip navigation. The source-level fixture exercises the actual locked fullscreen layout. **Its underlying image compositor defect remains unresolved; #657 must stay open.** Missing a public layout getter prevents safely replacing and restoring the host root. An upstream opaque-overlay/image lifecycle seam is the remaining owner work, rather than copying the host layout into OpenPI.

Small pages use bounded compact chrome, keep the back/close binding visible, and restore the normal view after resize. Child page scroll/follow state is preserved.

## Validation and limitations

Targeted native-page, dashboard, child-page and shared timeout suites passed 74 tests after review corrections. Fixtures cover repeated opens/closes, editor draft preservation, variable footers, resize, 4/5-row terminals, regular image exclusion/restoration, fullscreen navigation/handle cleanup, and unchanged renderer policy after closing. Protocol rows are synthetic; they are not actual terminal pixel screenshots.

Independent review found and corrected fullscreen inline clipping, low-height overflow, and incomplete image-restoration assertions. Thinking/tool rendering and follow semantics are recorded separately in [CHILD_SESSION_EXPERIENCE.md](../design/CHILD_SESSION_EXPERIENCE.md).

The user's installed Pi source differs from this candidate checkout. Installation/configuration were not changed. Computer-use access to Ghostty was denied by the tool, so no real terminal visual acceptance is claimed. Fullscreen graphics, real terminal behavior, and upstream integration remain explicit unknowns; this record does not close #657.
