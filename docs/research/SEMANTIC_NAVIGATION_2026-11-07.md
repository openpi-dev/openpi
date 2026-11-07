---
status: validated
created: 2026-11-07
last-verified: 2026-11-07
applies-to: OpenPI baseline 1120cafcd3f5c1ad466df1c7b823976a3e911f72 and the semantic-navigation candidate described below; Pi SDK 1.2.0; TypeScript 7.0.2 with effect-tsgo 0.24.3
related-issues:
  - https://github.com/openpi-dev/openpi/issues/913
related-prs: []
supersedes: none
---

# On-demand semantic navigation and diagnostic observations

This record preserves source-scoped observations and a candidate implementation, not a formal Benchmark, a release claim or a new architectural Decision.

## Question and sources

Can language-server results answer symbol questions that text search leaves ambiguous, while keeping execution in Pi's existing tool and lifecycle boundaries?

- Community starting points: [pi-lens](https://github.com/apmantza/pi-lens/tree/7589a95232f8521e1f71a435e4e403d446857035) and [pi-lsp](https://github.com/ian-pascoe/pi-extensions/tree/32f4991e824e2ef03872707229c59ddde80f0b9b). Their feature sets motivated investigation; they were not installed or adopted as dependencies.
- [LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) defines capability negotiation, document synchronization, navigation, pull diagnostics and shutdown. The implementation only requests advertised capabilities.
- The executable used here is the repository's installed TypeScript 7.0.2, patched by the existing Effect preparation script. Its initialize response identifies `7.0.2+effect-tsgo.0.24.3`. Results do not establish compatibility with every TypeScript build or language server.
- Pi SDK 1.2.0's native package resource loader and Bash tool were exercised independently. No provider/model call or global configuration edit was needed.

## Observed value and counterexamples

| Case at baseline 1120caf | Independent expectation | Observed result |
| --- | --- | --- |
| `sharedHintLine` alias in the workflow dashboard | Definition in `screen-chrome.ts`, line 97 | Correct definition; references returned the alias import and its use only |
| Local `isRecord` in Plan Mode | Local definition at line 72, separate from the same name in persisted state | Correct definition and five local occurrences |
| Identical diagnostic snapshots | Same text and full diagnostic occurrences | Two unchanged occurrences |
| Insert unrelated lines | Existing diagnostics move | Two ambiguous groups, retaining both locations |
| Introduce a distinct type error | Newly observed error | Type error and an additional unused hint retained |
| Fix one type error | Error disappears from the observed report | One resolved observation |
| Remove one error and create the same message elsewhere | Occurrences must not silently cancel | Same-signature before/after diagnostics remain ambiguous |
| Add another identical error | Multiplicity must survive | Ambiguous group retains one before and two after |

The diagnostic cases use a copy of real `terminal-text.ts` in a controlled temporary TypeScript project, with deliberate edits and source hashes. They establish single-document behavior, not project-wide coverage or causality. Alias references are useful but do not enumerate every reference to the original exported symbol. No latency or token-efficiency advantage was measured.

An earlier code/message multiset comparator incorrectly cancelled a removed error against a new identical error elsewhere. That rejected result remains in the original evidence. The candidate deliberately treats matching signatures in changed text as ambiguous; even harmless inserted lines can therefore require interpretation.

## Candidate and ownership

The package declares `subagents`, `workflows` and `semantic-navigation` in Pi's native manifest. Pi exposes their names, descriptions and paths; the model reads bodies when useful. Existing child filtering continues to exclude the two orchestration Skills. An adjacent Node script accepts one JSON request and starts one explicitly selected, already installed stdio server through ordinary Bash. It provides definitions, references, single-file pull snapshots and snapshot comparison. It adds no model-facing tool, service pool, model selection, automatic installation, configuration store or forced workflow.

The first manifest candidate listed only the new Skill. Full tests exposed a real compatibility difference: the baseline string package source discovered no Skills, while a source object with extension filters used convention discovery and retained `subagents` and `workflows`. Listing only the new directory removed those existing object-source resources. Explicitly listing all three preserves existing users and also exposes the two previously absent Skill entries to string-source users. The bodies remain on demand; this is a visible index change, not automatic delegation.

The three names and descriptions total 565 UTF-8 bytes at this candidate, excluding Pi's wrappers and installation-dependent paths. Of these, 354 bytes belong to the two existing orchestration entries newly visible to string-source users. This is a text-size observation, not a token or usage measurement.

Pi retains Session, Skills, trust, tool permissions and Bash cancellation. The model chooses when to navigate or compare evidence. The client enforces protocol bounds, request time limits, response validation and cleanup, and refuses server requests to edit files. Running a language server still executes local code with Bash authority; a read-only protocol client is not a sandbox. Plan Mode's existing command restrictions remain in force.

Snapshots retain the opened text's SHA-256, URI, document version, server command/arguments/reported identity and complete diagnostic occurrences. They do not freeze dependencies, configuration, environment or other documents. Comparison reports observations and ambiguity, never whole-project cleanliness or edit causation. Unsupported, failed, incomplete and incompatible results stay explicit.

## Validation boundary

The candidate CLI resolved both real navigation examples and passed all six diagnostic comparisons against the actual TypeScript server. Every observed request completed and shutdown was acknowledged; the server then returned exit code 1 with `context canceled`. The CLI retains that outcome separately. A response does not prove orderly process termination.

Pi's actual `createBashTool` cancelled an isolated invocation and the controlled server PID disappeared. This checks the existing Bash process-tree path without adding a second supervisor. Portable fixture tests separately exercise timeout cleanup, malformed/oversized frames, unsupported and incomplete reports, UTF-16 positions, edit refusal, abnormal exit and occurrence-preserving comparison.

An actual `npm pack --ignore-scripts` tarball included the Skill and adjacent script. After extraction with no package dependencies installed, Pi 1.2.0's native resource loader discovered the declared Skills and its returned base directory successfully ran the semantic script's help command. A native resource-loading regression runs against the CI-selected Pi host, including the minimum version; Windows fixture lifecycle behavior is also a separate CI gate. Neither is established by the macOS smoke alone.

Raw receipts, exact requests/results, controlled source copies, cancellation and package artifacts remain outside Git under `/Users/tsk/.codex/experiments/openpi-community-2026-11-07/semantic-delivery-v1/`. Its manifest records file hashes. The checked CLI hash is `fb4effecd87115d985d08cf35f5755860f9af68a9b0d4f97914e558b9483f1ba`. Original exploratory counterexamples remain under the sibling `semantic/` evidence directory.

Repository checks, full test totals, independent review and final CI are recorded in the implementation PR once complete. These functional observations are not a formal Benchmark: there is no representative task suite, model-quality experiment or usage comparison.
