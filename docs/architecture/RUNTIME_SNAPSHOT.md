# Parent runtime snapshot

- Status: draft
- Created: 2026-10-04
- Verification boundary: source/tests only; no installed-runtime or TUI smoke
- Source boundary: #651 implementation based on `c7862b852d866123e2b32c79d309bd49a3cf515f`, rebased onto `94f6dfb29343a699010440f37734ac14582c84af`, principally `extensions/runtime-snapshot/index.ts`
- Related Issue: [#651](https://github.com/openpi-dev/openpi/issues/651)
- Related PR: not opened
- Supersedes: none

## Native ownership and discovery

`openpi_load_tools({groups:["runtime"]})` activates `runtime_snapshot({})` through the existing tool-surface owner gate. The gateway's no-argument listing advertises the group. Registration is inactive, ordinary sessions gain no resident tool, and there is deliberately no runtime prompt-keyword activation or new setup preference. Once explicitly loaded, the group stays stable until the Session resets, like other capabilities.

The tool is parent-only, classified in `CHILD_EXCLUDED_TOOL_NAMES` and covered by the existing bidirectional tool-surface/drift guards. It creates no authority store, model/provider stack, polling timer, persistence entry, or resource manager. It never calls auth/model-registry methods or models. Owner lookup uses the existing SessionManager-scoped Web observer registry, without subscription or detail requests; the optional kind filter isolates owner failures without changing existing callers.

## Facts, uncertainty, and privacy

| Section | Evidence and limitations |
| --- | --- |
| `configured` | Fresh Pi effective settings and the existing package configuration inspector, projected separately. Configuration provenance is effective-settings versus package-defaults/package-config-disk; individual Pi override layers are unavailable. Owner error diagnostics make invalid/unreadable package configuration unavailable, not silently described as valid defaults. Warning-only/valid inspections remain available regardless of write eligibility; the snapshot does not attest that configuration can be written. |
| `sessionSelected` | Fresh `ctx.model` and Pi thinking level. Model presence requires a complete provider/model pair of nonempty strings (whitespace-only is invalid), including package suggestion/role overrides. An incomplete or invalid selected/configured pair reports presence false and equality unknown. Selection never proves upstream route. |
| `trust` | Live `ctx.isProjectTrusted()` decision only. Persisted Trust and role restrictions are unavailable. Trust/tool availability is not an OS/filesystem sandbox. |
| `toolBoundary` | Pi's active tool names, explicitly marked `active.scope: allowlisted-projection` and `active.completeness: unknown`, limited to public native/OpenPI names. These markers are constant even if nothing was filtered; omitted counts cover only locally truncated allowlisted names, never filtered names or counts. This does not attest ownership of every active definition or the callable/deferred tool universe. |
| `packageProvenance` | Pi Tool SourceInfo scope/origin for this exact runtime tool definition, when available. It does not infer a single OpenPI package source from one matching tool. |
| `disk` | Separately sampled Git HEAD/dirty for the package directory's containing Git worktree and current project directory's containing Git worktree. A nested cwd still samples the entire containing worktree, including changes outside that directory. Dirty includes tracked changes and normal untracked status (`--untracked-files=normal`), and checked-out/staged gitlink revision changes, not ignored files or nested submodule contents (`--ignore-submodules=dirty`). No paths, branches, remotes, diffs, filenames, or Git error strings are returned. Non-Git/unborn repositories, timeout, and oversized status return unavailable. |
| `loaded` | Extension factory registration timestamp, **not** a code-load timestamp or unique loader identity. Revision is always unknown: disk HEAD cannot prove loaded code. Pi/OpenPI versions remain unavailable without immutable loader/build provenance. |
| `resources` | Existing owner summaries, statuses only, with owner query tool names. Absent or failed owners are unavailable; registered owners with no entries are available/empty. Terminal entries may remain in the owner's sample and are not falsely labeled active. |

Strict allowlisting excludes raw settings/configuration/environment, paths, accounts, arbitrary provider/model identifiers, credentials, headers, endpoints, prompts, commands, titles, resource IDs, transcripts, and exception messages. Model identifiers are intentionally redacted even if they look benign: custom identifiers can themselves contain secrets or account data. The model-match boolean allows diagnosis of configured-versus-selected divergence without copying identifiers. Use ordinary authorized owner queries for more detailed inspection; the snapshot does not widen those tools' authority.

Each section has an availability marker and sampling time. The response includes start/completion times and explicitly declares non-atomic sampling. Model switches, edits, owner settlement, reload, or concurrent calls can produce different samples; no cached projection is reused and no common cross-owner epoch is claimed. Cancellation propagates as a failed operation, not a complete snapshot.

## Bounds and side effects

- At most **32 status entries total** across owners, in subagent/workflow/background order; omitted counts include both owner and snapshot omissions. `omittedCountKind` is `exact` unless the upstream owner reports truncation, when it is a conservative `lower-bound` (including zero): upstream truncation may reflect shortened metadata or an incomplete inventory, not a proven exact count.
- At most **64 allowlisted active tool names**; omitted counts include only allowlisted names beyond that limit.
- At most **16 KiB UTF-8 for the entire serialized tool result**, including both content and details. An oversized result becomes a small explicit unavailable/output-bound result, never a silently cut JSON document.
- Disk queries use fixed, shell-free Git arguments, no optional locks, disabled fsmonitor/untracked-cache, an 8 KiB subprocess output limit, and a 1-second timeout per command. A copied subprocess environment removes repository-selection/discovery overrides (including Git directory, worktree, common directory, index and object paths) so `-C` samples the explicit cwd's containing worktree or returns unavailable. Parent environment and unrelated Git/user configuration remain untouched. They do not refresh an index, run an owner command, install/reload, or start background work.
- Configuration inspection is read-only. No configuration, lifecycle, default isolation, highlight behavior, or expensive-work opt-in changes are introduced.

## Validation and diagnostic comparison

Focused source tests cover gateway discovery/non-residency, child classification, raw private values, fresh model/thinking/Trust/tool changes, unavailable versus empty owners, independent owner errors, total entry/byte bounds (including complete results collected from large owner metadata), private tool names excluded from omission counts, incomplete selected/configured model identities, dirty/non-Git/nested-cwd disk samples, ignored-file and nested-submodule-content exclusion with checked-out/staged gitlink detection, read-only valid/default configuration versus owner parse/read/validation errors, and cancellation. Runtime state, model-visible results, and gateway tests are separate from TUI behavior; no UI renderer is added.

For the diagnostic task “does the selected model match the effective default, and does disk HEAD prove the loaded revision?”, the test fixture answers both from one snapshot and asserts that an available disk HEAD still leaves loaded revision unknown. After the runtime group is loaded this takes one tool call; loading costs one additional gateway call. This is a deterministic regression demonstration, **not** a measured model misjudgment/latency benchmark or evidence of real TUI/CI behavior. No hidden model evaluation is performed. Full commands/status and baseline-versus-new suite failures are recorded in the implementation receipt, not inferred from these assertions.
