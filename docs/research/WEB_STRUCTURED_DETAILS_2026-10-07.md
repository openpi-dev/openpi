# Structured Web evidence integrity

- Status: validated source and production-function regression
- Created / verified: 2026-10-07
- Source: `origin/main` at `3cb2ecfe1bfbb98252651885311d309f83749428`
- Issue: [#695](https://github.com/openpi-dev/openpi/issues/695)
- Supersedes: none

## Verified facts

`projectMessage` dropped own `__proto__` keys in parsed JSON tool details by
assigning them through the ordinary object setter. This changed only the
projection object's prototype; global prototype pollution is not claimed.
Its shared bounded projection also silently omitted array elements or later
object properties when the 512-node work budget was exhausted exactly.
Four arrays of 128 numbers became arrays of lengths 128, 128, 128 and 123,
without a details-truncation marker. Regression tests failed on the source
baseline for both special-key loss and budget exhaustion.

## Fix and verification boundary

Own data properties are defined without invoking prototype setters. A remaining
item at an exhausted budget explicitly marks omission, while complete data at
the exact boundary remains retained. Existing policy omits partial details and
reports `truncation.details`; work, depth, byte and accessor limits remain.
The 25-test protocol suite passes after the fix. These are deterministic
production-function tests, not installed browser or model acceptance. Tool
execution, Session persistence and model context are unchanged.
