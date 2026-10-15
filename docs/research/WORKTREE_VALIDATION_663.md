# Validation beneath Git metadata (#663)

- Status: validated at the named local tool boundary; parent review pending
- Created / verified: 2026-10-04
- Source: `94f6dfb29343a699010440f37734ac14582c84af`
- Issue: [#663](https://github.com/openpi-dev/openpi/issues/663)
- Supersedes: none
- Evidence: `/tmp/openpi-663-direct-3/` (local retained receipts, not a public archive)

## Verified observations

Git-preserving inside/outside checkouts at the source revision shared the same
`node_modules` realpath, lockfile, package manifest, runner and test hashes
(`identities.json`). Installed Biome / Vitest / Vite were 2.5.8 / 4.1.10 / 8.2.0.
Commands ran from their real working directories with relative test filters.

Inside `.git/pi-worktrees`, `biome lint . --error-on-warnings` produced nine
unused React-rule suppression warnings; outside, it passed. Explicitly selecting
the recommended React domain for `web/ui/src` made the inside lint pass without
changing rules or suppressions (`main-lint-red.log`, `react-domain-green.log`).
This establishes missing automatic React-domain activation at this boundary;
the precise internal package-scanner exclusion is an inference, not separately
instrumented upstream-source evidence.

Inside, `vitest run tests/web/web-store.spec.ts` failed before collecting tests
with `Cannot find module '/tests/web/web-store.spec.ts'`; outside, all 182 tests
passed. Vite's default `**/.git/**` deny matcher returned true for the existing
absolute test filename, but false for its checkout-relative counterpart
(`vite-deny-probe.json`). Vite checks this matcher before its allow-list.
This is an ancestor-path filesystem denial, not a missing source file, root
selection error, or dependency resolver version mismatch.

## Scoped implementation and regression

`biome.json` explicitly activates recommended React rules for UI source files.
`vitest.config.mjs` uses a test-only `configResolved` hook: inside a checkout
whose root contains a `.git` segment, evaluate the existing deny matcher on
checkout-relative paths. Paths outside the checkout retain the original matcher.
Strict filesystem enforcement and its allow-list are unchanged. Nested `.git`
directories and worktree `.git` pointer files remain denied, as do environment
files, package-manager credentials and certificate/key extensions. The Web dev
server configuration is unchanged; no runtime placement, Trust or replay policy
changes are involved.

The regression creates real Git worktrees inside `.git/pi-worktrees` and outside,
uses the root dependency realpath, runs Biome and a jsdom Vitest spec importing a
sibling source module, and asserts private/metadata denial through the real Vite
configuration. Disabling only the hook reproduced the same module error
(`regression-jsdom-red.log`). The original Web-store probe passes after the fix
(`main-vitest-green.log`); full gate receipts are `check.log`, `test.log` and
`validation-status.json`.

## Target-aware HTTP correction

Parent review of `578b393d6ac17b0a2c2b31ce05a06c835cf03149` identified a real
privacy regression: an inside alias to an outside `.env` returned HTTP 200 with
synthetic contents, whereas baseline Vite returned 403. The original direct
matcher assertions did **not** establish HTTP symlink privacy. Parent evidence
is retained in `/tmp/openpi-workflow-audit/663-http-symlink-proof.json` and its
self-contained probe; neither artifact was overwritten.

The matcher now checks both the lexical filename and its read-only realpath
against the same boundary-aware policy. Outside targets retain the original
matcher. Missing/non-directory paths defer to Vite's ordinary missing-file
handling; other realpath lookup errors deny access. There is no target cache or
allow-list expansion.

`/tmp/openpi-663-symlink-fix/http-red.log` records the pre-correction HTTP 200
metadata leak. `focused-green.log` covers real HTTP 403/no marker for outside
sensitive targets, HTTP 200 for ordinary files/modules and nonsensitive linked
files/modules, and HTTP 404 for a missing path. The resolved allow-list is compared
with unmodified Vite, including Vite's own client-directory allowance. The paired
Git regression also imports React through the root dependency symlink.
Windows uses directory junction fixtures; the file-symlink `.env` HTTP case is
explicitly not exercised there because it requires additional privileges.
Scoped lint/typecheck receipts are `lint.log` and `typecheck.log`. The previously
recorded full Node suite remains red; no full suite was rerun for this correction.

## Limitations / compatibility

The hook depends on Vite 8.2.0's internal resolved `fsDenyGlob` function. It throws
if that function disappears rather than silently dropping protection. The real
integration regression must pass on dependency upgrades. This is local source
validation, not installed Pi or browser-server acceptance. Public Issue backlink
and publication await parent adjudication; this record does not adopt a new
runtime/security architecture constraint.
