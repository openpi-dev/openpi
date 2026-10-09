---
decision-status: proposed
created: 2026-10-09
last-reviewed: 2026-10-09
applies-to: OpenPI Pi compatibility checks from adoption of this change forward
owner: OpenPI maintainers
related-issues: "#328"
related-prs: "#719"
supersedes: none
---

# Decision 0005: Supported Pi versions

## Context

[#328](https://github.com/openpi-dev/openpi/issues/328) tracks the difference
between a declared support range and the Pi host exercised by frozen-lock CI.
[#410](https://github.com/openpi-dev/openpi/pull/410) raised the minimum to
0.85.1; [#620](https://github.com/openpi-dev/openpi/pull/620) repaired the 0.86
transcript boundary; [#636](https://github.com/openpi-dev/openpi/pull/636) raised
the minimum to 0.99.1 and replaced local replay with Pi's native helpers.
The earlier [#330](https://github.com/openpi-dev/openpi/pull/330) and
[#333](https://github.com/openpi-dev/openpi/pull/333) were closed without merging.

At source `a18f457687b45c877bc8a15d689a7580c4f0659a`, the three Pi development
ranges are `^0.99.1`, the lock resolves 0.99.1, and the published peers are
`>=0.99.1`. The minimum and lock currently coincide. Existing package and Git
smokes select that locked host; they do not continuously exercise newer hosts
allowed by the peers. Historical compatibility evidence is retained in the
[0.99.1 investigation](../research/PI_0_99_COMPATIBILITY_2026-09-30.md).

## Decision

Proposed for maintainer adoption with [#719](https://github.com/openpi-dev/openpi/pull/719):

- Keep Pi packages host-owned peers. Preserve the current open-ended peer range;
  do not bundle a second Pi runtime or add an OpenPI runtime version-rejection gate.
- Declare one common Pi minimum in the three peer and development ranges and in
  README/SETUP. The package contract checks these declarations and the lock
  importer. The resolved host packages must agree and cannot be below the minimum.
- Keep frozen-lock checks on the existing Node versions. Add independent minimum
  and latest-stable Pi jobs on the minimum supported Node version. Read the minimum
  from the published peer declaration; resolve `pi-coding-agent@latest` once per
  job and record the exact selected version.
- Install the selected Pi family transiently, check the resolved family and actual
  installed package versions, and restore the publishable manifest and lock before
  normal checks. Run the existing check, Node suite, package-discovery, packed
  extension, packed Web, and Git-source smokes with that selected host.
- Make failures in either endpoint fail the existing aggregate CI gates. On a Pi
  release or compatibility report between OpenPI changes, rerun CI at the affected
  source revision. A failure requires investigation and a reviewed compatibility
  repair or support-range change; it must not be hidden by moving the lock alone.

## Evidence boundary

The open-ended peer range admits newer hosts; it does not provide test evidence
for an unpublished version or every intervening release. CI records the minimum,
locked, and latest stable hosts actually exercised at that revision and time.
The latest job changes when npm's stable tag changes, so its result is not
reproducible without retaining that exact host version.

Repository checks cover native contract fixtures and offline package startup.
They do not prove live Cursor/Antigravity requests, real credentials or proxies,
interactive terminal pixels, or every newer host's behavior. Version selection
does not upgrade a user's installed Pi or alter their configuration.

Local proposal validation on 2026-10-09 used the source above plus this change,
macOS arm64, Node 22.23.1, Bun 1.3.14, and isolated Pi configuration. Exact
0.99.1 and 1.1.0 hosts each passed `bun run check`, the complete Node/UI suites,
and all four offline discovery/packed/source smoke steps. These local results
do not replace the Linux/Windows/E2E matrix or maintainer adoption.

## Alternatives considered

- **Frozen lock only:** preserves reproducibility but repeats the blind spot from
  #328 and loses minimum-version evidence when the lock advances.
- **Raise the minimum to every new host:** removes useful compatibility without
  proving that the old minimum stopped working; retain it until a real dependency
  or native contract requires a reviewed increase.
- **Immediately cap the peer range:** changes the published support contract and
  can exclude already-working hosts. A bounded range remains available when
  concrete incompatibility evidence warrants it; this change preserves the range.
- **A custom runtime rejection layer:** would duplicate host ownership and would
  not replace compatibility tests.

## Consequences

Two additional Linux jobs verify host contracts without multiplying the entire
OS/Node matrix. Latest-host failures may be caused by an upstream release even
when OpenPI source is unchanged; the exact selected version makes this visible.
The development lock remains reproducible and package installation remains
Pi-native. This is a compatibility policy, not a guarantee about future releases.

## Amendments

Append adopted range changes and their validation evidence here, or link a
superseding Decision. Historical investigations retain their original boundaries.
