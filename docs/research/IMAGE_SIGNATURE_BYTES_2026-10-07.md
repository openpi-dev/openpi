# Exact image signature bytes

- Status: validated source and regression evidence
- Created / verified: 2026-10-07
- Source: origin/main at 3cb2ecfe1bfbb98252651885311d309f83749428
- Issue: [#697](https://github.com/openpi-dev/openpi/issues/697)
- Supersedes: none

## Verified facts

ASCII decoding cleared high bits in GIF and RIFF/WEBP signatures, accepting corrupted image bytes. Cursor input and Web HTTP admission regressions failed before the fix and pass after exact Buffer comparisons. Valid GIF87a, GIF89a and WEBP signatures remain accepted; PNG/JPEG behavior is unchanged.

## Verification boundary

Production input and HTTP tests; no model or installed runtime acceptance is claimed.

Full repository validation results and CI are recorded on the linked PR. Local
Windows failures are retained separately and are not reported as passing.
