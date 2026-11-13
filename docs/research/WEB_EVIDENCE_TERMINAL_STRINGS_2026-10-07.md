---
status: validated
created: 2026-10-07
last-verified: 2026-10-07
applies-to: "origin/main 3cb2ecfe1bfbb98252651885311d309f83749428 and the bounded regression evidence below"
related-issues: "#700"
related-prs: "#705"
supersedes: none
---

<!-- Metadata added 2026-11-14; the original verification boundary is unchanged. -->

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

## Inferences

The regression evidence supports the stated sanitizer boundary; it does not alter canonical execution or persisted evidence.

## Recommendations

Use the shared terminal sanitizer for the bounded Web evidence candidate, as described above.

## Unknowns

Local Windows failures are retained separately; their outcomes are not claimed as passing here.
