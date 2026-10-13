# Persisted turn change validation

- Status: validated source and regression evidence
- Created / verified: 2026-10-07
- Source: origin/main at 3cb2ecfe1bfbb98252651885311d309f83749428
- Issue: [#698](https://github.com/openpi-dev/openpi/issues/698)
- Supersedes: none

## Verified facts

String coercion accepted array-valued persisted state and unavailable-reason enums. previousPath admitted empty or NUL-containing paths and escaped the total byte budget. Decoder tests reject these malformed records while preserving valid v1/v2 records.

## Verification boundary

Four pure decoder regressions pass after failing on the source baseline. No recovery mutation or installed UI acceptance is claimed.

Full repository validation results and CI are recorded on the linked PR. Local
Windows failures are retained separately and are not reported as passing.
