# Antigravity Local Schema References

Status: validated
Created: 2026-09-08
Verified: 2026-09-08
Issue: [#465](https://github.com/openpi-dev/openpi/issues/465)

The Antigravity boundary expands only same-document JSON Pointer references
before applying Cloud Code Assist's unsupported-keyword sanitizer. External,
unresolved, recursive, or over-limit references fail before a model request.
Expansion is bounded by depth, nodes, and serialized bytes. The original Pi
schema remains the authority for local validation; this only preserves its
meaning in the provider declaration.

The ablation is explicit: removing expansion reproduces the original empty
`{}` property for a `$ref` result contract, while allowing references without
bounds could make provider preparation unbounded. Both the expansion and
limits are retained.

Validation: `node --test --experimental-strip-types tests/extensions/ai-providers/antigravity.test.ts` (39/39) and `bun run check` passed.
