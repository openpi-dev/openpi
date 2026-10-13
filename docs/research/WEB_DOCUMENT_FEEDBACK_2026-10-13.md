# Web conversation continuity and typography

- Status: validated
- Created: 2026-10-13
- Last verified: 2026-10-14
- Source boundary: PR #711 at `444cdd2fd5030800cfc1674a307a208b06c64371`, Pi 1.2.0, integrated with the scoped fixes in `4a2f5af8` described below.
- Related Issue: [#763](https://github.com/openpi-dev/openpi/issues/763).
- Related PR: [#711](https://github.com/openpi-dev/openpi/pull/711).
- Supersedes: none; earlier activity and configuration investigations retain their original boundaries.
- Private evidence archive: `document-tool-issues-20261013` under the operator's OpenPI Web evidence directory. User documents, screenshots, Session data and extracted application code remain outside Git.

## Observations and changes

The supplied document records a running duration that disappears, a repeated user bubble after retry, an inactive conversation composer, expanded thinking, and typography differences. Screenshots establish the visible symptoms; they do not identify every preceding client action.

The live `turn_started` projection discarded the native clock and input identity, and the transcript read its active timing only from snapshots. The repair retains those event fields and lets the exact active turn supply the duration before the next snapshot. An older snapshot cursor cannot erase a newer start or revive a settled run; stream resets and changed Session identities still discard the old event state. Reading a verified history window retains the clock only when its owning prompt is present; an older visible turn never inherits a newer run's duration.

The manual provider retry button previously called ordinary prompt submission with the original text. This persisted a second user message. The corrected path binds retry admission to the exact latest failed assistant entry and preserves the original conversation context instead of resending the prompt. The existing HTTP receipt binds the retry entry as well as the Session and command identity; changed and stale requests are rejected.

Pi 1.2.0 has no public Session-level empty-turn method. The implementation uses `sendCustomMessage` with `triggerTurn: true`, preserving Pi's execution, cancellation and settlement lifecycle. It persists a hidden custom entry containing the explicit operator fact, “The user requested retrying the interrupted response. Continue from the existing conversation.” This fact is model-visible; it is not an invisible empty request or a duplicate of the original user text/images. No ordinary user bubble is added. This differs from Codex's empty-input API described below.

When steering adds a user entry during a failed turn, retry uses the existing native timing entry after that failure to retain the original owning prompt. The latest user entry is only a legacy fallback when no recorded owner exists. Existing records are not rewritten.

The composer intentionally disabled input whenever the viewed Session differed from the host's active Session. Explicit Send now prepares that exact viewed Session, verifies its ID and path, and then uses the existing guarded prompt admission. Reading and refreshing remain passive. Failure preserves the draft; another Session's running, model and queue state does not become this composer's state. The screenshot does not prove which client caused the original selection difference.

Thinking was already collapsed by canonical default. The resident instance had explicitly saved `ui.webExpandThinking=true`; changing that preference to false through the existing writer fixes this instance without changing the meaning of an explicit preference. The writer also materialized the already-effective `codeMode.enabled=true` default. Other preferences were preserved.

The existing font selector and 14px default remain authoritative. The concurrent [Codex default font change](CODEX_DEFAULT_FONT_2026-10-13.md) remains intact. This change adds inherited weight 430 and gives ordinary response/user text a 1.625 line height with normal tracking. Custom font settings still use the same canonical preference and theme bridge. The font investigation found that both old and new default stacks resolved to SFNS/PingFang on its tested Mac; the stack change alone does not establish a visible font-face improvement.

## Codex comparison and limits

The installed target was Codex bundle `com.openai.codex`, version `26.1007.30912` / build `20156`, physically named `ChatGPT.app`. Its ASAR SHA-256 was `75e397e2280dde93b70a85aa926f4282c728eacc84dfeb15ba7fb6ddd84628af`. Older extracted versions were not treated as current evidence.

REA parent `ev_b6852461c8e3385c6fb8c48d422687864b1f041356bd368bc3b53cb8f42c0667` covers the selected typography/turn assets. Exact CSS and component inspection establishes the ordinary Electron system stack, 14px size, inherited 430 weight, 1.625 Markdown/user line height and zero tracking. OpenAI Sans assets were not copied. The supplied screenshot's actual theme overrides, zoom and CJK font fallback were not measured, so pixel parity is not claimed.

Focused parent `ev_f8883d5d75873c95f6cf9d6cf321016efe1eb87068435a6e0a3aff5a2dd622d5` covers six exact functions. Codex's elapsed component uses explicit status and start/end timestamps, independent of text arrival. Its capacity-error retry path checks the latest failed turn and ready Session, then calls `startEmptyTurn` with `input: []` unless an explicit continuation input is supplied. This proves that particular shipped path does not duplicate the user's text; it is not a claim about every provider error or observed runtime execution.

The large slice has partial semantic graph coverage. Exact source receipts and focused declarations support these positive findings; incomplete graph searches are not evidence of absence. The exported REA bundle and byte-range receipts are retained privately.

## Validation

After integration of the concurrent font and tool-display changes, `bun run check` passed; `bun run test` passed 2,516 Node tests (nine platform skips) and 1,453 UI tests. Native Pi 1.2.0 tests exercise a text/image prompt, completed tool result, provider failure, manual retry and cancellation. They verify one original user entry, no repeated completed tool, preserved steering owner, stale retry rejection and native terminal outcomes. Host and UI tests separately cover receipt identity, delayed snapshots, history clocks and hidden retry submission.

The integrated real Chrome conversation/settings/Session checks passed all 11 cases, including the concurrent legacy-font import case. The native two-Session continuation case passed after correcting its isolated provider/auth fixture. It verifies that explicit Send reaches the viewed Session while the other Session continues, with draft clearing only after accepted submission. Thinking preference and browser inspection confirmed collapsed details. These checks use isolated local Sessions and deterministic providers; they do not measure provider latency or claim the original 21-minute task became faster.

After integrating `444cdd2f`, the six affected conversation/Session browser cases passed again. The font/settings source did not change in that integration, so its five already-passing browser cases were not repeated.

Simplification removed a redundant retry lifecycle listener in favor of the existing native listener, and removed a redundant response font-weight override in favor of body inheritance. A composer ablation removed viewed-Session running/queue guards; its regression then exposed another Session's queued-message state, so those guards were restored. No new orchestration layer, font setting or retry configuration was added by this change. Integration gates and resident deployment receipts are retained with the private evidence archive.
