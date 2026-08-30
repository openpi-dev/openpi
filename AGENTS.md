# OpenPI agent contract

OpenPI is a Pi-native capability layer, not a second agent operating system. Extend Pi at its existing seams and preserve its lifecycle, vocabulary, and sources of truth.

## Design stance

### Build for model leverage

- Prefer capabilities whose usefulness increases as models improve.
- Give the model small, orthogonal mechanisms and high-fidelity feedback. Let the model decide strategy, decomposition, delegation, and synthesis.
- Encode safety and execution invariants in the runtime. Do not encode a preferred reasoning process, keyword router, or fixed orchestration workflow unless correctness requires it.
- Before adding a framework abstraction, ask whether a stronger model could use the underlying Pi primitive directly. If yes, expose or strengthen that primitive instead.

### Keep ownership clear

The model owns judgment:

- understanding intent and choosing an approach;
- deciding whether and how to delegate;
- adapting to evidence and synthesizing results;
- deciding when user input is needed.

The runtime owns enforceable facts:

- permissions, trust, isolation, and capability boundaries;
- concurrency, call, time, and resource limits;
- lifecycle, cancellation, cleanup, persistence, and recovery;
- atomicity, idempotency, replay safety, and fail-closed outcomes;
- observable execution state and exact terminal evidence.

Do not rely on prompts for runtime invariants. Do not move model judgment into a rigid state machine merely because it is easier to test.

### Preserve Pi-native composition

- Pi remains the source of truth for Sessions, provider/model selection, Skills, project Trust, and ordinary tools.
- Reuse Pi events, messages, tools, extension hooks, and session lifecycle before introducing parallel storage or control planes.
- Keep model-facing schemas compact and progressively disclose specialized capabilities and detailed instructions only when needed.
- Treat canonical execution facts, model-visible context, and operator-facing UI as distinct projections. Never infer completion from labels or presentation state.
- Prefer one general composable capability over several workflow-specific commands.

### Keep subagents simple

- Subagents are in-process Pi sessions and inherit the parent model and thinking level unless an explicit, reviewed override applies.
- The parent model owns delegation and synthesis. Child capabilities are a fail-closed intersection and do not silently widen parent authority.
- Background work should report completion through events without keeping an otherwise idle interactive parent turn alive. A synchronous wait is for explicit synchronization, not the default orchestration pattern.
- Do not add recursive teams, an external CLI harness, or a second provider stack without a concrete requirement and a complete identity, authority, lifecycle, and cleanup design.

## Feature decision test

Before implementing a new OpenPI feature, answer:

1. Which Pi primitive or extension seam already owns this lifecycle?
2. Is this model judgment or a runtime invariant?
3. Can the feature be an orthogonal mechanism instead of a prescribed workflow?
4. Will better models use it better without a framework rewrite?
5. What exact evidence distinguishes success, failure, cancellation, and uncertainty?
6. How is authority bounded, inspected, stopped, and cleaned up?

If those answers are unclear, investigate before adding surface area.

## Repository work

- Preserve unrelated and uncommitted user work. Make the smallest scoped change that satisfies the request.
- Follow existing patterns and tests before inventing a new abstraction.
- Run `bun run check` and `bun run test` after making a change. If a relevant validation command does not exist, call that out and propose one.
- When opening or updating a pull request, follow `.github/PULL_REQUEST_TEMPLATE.md` and complete its Problem, Value, Approach, Validation, and Impact sections.
- Avoid explicit return types unless they are necessary. Prefer inference over repeatedly declaring types.
- Treat `as any` as an absolute last resort; use real type safety.
- Keep user-visible behavior, model-visible context, and persisted/runtime state tests separate when the distinction matters.
- Runtime provenance: before diagnosing installed behavior, provider compatibility, a manual Pi smoke, or any UI result, read README section “开发运行时：区分 npm 与当前源码”. Prove both the checkout revision and the single OpenPI source reported by `pi list` before reasoning from source code.
- Preserve ignored local evidence as user work. Never use `git clean -fdx`; ignored benchmark runs, logs, and harnesses may be the only local copy.

### Knowledge and evidence

- Use GitHub Issues for discussion and work tracking. Preserve a reusable conclusion in the appropriate `docs/` category and link the Issue and record both ways.
- Keep facts, inferences, recommendations, unknowns, protocols, and validated results distinct. A research recommendation or complete-looking design is not a project constraint without an accepted Decision.
- Formal Benchmark records must retain frozen source, model, task, and verifier identities; usage accounting; failure classification; limitations; and a verifiable evidence reference.
- Before publishing or materially revising a governed record, read [`docs/README.md`](docs/README.md) and the relevant category index. Existing legacy documents are not silently reclassified or rewritten.
- Preserve large or sensitive raw evidence outside the repository under a stable identity. Never bulk-add, move, overwrite, clean, or publish ignored Benchmark assets, credentials, or private Session data.

## Package configuration contract

- `/openpi-setup [natural-language request]` is the single canonical user-facing configuration entry point. `/my-pi-setup` is a compatibility alias only. Do not add extension-specific setup commands for package-owned choices.
- A user-selectable model, feature toggle, permission, concurrency limit, theme/UI preference, or other package-owned choice must update `extensions/setup/`, `extensions/shared/setup-config.ts`, the no-argument `/openpi-setup` status output, `SETUP.md`, and the canonical defaults and prose in `README.md`.
- Classify every new model-facing tool at the child-session boundary. Parent-only tools belong in `CHILD_EXCLUDED_TOOL_NAMES`; read-only child-safe tools belong in `CHILD_SAFE_PACKAGE_TOOL_NAMES` in `extensions/shared/child-session.ts`. The drift guard must fail closed on every unclassified tool, including factory-registered tools.
- Installation must remain side-effect-safe: no provider/model names hardcoded as defaults, no model calls before explicit configuration, and expensive or privileged behavior must be opt-in.
- Optional Pi packages require native reviewed confirmation, fixed package identity, safe configuration before activation, no rewrite of existing preference files, fail-closed persistence, and no automatic reload into the running Session.
- Natural language is interpreted by the active model during an `/openpi-setup` episode. The typed configuration write tool is episode-scoped, absent from ordinary turns, and exposes only the smallest typed state needed to persist a result. Do not add a parser or proliferate subcommands.
