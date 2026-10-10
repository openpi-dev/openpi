# Web model connections

- Status: `validated`
- Created: 2026-10-10
- Last verified: 2026-10-10
- Source boundary: native account implementation `5ed9fb8b7a8a38e9e837c3c17d1de912a486a916`; integrated three-entry layout and icons `2c59d44f86b143ce87131763a8e61fe23c73ebcf`
- Related Issue: [#732](https://github.com/openpi-dev/openpi/issues/732)
- Related PR: [#711](https://github.com/openpi-dev/openpi/pull/711)
- Supersedes: none

## Requested direction and references

The user requested a simple, restrained model setup page with native account login. Their later annotated screenshot places Account next to the existing Third-party providers and Custom model API choices. Existing connections remain above this area; unused account providers no longer occupy permanent connection rows. The existing settings shell and custom-model editor remain the owners of navigation and model definitions.

[OpenCode's provider documentation](https://opencode.ai/docs/providers/) and its real provider dialog informed the progressive choice: select a provider, then use its supported authentication method. The inspected UI displayed version 1.18.35; it was served through an isolated local OpenCode 1.2.20 backend. Provider settings and the OpenAI method dialog were visible, but the newer frontend's Session loading failed against that older backend. The saved dialog crops are appearance references only, not evidence of working OpenCode account authentication. The unmodified viewport captures remain with them outside Git.

Pi Web was inspected at `550a17f8fc7837bc53d0f978791fad72a2100b07` in its OAuth flow service and AuthDialog. Its older Pi callback interface is not copied into this implementation. OpenAI's [authentication documentation](https://developers.openai.com/codex/auth) supports distinguishing account access from API-key access; it does not determine which login methods a particular installed Pi provider offers.

## Pi ownership and bounded interaction

Pi 0.99.1's ModelRuntime login/logout methods own credential serialization, persistence and model refresh. The Web Host adapts its AuthInteraction prompts and notifications to a bounded, ephemeral projection for the active Session. There is no direct credential-file reader/writer, model prompt, new authentication library or account preference.

Only one login can run in a Host at a time. Each request carries the exact Session, provider, flow and prompt identities. Starting requires an idle Session; competing model/configuration changes and prompts are rejected while the native flow is active. Cancellation aborts the native interaction and remains observable as cancelling until its promise settles. A committed credential wins a late cancellation. Host disposal waits for cancellation and native callback cleanup. Terminal projections remove authorization URLs, device codes and prompt contents. A saved credential whose model refresh failed is reported as saved-but-reload-required.

Provider capabilities come from Pi, rather than a UI list of supported account brands. In the inspected Pi version, `openai` uses the unified ChatGPT browser flow and a native device identity; `openai-codex` is the legacy provider that offers browser/device-code selection. The Web renders only the prompts actually emitted, including manual callback fallback when needed. It never adds a device option to a browser-only native flow.

## Interaction and appearance

Account is one of three entries in the existing segmented control, alongside Third-party providers and Custom model API. The account service selector uses the native catalog, with a short explanation and one sign-in action. It does not expose API addresses, model details or another nested Account/API-key selector. The third-party entry contains API-key providers; OAuth-only providers remain discoverable through Account. Custom model definitions keep the existing revision-checked editor and discovery.

All three entry points preserve their drafts while switching. Settings navigation and method selection remain locked during active native authorization; cancelling waits for native termination. Browser links require an explicit click and open with `noopener noreferrer`. Manual authorization input is masked and progressively disclosed. A lost status request is shown as uncertainty, with a status refresh action; it does not announce authentication failure or start a duplicate login. Successful login refreshes the configured connection list. Sign-out uses a confirmation that explains Pi's shared credential scope.

The page keeps existing theme colors, 16px provider cards, soft segmented surfaces and a single settings hierarchy. Provider names have matching monochrome brand icons in the selected value, options and configured rows. Assets come from OpenCode revision `388406238bd5ca15564a762840a2362c3a45bd9c`, with the MIT notice retained. SVG masks follow the current text color and stay local to the bundle. Unmapped/custom provider IDs retain a name monogram; a brand alias never changes Pi's provider identity or authentication capability. The existing Astryx Selector owns keyboard navigation, focus and the dropdown lifecycle; no new picker framework, font system or visual preference is introduced.

## Validation and limitations

The service, Host, real Pi ModelRuntime and UI behavior are tested independently. Service tests cover exact identities, expired/cancelled flows, prompt invalidation, late commits and terminal redaction; Host tests cover authenticated routing and bounded inputs. A real Pi fixture verifies native credential ownership without contacting an external account service. Browser fixtures cover status recovery, masked callbacks, confirmed sign-out, device prompts and narrow light/dark accessibility.

Actual local Pi browser flows were started and cancelled for the registered OpenAI and Anthropic providers at source `5ed9fb8b`. Both emitted a native authorization link and manual fallback. Their callback listeners were released after cancellation; only the Web Host port remained. This validates native entry and cancellation, not a completed external account authorization, token exchange, subscription entitlement or a new model call. The user's existing local model connection was retained.

At `2c59d44f`, `bun run check` passed the configuration/docs/discipline checks, Web type/build checks, formatting, lint and root TypeScript. The complete `VITEST_MAX_WORKERS=1 bun run test` passed 2,330 Node tests with nine platform skips and 1,261 UI tests across 85 files. The seven installed-Chrome regressions passed: account/browser and device fixtures, both side-conversation cases, resource settings, General preferences and model editing/discovery. Account picker checks cover keyboard selection, Escape focus, no automatic login/write on selection, 320px bounds, and AA accessibility in actual light/dark color-scheme modes. Real preview inspection confirmed the selected value and options, including the adapted Cursor/Antigravity marks. Existing bundle-size and JSDOM capability notices remain.

Final receipts and screenshots are retained outside Git under evidence identity `01a11ad3-f3c1-7da0-b791-cde3e3be237b/side-conversation-20261009`: `provider-icons-final-check.log`, `provider-icons-final-test.log`, `provider-icons-final-browser.log`, the source-backed preview receipt, and `opencode-reference/` screenshots. This is an operator evidence reference, not a public benchmark or portable acceptance claim. External account authorization and new-commit CI are outside this validation.

## Ablation

Removed a proposed runtime wrapper around native login/logout; the existing serialized settings mutation seam already enforces the required ownership. The same Host tests passed without the wrapper.

The first three-entry layout passed its UI checks with a forced connection-method prop on the general provider editor. That prop, the editor's model draft state and its advanced fields were then removed from the new Account path. Rendering the existing native login component directly preserves the requested interaction with less state and no nested method selector. The same UI checks validate the simpler version. Existing configured dual-method providers still use their native Account/API-key editor.

The icon pass removes Cursor's opaque app background and Antigravity's eleven color filters, retaining their actual mark paths. The shared monochrome presentation then needs no per-brand color/theme state or SVG filter machinery. Real browser inspection caught and corrected the solid-square result of applying an alpha mask to Cursor's original app tile. Narrow theme checks use the browser's actual color-scheme preference so both the app and design-system theme update together, rather than altering only the root attribute.
