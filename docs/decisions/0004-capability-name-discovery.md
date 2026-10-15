---
decision-status: accepted
created: 2026-10-04
last-reviewed: 2026-10-04
applies-to: OpenPI source baseline 6c449731ccfe1a11b743ebf9ed51cb76bb825293; delegate/workflow discovery
owner: OpenPI maintainers
related-issues: "#655"
related-prs: none
supersedes: none
---

# Decision 0004: Capability names select discovery; models judge use

## Context

[Issue #655](https://github.com/openpi-dev/openpi/issues/655) tracks capability-name feedback and loading. The previous shared classifier required imperative phrases or an entire input consisting of one English name, and suppressed discussion, negation and conditional clauses. README wording also described conflicting mention rules. This made simple naming unreliable and assigned language judgment to runtime heuristics.

On 2026-10-04 the maintainer explicitly chose name-based discovery, leaving the interpretation of whether to use the capability to the model. This Decision records that accepted scope from the implementation conversation. It does not claim Issue closure, a merged implementation, an installed update or actual terminal acceptance.

## Decision

- Independent `subagent` / `subagents` / `子代理` and `workflow` / `workflows` / `工作流` names select their corresponding discovery groups. English names ignore case; lists, multiple lines, quoted names, discussion, negation and conditions do not suppress discovery.
- A shared name matcher owns discovery and editor feedback. ASCII identifier/path fragments such as `subagent.ts`, `my_subagent`, `workflow_status` and `subagent-matching` remain ordinary text. Chinese names may occur naturally inside Chinese prose.
- Submission makes the existing tools available and provides the existing native Skill guidance paths. It does not execute tools, spawn children or start Workflow runs. The active model judges whether and how to use the capability from the user's full request, including negative or conditional instructions.
- Existing tool ownership, parent/child authority intersections, project trust, limits, cancellation and cleanup remain runtime facts. Discovery does not widen those boundaries.
- Only accepted editor text participates in feedback and prompt discovery. Unaccepted suggestion text remains a ghost. Pi owns the input, native cursor and persisted Session; highlighting is a rendering projection.
- Other search/background/session discovery rules and the explicit/adaptive gateway remain unchanged. Existing explicit delegation verbs remain compatible. This change introduces no configuration setting, parser framework, orchestration policy or separate Skill lifecycle.

## Evidence boundary

The implementation at `a95f280f95a480ee7fde8ea01519335b394e7612` uses the existing `before_agent_start` loading seam and shared tool surface. Source-level tests separately cover mention classification, guidance/tool activation, ghost acceptance, identifier boundaries and native editor render bytes. A locked Pi 0.99.1 Editor fixture verifies unchanged input, visible widths, reverse-video cursor state and the native cursor marker across multiple lines and ANSI segments. Targeted child-session tests retain authority intersection and inherited-tool restrictions.

These tests prove source/projection contracts, not model compliance with negative instructions or terminal pixel readability. Real TUI pixels, live installation and actual model strategy remain unverified here. The user's installed source was independently identified by `pi list` as the single local `~/work/openpi-main-runtime` checkout at `d36b58b67f87d24b4926521b965bdccfff7719e4`, distinct from the implementation checkout; this work does not modify or reload it. Final combined checks/tests and independent review belong to the integrating task.

An independent review found that re-matching rendered rows loses original filename boundaries after soft wrapping. An initial correction used Pi's published typed `components/editor.js` helper; direct 0.99.1/1.0.2 Editor compatibility cases passed, but native extension-loader CI failed because the SDK root alias was applied to the component subpath. That candidate is superseded. The correction removes the subpath import and projects original mention offsets from public cursor/padding anchors through bounded exact matching of actual rendered content. Unknown or mismatched geometry skips coloring rather than guessing. It does not patch the loader or inspect private layout state. A native DefaultResourceLoader regression and isolated Web startup cover the previously missed loader boundary; runtime discovery remains independent of this rendering projection.

## Alternatives considered

- Keeping the imperative/negation/condition classifier would continue guessing language intent in the runtime and contradict the accepted mention rule.
- Loading every OpenPI tool at startup would discard progressive discovery and broaden the resident surface for ordinary tasks.
- Executing a capability when its name appears would confuse discovery with an action and violate model ownership of strategy.

## Consequences

Names reliably reveal a small capability mechanism. Discussing or negating a named capability can add its tools and guidance paths to the model context; this is an explicit discovery consequence, not execution authority. Ordinary requests with no matching names keep their existing tool surface. Loaded groups retain the existing Session lifetime and monotonic loading behavior.

## Amendments

2026-10-04: the component-subpath implementation was superseded after native-loader CI rejected it. The accepted discovery choice is unchanged and does not certify release, model compliance or real terminal acceptance.
