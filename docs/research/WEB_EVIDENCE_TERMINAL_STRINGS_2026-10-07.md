# Terminal strings in Web evidence

- Status: validated source and regression evidence
- Created / verified: 2026-10-07
- Source: origin/main at 3cb2ecfe1bfbb98252651885311d309f83749428
- Issue: [#700](https://github.com/openpi-dev/openpi/issues/700)
- Supersedes: none

## Verified facts

Web evidence stripped escape introducers while retaining hidden DCS, PM, APC and SOS payloads. It now uses the canonical shared terminal sanitizer on its bounded candidate. Tests cover ESC/C1 introducers, terminators, unterminated strings and actual tool projections.

## Verification boundary

Eight evidence tests pass. Unicode and tab behavior follows the shared sanitizer. Canonical execution and persisted evidence are unchanged.

Full repository validation results and CI are recorded on the linked PR. Local
Windows failures are retained separately and are not reported as passing.
