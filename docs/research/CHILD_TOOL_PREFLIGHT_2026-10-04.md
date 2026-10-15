# Child tool inheritance and replay identity

- Status: validated at the source and automated-test boundary
- Created: 2026-10-04
- Last verified: 2026-10-04
- Source baseline: PR #638 at `bd11760b0b501b07ff2d20270ac713d9f5f7a042`
- Fix boundary: the follow-up changes and regression tests in PR #638
- Host boundary: the locked Pi SDK 0.99.1
- Issue: [#637](https://github.com/openpi-dev/openpi/issues/637)
- Related PR: [#638](https://github.com/openpi-dev/openpi/pull/638)
- Supersedes: none

## Verified behavior

Pi SDK children need the native `tool-search`, `codemode`, and `mcp` factories
supplied through their resource loader. The shared factory list now supplies
these to children and the Web runtime. The child tool policy still limits the
resulting tools to the parent's projected capabilities. Registering a factory
does not grant access to every tool it registers.

After extensions initialize, a requested tool that is registered but inactive
can be activated within that allowlist. A parent can also hold a tool that a
fresh child cannot register. Ordinary inheritance tolerates that missing tool
and reports the narrowed surface. An agent type with an explicit `tools` list
instead requires every requested tool to be available before its first prompt.

The original PR exposed an opt-in flag for inherited misses, but both public
entry points set it for explicit agent types too. The Direct and Workflow entry
points now derive the flag from whether the selected agent type omits `tools`.
This preserves the difference between an inherited surface and an explicit role
requirement at the point where the two are still distinguishable.

Independent review also reproduced a registered `hidden` tool that Pi refused
to activate. The original preflight counted its activation request as success.
The check now re-reads Pi's actual active tools after activation, so an explicit
requirement rejects and an inherited miss reports the narrowed surface.

## Replay identity

Native and inline extensions have synthetic paths. Treating them as files
disables replay because `realpath` cannot resolve them. Dropping all synthetic
paths from the fingerprint also loses extension behavior: two real SDK loaders
with different inline prompt hooks produced the same replay identity at the
source baseline.

The corrected fingerprint includes each reviewed native factory's identity and
the executing Pi SDK version. Unknown inline and unknown built-in identities
disable replay. File-backed extensions retain their existing content hashes.
These observations establish an identity collision at the helper boundary;
they do not establish a previously observed incorrect production replay.

## Reproducible validation

The checked-in regressions exercise:

- actual SDK child registration and activation of `read`, `codemode`, and
  `tool_search`, without admitting unrelated tools;
- both public entry points, proving an inherited miss can complete while an
  explicit miss rejects before any child prompt;
- an actual SDK `hidden` tool, proving a refused activation cannot satisfy an
  explicit requirement or widen the inherited callable surface;
- real SDK loaders with distinct inline hooks, proving replay remains disabled
  when their implementation identity cannot be verified;
- the three reviewed native factories separately, proving their enabled
  identities produce distinct replay keys.

Restoring the original unconditional Workflow flag causes the entry-point
regression to complete the explicit call instead of rejecting it. Restoring the
original synthetic-path filter causes the replay regressions to accept unknown
inline identities and collapse the three native identities into one key.
The tests use local SDK Sessions and scripted model responses, without a remote
model request. Repository validation runs `bun run check` and `bun run test`.

## Limits

This is a scoped compatibility investigation, not a Benchmark or a new project
constraint. The Issue reports Pi 0.99.2 and third-party packages; the automated
evidence here uses the locked 0.99.1 SDK. Live external MCP servers, the named
browser/search packages, and remote provider behavior have not been exercised
by these regressions.
