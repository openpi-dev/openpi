- run check/format/lint commands when your done making a change. if they don't exist, suggest making them for the project you're in
- avoid explicit return types unless absolutely needed
- `as any` should be an absolute last resort. always use real type safety. lean on type inference instead of manually writing new types over and over again

## Package configuration contract

- `/my-pi-setup [natural-language request]` is the single user-facing configuration entry point for this package. Do not add extension-specific setup commands when the choice belongs to package configuration.
- Any future extension or update that introduces a user-selectable model, feature toggle, permission, concurrency limit, theme/UI preference, or other package-owned choice must update all of: `extensions/setup/`, `extensions/shared/setup-config.ts`, the no-argument `/my-pi-setup` status output, `SETUP.md`, and `README.md` (which holds the canonical defaults table and restates limits in prose).
- Any new model-facing tool must be classified for the child-session boundary: parent-only tools go in `CHILD_EXCLUDED_TOOL_NAMES` and read-only child-safe ones in `CHILD_SAFE_PACKAGE_TOOL_NAMES` (`extensions/shared/child-session.ts`). The drift guard in `child-session.test.ts` fails closed on an unclassified tool, including factory-registered ones.
- Installation must remain side-effect-safe: no provider/model names hardcoded as defaults, no model calls before explicit configuration, and expensive or privileged behavior must be opt-in.
- Natural language is interpreted by the active model. The configuration tool should expose only the smallest typed state needed to persist the result; avoid adding a parser or a proliferation of subcommands.
- Subagents are Pi-native: one in-process backend that inherits the parent model and thinking level. Do not add hardcoded model preferences, and do not reintroduce external CLI harnesses without a stated need.
