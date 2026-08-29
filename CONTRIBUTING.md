# Contributing to OpenPI

Thank you for contributing to OpenPI. Start with the guide that matches your change:

- [Fast-Forward and Linear Git History](docs/contributing/linear-git-history.md) - branch preparation, safe rebasing, pull request merge methods, and local updates.
- [Feishu PR notifications](docs/contributing/feishu-pr-notifications.md) - repository secret setup for pull request group bot messages.

The contribution guides are recommendations for the current repository workflow. Repository administrators must configure GitHub settings separately before those recommendations become enforced policy.

Before opening a pull request, run the checks documented in the guide and use the pull request template in `.github/PULL_REQUEST_TEMPLATE.md`.

## Line endings

The repository enforces LF line endings for text files through the root `.gitattributes` file. This keeps checkouts identical on Windows, macOS, and Linux regardless of a user's global `core.autocrlf` setting.

After pulling this policy into an existing checkout, first confirm that the worktree is clean, then re-check out tracked files so Git applies the attributes:

```bash
git status --short
git restore --source=HEAD --worktree -- .
git ls-files --eol
```

The final command should report `w/lf` for tracked text files. If the worktree is not clean, commit or stash the changes before running the restore command.
