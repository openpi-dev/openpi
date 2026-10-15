# Native model API type boundaries

- Status: validated source and regression evidence
- Created / verified: 2026-10-07
- Source: origin/main at 3cb2ecfe1bfbb98252651885311d309f83749428
- Issue: [#701](https://github.com/openpi-dev/openpi/issues/701)
- Supersedes: none

## Verified facts

Model, provider and discovery validators accepted api arrays through String coercion; saving could write an array into native models.json. All three boundaries now require literal supported API strings. A persistence regression proves invalid saves preserve file bytes.

## Verification boundary

Ten model-configuration tests pass. Pi owns models.json and provider selection; this adds no provider stack. Public comparison: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md documents literal API identities and native configuration.

Full repository validation results and CI are recorded on the linked PR. Local
Windows failures are retained separately and are not reported as passing.
