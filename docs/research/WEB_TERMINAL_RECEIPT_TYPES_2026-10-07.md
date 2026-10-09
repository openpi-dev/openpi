# Typed background terminal receipts

- Status: validated source and regression evidence
- Created / verified: 2026-10-07
- Source: origin/main at 3cb2ecfe1bfbb98252651885311d309f83749428
- Issue: [#702](https://github.com/openpi-dev/openpi/issues/702)
- Supersedes: none

## Verified facts

Array-valued failed, killed and timed_out statuses were admitted by coercion and misreported as returned. Literal process statuses are now required; malformed receipts retain unknown process state independently of a successful tool return. Exit codes require safe integers.

## Verification boundary

Eight evidence tests pass after the new regression failed on baseline. Valid completion, failure, cancellation, timeout and running outcomes remain distinct.

Full repository validation results and CI are recorded on the linked PR. Local
Windows failures are retained separately and are not reported as passing.
