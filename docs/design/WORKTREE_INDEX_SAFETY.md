# Worktree Index Safety

Status: validated
Created: 2026-09-08
Verified: 2026-09-08
Issue: [#472](https://github.com/openpi-dev/openpi/issues/472)

## Decision

Automatic worktree reclamation must treat the checkout index as an independent
source of safety evidence. Before `git worktree remove`, OpenPI reads the
worktree's tracked-file inventory with `git ls-files -v -z`.

- `assume-unchanged` and `skip-worktree` entries preserve the worktree because
  ordinary status may hide a tracked local change.
- A failed, truncated, or unrecognized inventory also preserves the worktree.
- The check is read-only. It does not clear flags, reset files, or infer that a
  sparse checkout is safe to remove.

The existing status, ignored-file, baseline, commit, detached-head, and
non-force removal checks remain in place.

## Alternatives

Copying the index to a temporary `GIT_INDEX_FILE`, clearing flags, and
recomputing the diff would detect more states, but it mutates the inspection
surface and requires a policy for sparse checkout entries. The conservative
inventory check is sufficient for the reported loss mode and fails closed when
it cannot establish a trustworthy answer.

## Validation

The regression suite uses temporary Git repositories and verifies both
`assume-unchanged` and `skip-worktree`, with and without a modified file. It
asserts that the checkout, file contents, branch, and index bytes remain
unchanged. It also covers NUL-delimited unusual paths and unreadable,
truncated, malformed, and over-limit inventory results.

Validation commands:

```text
node --test --experimental-strip-types tests/extensions/shared/worktree.test.ts
```

Full repository checks are recorded in the pull request before publication.

## Ablation

Removing the index inventory gate makes the existing `status` and non-force
`worktree remove` checks pass for both hidden-flag fixtures, deleting the only
copy of the modified tracked file. Removing the NUL-delimited parsing would
make unusual tracked paths ambiguous. Both elements are therefore retained.
