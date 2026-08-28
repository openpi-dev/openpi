# Fast-Forward and Linear Git History

OpenPI aims to keep `main` as a linear sequence of commits. Pull requests
should be rebased onto the latest `main`, and merging a pull request should not
create a merge commit.

This guide describes the intended workflow, not the repository's currently
enforced configuration. At the time of writing, GitHub still allows merge
commits and `main` does not require linear history. Maintainers must complete
the settings below before relying on GitHub to enforce this policy.

This policy applies to new contributions. Do not rewrite published `main`
history merely to improve its appearance: a history rewrite changes commit
IDs and forces every collaborator to resynchronize their checkout.

## Repository settings

In the repository-wide **Pull Requests** settings:

- allow **Rebase and merge** and **Squash and merge**; and
- disable **Create a merge commit**.

In the branch protection rule or ruleset for `main`:

- require the relevant CI checks and reviews;
- block force pushes and branch deletion;
- enable **Require linear history**; and
- require the pull request branch to be current when that is necessary for
  reliable checks.

These settings are the final enforcement layer. Until they are enabled, the
repository can still accept history that conflicts with this guide.
Contributors should prepare a linear branch locally so that conflicts and test
failures are resolved before merge.

## Preparing a pull request

Create a topic branch from the current remote `main`:

```bash
git fetch origin
git switch -c <topic-branch> origin/main
```

Before requesting review or after `main` changes, rebase the topic branch:

```bash
git fetch origin
git switch <topic-branch>
git rebase origin/main
```

Resolve each conflict, stage the resolved files, and continue. Abort the
operation if the conflict cannot be resolved confidently:

```bash
git add <resolved-files>
git rebase --continue

# Restore the branch to its state before this rebase.
git rebase --abort
```

A rebase changes the topic commits' IDs. If the branch was already pushed,
record the remote tip before fetching, then fetch and compare that expected
SHA with the updated remote-tracking branch:

```bash
expected=$(git ls-remote --exit-code origin refs/heads/<topic-branch> | cut -f1)
git fetch origin <topic-branch>
test "$expected" = "$(git rev-parse origin/<topic-branch>)" || {
  echo "Remote branch changed; inspect and reconcile its commits before pushing."
  exit 1
}
git log --oneline HEAD..origin/<topic-branch>
```

If the final command shows remote-only commits, stop and reconcile them with
the collaborator who pushed them. After confirming that the expected remote
tip is the one being replaced, update the branch with an explicit lease:

```bash
git push --force-with-lease=refs/heads/<topic-branch>:"$expected" \
  origin HEAD:refs/heads/<topic-branch>
```

Keep `expected` in the same shell for the comparison and push. If the remote
branch changes after the check, the explicit lease rejects the push. For a new
remote branch, use a normal `git push -u origin <topic-branch>` instead.

Do not use an unqualified `--force` or an implicit `--force-with-lease`. Before
pushing, inspect the patch and the topic branch history, then run the
repository checks:

```bash
git diff --check origin/main...HEAD
git log --oneline --graph --decorate origin/main..HEAD
bun run check
bun run test
```

A pull request may contain several commits while it is under development. By
default, squash a multi-commit pull request when merging it. Preserve its
individual commits only when every commit has been deliberately reviewed as a
useful project-history unit.

## Merging a pull request

First verify the pull request's base branch, latest commit, required reviews,
and CI results. Do not merge the pull request branch into a local `main` and
push the resulting merge commit. Update protected `main` through GitHub's pull
request merge controls.

**Squash and merge is the default for a pull request with multiple commits.**
Use **Rebase and merge** only for the exception where every commit is coherent,
passes the relevant checks independently, has a permanent-quality message,
and is useful to inspect or revert on its own. Commit count alone is not a
reason to preserve intermediate development history.

The equivalent GitHub CLI commands are:

```bash
# Preserve the pull request's individual commits.
gh pr merge <number> --rebase --match-head-commit <head-sha>

# Replace the pull request's commits with one project commit.
gh pr merge <number> --squash --match-head-commit <head-sha>
```

`--match-head-commit` prevents an approval of one revision from accidentally
merging a newer, uninspected revision. Add `--delete-branch` when the topic
branch is no longer needed.

### Rebase and merge

Use **Rebase and merge** only when every pull request commit is clear,
independently useful, and worth preserving. GitHub reapplies the commits onto
the current tip of `main` without creating a merge commit.

This is appropriate when:

- each commit represents one coherent change;
- the sequence of implementation, tests, and documentation is meaningful; and
- all commit messages follow the repository convention.

### Squash and merge

Use **Squash and merge** by default for a multi-commit pull request, especially
when it contains work-in-progress, review-fix, debugging, or other intermediate
commits that have no lasting value. GitHub creates one commit on `main`, so the
result is still linear but the pull request's internal commit boundaries are
discarded.

This is appropriate when:

- the pull request represents one release or rollback unit;
- intermediate commits are not useful to inspect independently; or
- one concise project commit communicates the change better.

Edit the squash commit title so that it describes the delivered change. Do
not leave a work-in-progress or generated title as the permanent `main`
history.

### When neither option is ready

If the pull request requires its merge topology to be preserved, cannot be
rebased cleanly, or has stale checks, stop and resolve that condition. Do not
select **Create a merge commit** merely to bypass the linear-history policy.
Normally, the author should rebase onto the latest `main`, resolve conflicts,
push with the explicit expected-SHA lease described above, and rerun CI.

For a pull request from a fork, ask the author to perform the rebase when a
maintainer cannot update the branch. If the author allows maintainer edits,
the same lease and validation requirements apply. GitHub reporting a pull
request as mergeable only means that it has no currently detected merge
conflict; it does not satisfy CI, review, or other repository gates.

## After merging

Update the local branch with fast-forward only and inspect the result:

```bash
git fetch origin
git switch main
git pull --ff-only origin main
git log --first-parent --oneline -10
git status --short --branch
```

`git pull --ff-only` fails instead of silently creating a merge commit when
the local and remote branches have diverged. If a non-linear commit is already
published, record the exact commit and its source and discuss remediation
separately. Never rewrite public history without explicit authorization, a
verified backup, and collaborator coordination.

## Merge method summary

| Pull request state | Merge method |
| --- | --- |
| One commit | **Rebase and merge** or **Squash and merge**; both produce one `main` commit |
| Multiple commits | **Squash and merge** by default |
| Multiple independently tested, review-quality commits with lasting value | **Rebase and merge** as an explicit exception |
| The branch conflicts with or trails `main` | Rebase and rerun checks first |
| Merge topology is a required part of the change | This policy does not support it; propose and approve a separate policy and repository-settings change first |
