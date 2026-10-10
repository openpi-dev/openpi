# Web workbar tools

- Status: `validated`
- Created: 2026-10-09
- Last verified: 2026-10-09; scoped component regressions and repository checks; installed-page acceptance is recorded below
- Source boundary: OpenPI product commit `7685f38dc89e958644c9ac9881d7ecb3d494317e`, including the Files menu's 4px horizontal padding, responsive tool-picker wrapping and viewport-bounded menu height
- Related Issue: [#597](https://github.com/openpi-dev/openpi/issues/597)
- Related PR: [#711](https://github.com/openpi-dev/openpi/pull/711)
- Supersedes: none

## Accepted direction

The user requested Files, Terminal and Changes refinements using supplied Codex screenshots and DSH / DSH-better-sidebar as references, with a simple, restrained appearance and controls that explain their purpose. This is a scoped workbar iteration, not a new project-wide design system.

The hierarchy remains tool tabs, current-tool controls, then content. Files retain the existing preview beside a manually controlled file tree and the user's saved panel sizes. Opening the tool picker from an active panel now uses the existing Astryx DropdownMenu rather than replacing its content with the full launcher. The empty workbar retains its descriptive launcher. The expanded workbar has one visible Return to chat action; the separate collapse control is labelled Collapse tools. Closing a controllable terminal tab is labelled End terminal so it cannot be confused with merely hiding the workbar. Read-only tab closure keeps its ordinary Close label and does not claim process control.

## Tool details and ownership

Files expose three text menus: New, Import and More. Menu items explain creating a file or folder, importing files or a folder, multiple selection and the workspace trash. The current target-directory caption remains visible. More uses native checkbox menu items for the existing selection/trash state. Cancelling creation returns focus to the actual New trigger. Unavailable or in-flight write actions use native disabled triggers; tooltip-driven `aria-disabled` would otherwise let the library's ArrowDown handler open a disabled menu. Existing unavailable-write feedback remains in the panel. Save is a visible action/state in editing or dirty preview, with Saving / Save / Saved text and the existing Cmd/Ctrl+S shortcut. A clean preview omits the disabled save control.

Changes retain the native source selector and exact historical/branch comparison at the top. The detail header no longer repeats scope or a fixed Diff mode label. Lists show translated native file statuses and nonzero line statistics, so a zero-line rename remains understandable. Total and loaded-file counts share one location; incomplete evidence still avoids claiming exact counts. Explicit viewed checkboxes remain scoped to the same Session and revision. There is no automatic inference that opening or scrolling a diff means it was reviewed.

Terminal shows the directory basename with the full path available in its title, connected text, and a labelled reconnect action. Its body font increases from 12px to 13px within the existing terminal palette. A Return to bottom button is derived from the actual xterm viewport/base positions and preserves the existing reading-state owner. New output does not force a manual reader to the bottom. Restored positions are synchronized after xterm clamps them. A native reset after a known output cursor displays an output-resynchronized notice; initial replay into a fresh display does not claim lost output. PTY identity, creation, input, replay offsets, exit evidence, restart confirmation and cleanup remain owned by the existing host and terminal component.

Controls reuse existing theme and focus tokens. The refined Files menu triggers, workbar header actions and terminal status/return controls are 32px high for fine pointers and at least 44px high for coarse pointers. Existing tab-close targets remain 28×28px, or 40×44px for coarse pointers; the Changes refresh action retains its existing 28×28px target. Supporting workspace/directory text is at least 11px. No theme preference, provider configuration, terminal lifecycle, Git mutation capability, model-facing tool or additional storage owner is added.

## Reference boundary

Static source comparison uses the latest inspected DSH-better-sidebar source, `e35120f1d9b3773062b68decb4f53a526d6c8baa`, including its [file tree](https://github.com/omdsh-dev/DSH-better-sidebar/blob/e35120f1d9b3773062b68decb4f53a526d6c8baa/src/client/FileTree.tsx#L1768), [labelled UI kit](https://github.com/omdsh-dev/DSH-better-sidebar/blob/e35120f1d9b3773062b68decb4f53a526d6c8baa/src/client/ui/kit.tsx#L28), [editor host](https://github.com/omdsh-dev/DSH-better-sidebar/blob/e35120f1d9b3773062b68decb4f53a526d6c8baa/src/client/EditorHost.tsx#L421), [changes tab](https://github.com/omdsh-dev/DSH-better-sidebar/blob/e35120f1d9b3773062b68decb4f53a526d6c8baa/src/client/changes/ChangesTab.tsx#L205) and [tool definitions](https://github.com/omdsh-dev/DSH-better-sidebar/blob/e35120f1d9b3773062b68decb4f53a526d6c8baa/src/client/builtins/tabs.tsx#L9).

Live comparison separately used the already installed DSH 0.1.7-rc.1 with sidebar 0.22.1 at a loopback-only experimental port, an isolated DSH home and synthetic workspace. It is not live acceptance of the latest plugin source. A connection-only prompt using the existing OpenPI GPT-6.1 Sol / medium connection returned the requested connection-success text without tool calls. This reply does not prove PTY capabilities or provider coverage. Live UI inspection covered file opening/edit controls, staged/unstaged/untracked/deleted Git entries, diff navigation and terminal input controls. Visible terminal controls do not establish PTY identity, an input round trip, resize or cancellation behavior. The observed DSH plus action opens a launcher tab; OpenPI's anchored picker is this iteration's improvement, not a claim about DSH's current UI. DSH's stage/commit controls and small icon targets were not copied into OpenPI.

The interactive layout sketch is a local demonstration, not a running backend or evidence of terminal/model execution. In particular, its tree placement is illustrative; the installed OpenPI tree keeps its existing side and sizing ownership.

## Installed OpenPI acceptance

Manual acceptance used the installed OpenPI page at loopback port 57161. Functional interactions below used `a2d86c07`; final responsive layout and focus acceptance used `7685f38d`, whose later changes only constrain menu width, wrapping, height and Files trigger spacing. These observations are separate from component regressions and the DSH comparison.

| Area | Observed result |
| --- | --- |
| Files preview and creation | Opening a file kept the preview in place. The target directory was `docs`; cancelling creation returned focus to the New trigger. Creating `docs/sidebar-acceptance.md`, editing it and pressing Cmd+S reached the saved state. |
| Files selection | More exposed the existing multiple-selection state as a checkbox menu item, and toggling it updated the checked state correctly. |
| Tool picker and focus | Opening the anchored picker kept the editor visible; Escape returned focus to the active tool tab. |
| Changes evidence | The untracked file showed `+8` and exactly eight added diff lines. The staged scope showed a genuine empty result with zero files. Explicit viewed marks were retained. |
| Terminal reading | Reading around output 129/130 stayed in place when new `LIVE` output arrived. Clicking Return to bottom revealed `LIVE12` and `COMPLETE`. |
| Terminal replay | Collapsing and reopening the workbar restored native terminal output without an initial output-resynchronized notice. |
| Final desktop and narrow layout | At 1280px, the three Files menu triggers shared the same 32px-high row. At a 320×800 viewport, the tool picker measured 296×316px, all five descriptions fit inside it, and document width stayed 320px. Escape returned focus to the active Files tab. The temporary viewport was reset. |

Only the PTY created for this acceptance run was closed. A temporary terminal request failure exposed the labelled reconnect action; clicking it restored the terminal. The underlying failure cause was not established, so it is not attributed to a product defect or claimed as a network fault-injection test.

Installed provenance was verified before acceptance: Node 24 and Pi 0.99.1 reported one OpenPI package, the resident checkout at `7685f38d`. Served `app.js` and `styles.css` bytes matched that checkout's rebuilt assets. The saved fixture Session title includes the earlier 56K experiment; native capacity is now restored to 128,000 tokens. This sidebar iteration did not change context configuration.

## Validation and ablation

Scoped validation passed Files/Artifacts: 50 tests across four suites; Terminal/workbar recovery: 42 tests; shared workbar menu/session-position: 27 tests; exact saved-turn review: seven tests. Existing assertions preserve write identity/revision, read-only behavior, saved versus live Git evidence, bounded Session positions, browser detachment and manual reading restoration.

The combined product passed `bun run check` with exit code 0, including the Web asset rebuild. `VITEST_MAX_WORKERS=1 bun run test` passed 2,324 Node tests with nine skipped and zero failures, followed by 1,254 UI tests across 84 passing suites. The archived logs are `openpi-sidebar-check-final.log` and `openpi-sidebar-test-final.log` in the evidence bundle below.

Delivery evidence is archived at `/Users/admin/.local/state/openpi-web/evidence/sidebar-tools-20261009`, outside Git and excluding credentials. The bundle includes `native-acceptance.json`, screenshots, validation logs and a SHA-256 `manifest.json`; private connection settings and Session transcripts remain outside the published record.

Ablation removed repeated menu-trigger glyphs, duplicate viewed/scope summaries, a redundant terminal return-action synchronization call, and a controlled tool-picker state. Native Astryx menu ownership and existing workbar selection/focus remain sufficient. Synchronization after restored xterm output remains necessary: removing it leaves a saved viewport of 80 when xterm has actually clamped to 50, and the regression fails. Disabled trigger tooltip removal also has red/green evidence: read-only and in-flight menus opened via ArrowDown before the fix and remain closed afterward. No additional design framework survived this iteration.
