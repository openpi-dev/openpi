# Web Skills and Plugins settings

- Status: `draft`
- Created: 2026-10-08
- Last verified: 2026-10-08; local source, native Pi fixtures and browser UI; no release or paid-provider acceptance claimed
- Source boundary: OpenPI `3cb2ecfe1bfbb98252651885311d309f83749428` plus `codex/settings-resources`; Pi 0.99.1; pi-web comparison `a096af3d09f4dd7eb8685b280f72d97d3ec6e0e5`
- Related Issue: [#710](https://github.com/openpi-dev/openpi/issues/710)
- Supersedes: none

## Scope

Iterate Skills and Plugins within the existing settings dialog, Astryx controls, theme tokens, typography and scope vocabulary. Models retain their existing editor and lifecycle. Search and scope filters sit above the resource list; details lead with identity and state. Source/scope forms replace the always-visible setup textarea, retained under Advanced configuration. Empty states explain how to add resources.

## Native ownership and evidence

Pi owns package settings, installation, Skill discovery, Trust and Session reload, consistent with [Decision 0002](../decisions/0002-native-skill-lifecycle.md). Web reads fresh native SettingsManager configuration and DefaultPackageManager configured package identities, without resolving, installing or executing resources. A bounded manifest read projects installed name/version only. Disabled, missing and zero-resource package entries remain visible. Untrusted project settings remain excluded by Pi.

The current resource loader supplies a separate projection of this Session's resources. An installed/configured package does not imply loaded resources, and a saved disable can coexist with resources still loaded in the Session. Extension, Skill and settings diagnostics remain visible. Bounded labels retain distinct identities; operation controls require an exact projected target.

Add, update, remove, invocation and bulk controls submit natural-language requests to the existing `/openpi-setup` episode. They expose intent and exact scope/source/path to the active model, which uses ordinary Pi capabilities. There is no new installer, registry, typed resource writer, body cache or automatic Skill loading protocol. Review guidance is model-facing request context; it is not presented as a new runtime permission invariant. Ordinary Pi/OpenPI tool permissions continue to apply. A resource-only episode must not change unrelated OpenPI preferences or call their configuration writer to manufacture a save receipt.

Submitting a request confirms admission only. Native configuration and actual Session resources are the evidence for resource changes. Old unrelated setup failures do not appear on the resource pages, and completion of a resource request is not labeled an OpenPI preference save. Bulk requests include only the filtered, shown targets; requests exceeding the transport budget require further filtering.

Explicit reload uses the existing serialized runtime mutation and prompt admission boundary. It checks idle state, active Session id and exact Session file before native reload, and rejects unreadable settings or unresolved missing/version-mismatched package entries. A native PackageManager preflight resolves configured resources with a rejecting missing-source callback; Pi checks its own version ranges without downloading a replacement. It does not automatically reload after configuration. Pi still owns loading and extension diagnostics; a returned reload receipt does not prove every extension loaded successfully.

## Validation and limitations

Native fixtures cover install-and-persist through DefaultPackageManager, fresh configured catalogs, disabled/missing entries, project Trust, corrupt settings, bounded identities and secret redaction. A real Pi Session fixture distinguishes saved/installed from loaded resources, then exercises explicit reload, busy/stale/copied targets, and a missing remote package without installing it. Host tests cover request shape and conflict receipts. UI tests cover source/scope request dispatch, draft retention, filtered bulk intent, unchanged invocation state and previous-error isolation. Browser checks cover desktop/mobile resource forms, reviewed reload failure, the existing General controls and Models editor.

Full gates are `bun run check` and `bun run test`; browser regression is `playwright test --config tests/web/playwright.config.ts tests/web/settings-parity.e2e.ts` with an available browser executable. The PR validation receipt records results at the final revision.

The local preview uses an isolated agent profile with exactly one OpenPI checkout source and synthetic Skills/disabled package fixtures. It does not modify the operator's normal package settings or credentials. Network installation/update, registry search results, model compliance with a management request and every third-party package's code remain outside this deterministic validation. The skills.sh link opens the external directory; it is not an embedded search or installation service.

## Ablation

Removed the add form's separate submission-status state and reused the settings dialog's request ownership and feedback. Draft retention and admission feedback still pass their behavioral tests. Retained the native configured-package projection, exact Session reload guard and shared resource controls: removing them loses inactive package visibility, permits stale reloads, or duplicates the two pages' presentation and interaction rules.
