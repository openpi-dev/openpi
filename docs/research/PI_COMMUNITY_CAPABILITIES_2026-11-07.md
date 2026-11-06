---
status: validated
created: 2026-11-07
last-verified: 2026-11-07
applies-to: OpenPI 1120cafcd3f5c1ad466df1c7b823976a3e911f72; installed Pi SDK 1.2.0; pinned community sources below
related-issues:
  - https://github.com/openpi-dev/openpi/issues/913
related-prs:
  - https://github.com/openpi-dev/openpi/pull/914
  - https://github.com/openpi-dev/openpi/pull/915
supersedes: none
---

# Pi community capability investigation

This record preserves a source audit and bounded local experiments, not a new
architecture constraint, benchmark ranking, or claim that the referenced
packages are production-validated in OpenPI. Delivery is tracked in [#913](https://github.com/openpi-dev/openpi/issues/913).

## Sources and current gaps

| Reference | Fixed revision | Mechanism worth evaluating | OpenPI baseline |
| --- | --- | --- | --- |
| [pi-context-view](https://github.com/dimk90/pi-context-view) | `304681589f5cb7b47f7152b73637841a89fd3972` | Observe context composition and expose unattributed contributions honestly | Token totals, context occupancy and prompt/tool fingerprints exist; no composition view |
| [pi-lens](https://github.com/apmantza/pi-lens) | `7589a95232f8521e1f71a435e4e403d446857035` | Symbol lookup, module outline and verbatim symbol reads | Native read/grep/find/ls; no package-owned semantic navigator found |
| [pi-lsp / context management](https://github.com/ian-pascoe/pi-extensions) | `32f4991e824e2ef03872707229c59ddde80f0b9b` | Diagnostic baselines and explicit unavailable/timeout states; read-only history retrieval | No package-owned LSP implementation found; Pi owns Session history |
| [pi-review-loop](https://github.com/earendil-works/pi-review-loop) | `3822e126b8b9ec05d7796b7897512c773ba9a166` | Session-backed review checkpoints and user-controlled feedback submission | Diff excerpts already reach the ordinary composer; source identity is missing from the excerpt |
| [Plannotator](https://github.com/backnotprop/plannotator) | `c27091d528d6e9956501ff0bc3d5d9f288ec8900` | Selected plan passages and batched feedback | Plan Ready exists; paragraph feedback is not built into its card |

The source audit also considered MCP adapters, OTel and ACP. OpenPI already
loads Pi's native MCP/tool-search/codemode extensions. A second MCP runtime is
not justified by discovery or deferred schemas alone. Diagnostic export belongs
to separate [#903](https://github.com/openpi-dev/openpi/issues/903); ACP needs a
concrete external-editor requirement.

## Context observation boundary

Installed Pi 1.2.0 exposes `context_with_system` before each model call. Its
structured transcript contains system updates as well as ordinary messages.
Pi's `getCurrentSystemPrompt` and `getCurrentTools` replay the current system
state; reading only the first system message would miss subsequent updates.

This hook is not the final network request. Later extension handlers can change
the transcript, and Pi/provider normalization can change its representation.
Even `before_provider_request` can be followed by another handler, and a custom
provider must implement the payload callback for observation to occur.

Existing Web trajectory is built from projected Session entries; its payload
viewer does not establish captured provider request bytes. Provider-reported
usage, estimated context occupancy and a local text-size breakdown are different
measurements and must not be presented as interchangeable.

The bounded implementation direction is an operator-facing projection in the
existing session-usage view, computed from real calls. It must avoid new model
tools, synthetic probes, prompt mutation or raw prompt persistence. Missing
observation on older hosts is unavailable, not zero. A composition measurement
cannot establish extension attribution, cache invalidation cause, final wire
content or billing.

## Semantic navigation experiments

The initial read-only probe used frozen OpenPI source and the locally available
TypeScript 5.8.3 JavaScript language service. OpenPI's installed toolchain is
TypeScript 7.0.2 native plus effect-tsgo; this is a compatibility limitation, not
an implementation dependency to silently add.

Source inspection supplied expected definitions independently of the probe:

- `inspectSetupConfig` resolves from setup's import to its shared definition.
- `CHILD_SAFE_PACKAGE_TOOL_NAMES` resolves from the subagent type module to the
  shared child-session policy.
- `sharedHintLine` in the dashboard aliases `hintLine` from screen-chrome.
  Searching the alias does not locate the source definition; semantic definition
  lookup did. Its reference result contained only the alias import/use, so it
  did **not** establish a complete cross-file reference list.
- Two local `isRecord` functions in plan-mode and persisted-state share a name.
  Semantic lookup distinguished the plan-mode function's five locations from
  the unrelated function; exact-name text search mixes the groups.

These cases support usefulness for alias and same-name disambiguation. The
straightforward initial cases alone did not demonstrate that shipping another
dependency or server lifecycle would be worthwhile. Timing observations are not
a controlled performance comparison.

A follow-up used the project's actual `tsc --lsp --stdio` server, reporting
`typescript-go 7.0.2+effect-tsgo.0.24.3`. Initialize, didOpen and definition
requests correctly resolved both the alias and same-name cases. No added
dependency was needed for this development-checkout probe. TypeScript remains a
development dependency, however, and cannot be assumed present for installed
OpenPI users. Shutdown was acknowledged but exit returned code 1 with
`context canceled`; clean process termination was not established. The initial
invalid shutdown request with null parameters is retained separately from the
corrected attempt. This supports further language-server integration work, not
a production-ready integration or a universal language support claim.

## Differential diagnostic experiment

A controlled temporary copy of the repository's terminal-text source was
checked through TypeScript 5.8.3. A code/message multiset comparison behaved as
expected for an existing error, unrelated inserted lines, a newly introduced
different error and removal of that new error.

It also produced a concrete false negative: removing an old error and creating
the same code/message elsewhere left the multiset unchanged. A location-free
diagnostic key therefore cannot promise to identify every newly introduced
problem. Line-based identity alone also cannot solve edits that move code.

The experiment does not validate project configurations, multiple files,
TypeScript 7 compatibility or reliable source mapping after edits. No product
diagnostic-delta mechanism has been adopted.

## Review-source boundary

Current diff references contain path, side, line and code. The review UI already
tracks explicit viewed state by scope/revision and clears it when the displayed
revision changes. Viewed, drafted, sent and accepted are separate facts.

The existing working-tree review revision hashes a bounded review projection;
it is not a full persisted snapshot or a promise that old file contents can be
recovered. A useful minimal change preserves the displayed projection identity
and excerpt in the normal user message. Plan excerpts can similarly reference
their Session/tool-result identity. No parallel comment store, automatic
approval or forced review loop is needed.

## Delivery evidence

Two independent implementation branches were validated locally:

- Context composition: native hook observation projects only numeric sizes and
  identities through existing Web usage. `bun run check` passed. Full tests:
  2,466 Node tests passed, eight skipped; 1,633 UI tests passed. An additional
  unskipped observer regression covers native system/tool replay and lifecycle
  invalidation. The isolated actual `PiWebRuntime.create()` smoke used a loopback
  provider, exposed 12 normal tools and carried the observation through
  `/api/snapshot` into the browser. The fixture reported no billing usage, which
  remained distinct from the observed sizes and Pi's context estimate.
- Review references: the displayed review identity and plan result identity
  enter ordinary editable drafts. `bun run check` passed. Full tests: 2,465 Node
  tests passed, eight skipped; 1,637 UI tests passed. Focused review, plan,
  composer and workbar coverage passed. A native loopback-provider smoke
  actually executed `plan_ready`; browser interaction selected plan text and a
  renamed file's old line. The draft retained the original excerpt, old path,
  staged comparison and displayed revision across reload. Reference actions did
  not send the draft, mark a file viewed or approve the plan.

Both smoke processes used isolated agent directories whose `pi list` and
provenance identified only their respective implementation worktree, based on
`1120cafc` plus the reviewed changes. They did not use external model services or
the user's private Sessions. These are deterministic runtime/UI checks, not
model-quality, performance or public-release evidence. Independent code review
found and corrected an inaccurate Pi 1.2 availability hint: the observed
helpers and hook already exist in the published Pi 0.99.1 source.

Local experiment scripts, results and SHA-256 receipts are retained outside Git
under `~/.codex/experiments/openpi-community-2026-11-07/`. This is local evidence,
not a publicly retrievable benchmark archive. The executable repository tests
are the portable validation surface. GitHub checks and merge state are tracked
on the linked PRs/Issue separately from the local results.

Semantic navigation is validated as useful in the demonstrated ambiguity cases,
but remains unshipped. Server discovery/availability, termination behavior and
reliable diagnostic identity require further work. The concrete false negative
is retained rather than converting the probe into an accuracy claim.

Initial CI rejected the committed Web bundles before running runtime tests.
Replacing shared `node_modules` symlinks with independent Bun 1.3.14
`--frozen-lockfile` installs and rebuilding removed 33 unrelated generated
chunk changes. The lockfile was unchanged. This demonstrates an installation-
layout-sensitive build result in this experiment; the original local checks
alone did not establish CI artifact consistency. The corrected environment is
validated separately before delivery.
