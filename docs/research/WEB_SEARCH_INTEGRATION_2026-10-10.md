# Optional web search integration

- Status: validated for the named source comparison, isolated Pi installation/model replay, and local UI checks; not a universal search benchmark or an accepted Decision.
- Created / verified: 2026-10-10.
- OpenPI boundary: PR [#711](https://github.com/openpi-dev/openpi/pull/711), base `e8c0be0bfa5d95533135f951ef193d7a5242e35c` plus local `codex/optional-web-search` changes, Pi 0.99.1, Node 24. Final revision and file identities are retained in the local deployment receipt.
- Related discussion: [#169](https://github.com/openpi-dev/openpi/issues/169). Issue backlink awaits publication of this local record.
- Supersedes: none.

## Sources and recommendation

| Candidate | Verified source facts | Integration assessment |
| --- | --- | --- |
| [pi-web-access](https://github.com/nicobailon/pi-web-access) | Separate search, fetch, stored-content tools; configurable providers and dynamic activation; MIT; npm 0.38.0 reviewed. | Selected for this integration: reuse native Pi tools and retain model ownership of research. |
| [@tian.zuo/pi-web-search](https://pi.dev/packages/@tian.zuo/pi-web-search) | Two tools, configurable search/fetch chains, keyless Firecrawl path. | Smaller surface, but a different provider/configuration implementation; not installed or measured here. |
| [@demigodmode/pi-web-agent](https://pi.dev/packages/@demigodmode/pi-web-agent) | One research tool combines search, reading, ranking, rendering, and caveats; AGPL-3.0-only. | Broader internal research workflow than required; not installed or measured here. |

The choice is about fit to OpenPI's composition boundary. No evidence here establishes a globally best search provider, Chinese-search coverage, reliability at scale, or equivalence to Codex.

Frozen candidate: `npm:pi-web-access@0.38.0`; registry integrity `sha512-8AHja5tlOoGlrtmOsB+zy/MpMeE/fdXQd4UDDs7yg6viaElmNOyNJjNUj+LrgMgMA78ct8xLEKlAI7l9rC8DIw==`. Reviewed repository head: `7e6e2386dc9a31d5e2a448172060dd1339c604f7`. The npm artifact, not a moving branch, defines this integration.

## Implemented ownership

Settings → Web search starts the canonical `/openpi-setup` episode. Its existing parent-only writer admits one fixed optional-package action, alone: choose Exa for a new profile, preserve an existing profile, or disable native user resources. Native confirmation precedes mutation. Pi's package manager installs the exact source; installed manifest identity and persisted native settings are checked. No second installer, credential store, search provider implementation, persistent enable flag, model-facing web wrapper, or capability group is introduced.

TUI review uses `ctx.ui.confirm`. Web review uses the existing `ask_user` Session bridge and controller-bound question broker, inside the same configuration tool call. Only the exact affirmative choice without an additional note authorizes mutation. Cancellation, expiry, dismissal, custom text, and an absent bridge fail closed. This does not mark print-mode Sessions as generally dialog-capable or add a new question transport.

An explicitly selected Exa profile is exclusively created at private permissions before installation. It limits search to Exa, uses native dynamic activation and direct HTTP/PDF reading, defaults to raw search results, and disables source-check orchestration, cookie access, Git cloning, image/video processing, and hosted page extraction. The native tool still allows model-selected per-call summary workflows; the profile is not an enforcement boundary against every additional model call. Existing preferences are never rewritten. Configuration and current Session loading remain separate; no automatic reload occurs. The package is excluded by native source/manifest identity from children before import, including renamed tools. Another installed source with the same package identity is rejected instead of silently duplicated.

## Evidence and limits

Stable local evidence root: `/Users/admin/Documents/ChatGPT/openpi-evidence/web-search-integration-20261010/`. Raw packages, caches, and Sessions remain outside Git.

- `native-probe.json`: without the optional package, four ordinary active tools and 43 registered tools; with the selected profile, five active tools including native `web_enable`, expanding to search/fetch/stored-content after activation. No OpenPI web group is added.
- Exa returned the official executive-order source for the supplied screenshot's topic. A first direct-fetch smoke exposed an invalid profile provider spelling; `http` replaced `direct`. Subsequent direct fetch initially failed although standalone Node requests succeeded; this intermittent failure's cause remains unknown.
- `native-install-smoke.json`: isolated native installation, manifest and persistence checks, actual plugin loading, successful IANA page reading and two-page official PDF extraction. The extracted PDF is retained as `extracted-eo-14434.md` (5,571 extracted characters). Test confirmation is explicitly an isolated fixture, not a claim of production user approval. Native `pi list` reports one OpenPI source, the named worktree, alongside the exact optional npm package.
- `image-replay.json` / `image-replay.log`: a fresh native Pi Session received the original screenshot and only “这是真的吗”, with no answer, official URL, or research workflow supplied. Reported provider/model/thinking: `local-codex` / `gpt-6-astra` / `high`; the gateway's upstream model identity was not independently attested. The model called `web_enable`, searched three times, fetched sources and read stored content, then cited the official order and IANA and kept the domain-profit allegation unproven. This is one local acceptance case, not a search-quality benchmark. Raw native Session and image identities remain in the evidence root.
- Automated setup tests cover confirmation cancellation, preference preservation, installation failure, identity conflicts, native disabling, mixed configuration rejection, native UI requirements, and child exclusion. UI tests distinguish configured state from loaded resources.
- Repository `bun run check` and `bun run test` passed. The earlier full test run found two outdated setup-status expectations, which were updated; the failure log is retained. Four settings Playwright cases passed in local Google Chrome, including desktop and 390px mobile search settings. Default Playwright launch initially failed because its bundled browser was absent; the installed-browser run provides the UI evidence. Screenshot review prompted a small spacing/link improvement; final logs and screenshots retain the checked version.
- At the initial deployment, production installation remained a separate user choice. Updating the local OpenPI source does not install this optional package. The user's subsequent installation request exposed a missing Web review connection at `0bed7907`: the native SDK Session binds in print mode, so the TUI-only guard rejected installation before mutation. The follow-up reuses the existing Web question broker; regressions check review contents, Session identity, cancellation and exact approval before installation. Availability, package configuration, current Session loading, and quality of a particular search remain distinct facts.

## Ablation

Removing the optional package in the same native probe restores the four-tool baseline. Automatic summary/source-check orchestration is omitted from the selected profile; the original-image replay passes using orthogonal search/read primitives. No OpenPI web capability group or provider stack is needed. A second ablation temporarily removed installed-manifest matching from the adapter: the local-package collision acceptance test failed with “Missing expected rejection”, so that identity guard was restored (`ablation-source-identity.log`). The package adapter enforces reviewed installation and persistence; metadata remains separate from Node installation code so the Web UI can import it without shipping filesystem/package-manager code.

Removing the follow-up Web review bridge restores the installation failure and fails the owning-Session acceptance test (`openpi-web-search-confirm-ablation.log`). The bridge is restored; a generic Pi UI adapter is unnecessary for this integration.
