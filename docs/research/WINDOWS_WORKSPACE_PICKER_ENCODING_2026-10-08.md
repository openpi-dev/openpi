# Windows workspace picker: Unicode stdout boundary

- Status: validated on Windows at the subprocess encoding boundary, with separate manual Web confirmation.
- Created and verified: 2026-10-08.
- Source boundary: upstream `3cb2ecfe1bfbb98252651885311d309f83749428` plus the Windows picker fix and regression test in this change.
- Related Issue and implementation discussion: [#712](https://github.com/openpi-dev/openpi/issues/712), which links the implementation PR.
- Superseding relationship: none; this is a scoped bug investigation, not a new project constraint.

## Verified facts

The Windows folder picker runs in `powershell.exe`. Its selected path crosses a stdout pipe before the Web host validates it with `realpath`. With CP936 output, `学校` produces bytes `d1 a7 d0 a3`; decoding those bytes as UTF-8 produces `ѧУ`. An existing directory can therefore become a different, nonexistent path before workspace validation.

The regression test runs real Windows PowerShell with initial CP936 output and substitutes only the COM folder dialog. It uses the production chooser script and actual temporary directories. Chinese names, spaces, and emoji fail without the script's UTF-8 output setting and pass with it. Assertions cover exact UTF-8 bytes, decoded path equality, successful `realpath`, and empty output on cancellation.

The reporter separately confirmed that adding a Chinese-named workspace works after restarting the patched Web host. No private workspace paths, credentials, or Session data are needed to reproduce the encoding mismatch.

## Fix and validation

Set `[Console]::OutputEncoding` to UTF-8 without a BOM inside the picker subprocess and explicitly request UTF-8 decoding in Node. The existing picker, abort signal, and cancellation handling remain in place.

- `bun run check`: passed.
- Targeted Windows picker regression: 5 reported tests passed, including its parent test.
- `bun run test`: its parallel Node group reported 2,188 passed, 5 failed, and 14 skipped; the aggregate command stopped at those failures.
- Separate remaining groups: `node scripts/run-tests.mjs node-serial` reported 99 passed and 4 skipped; `bun run test:ui` passed all 1,158 tests across 82 files.

The same five parallel-group failures occurred before the fix on this Windows host at `26da591`: one in `git-review`, three in `transcript-search`, and one in `turn-changes`. Four report symlink `EPERM`; the remaining test expects a `changed-session` reason after symlink substitution. This is a comparison with the earlier local checkout, not a clean upstream baseline or a passing full suite.

## Boundaries

The automated fixture checks the real PowerShell stdout boundary and stubs the native dialog; it does not automate the full browser/dialog interaction. It runs only on Windows. CP936 is the deliberately reproduced legacy encoding; other Windows code pages were not individually exercised. macOS and Linux chooser branches, persisted configuration, and Pi provider/model behavior are outside this change.
