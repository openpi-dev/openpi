---
evidence-status: validated
created: 2026-09-08
last-verified: 2026-10-15
applies-to: "Antigravity request construction in PR #488, integrated on f98d6a4737461ba8d8ee100f113b5a7c3a0001a0"
related-issues: "#465"
related-prs: "#488"
supersedes: none
---

# Antigravity Local Schema References

This record is validated at the local declaration/request-construction boundary.
It does not establish live Cloud Code Assist acceptance of `allOf` or boolean
schemas. Source discussion: [Issue #465](https://github.com/openpi-dev/openpi/issues/465)
and [PR #488](https://github.com/openpi-dev/openpi/pull/488).

The Antigravity boundary expands same-document JSON Pointer references before
applying the existing Cloud Code Assist sanitizer. External, unresolved,
recursive, or over-limit schema references fail before a model request. The
original Pi schema remains the authority for local result validation; conversion
only preserves its meaning in the provider declaration.

Detection, measurement and expansion share the same schema-position rules.
Definition/property maps and standard applicator values contain subschemas;
`default`, `examples`, `const`, `enum` and other annotation/instance payloads are
opaque to reference interpretation. An explicitly referenced target is treated
as a schema. Literal `$ref` fields inside data neither activate expansion nor
become references when real schema references are also present.

Schemas without schema references retain the existing fast path. When expansion
is needed, all emitted values, including opaque payloads, are measured against
limits of depth 24, 10,000 nodes and 256 KiB serialized bytes before cloning any
referenced subtree. Sparse array slots are counted as their serialized `null`
values. JSON Pointers use own-property traversal and decode `~0` and
`~1`. Reference siblings form an `allOf` conjunction rather than overwriting the
target; boolean targets retain their value.

The later sanitizer still owns unsupported-keyword removal and description
spill. Opaque reference handling does not change that existing annotation
transformation. Direct Subagent and Workflow both use the shared
`createStructuredOutputTool` schema before this provider conversion.

The ablation is explicit: without expansion the original result-contract fixture
produces an empty `{}` property. An unbounded expansion could amplify output.
The production `buildRequestBody` regressions cover literal local/external-looking
references, mixed real references, escaped pointers, applicator/property
positions, no-reference compatibility and output limits. The focused Antigravity
suite passed 81 tests on 2026-10-15 with the frozen Pi 1.2.0 development dependency.
The PR validation receipt separately records the required repository checks.
No live provider call or user credential change was used for this verification.

Historical validation, recorded on 2026-09-08: the then-current focused suite
passed 39/39 and `bun run check` passed. Those historical results do not establish
current runtime or live provider acceptance.
