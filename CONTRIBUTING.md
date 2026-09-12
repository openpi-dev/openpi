# Contributing to OpenPI

Thank you for contributing to OpenPI. Start with the guide that matches your change:

- [Fast-Forward and Linear Git History](docs/contributing/linear-git-history.md) - branch preparation, safe rebasing, pull request merge methods, and local updates.
- [Feishu PR notifications](docs/contributing/feishu-pr-notifications.md) - repository secret setup for pull request group bot messages.

The contribution guides are recommendations for the current repository workflow. Repository administrators must configure GitHub settings separately before those recommendations become enforced policy.

Before opening a pull request, run the checks documented in the guide and use the pull request template in `.github/PULL_REQUEST_TEMPLATE.md`.

## Line endings

The repository enforces LF line endings for text files through the root `.gitattributes` file. This keeps checkouts identical on Windows, macOS, and Linux regardless of a user's global `core.autocrlf` setting.

Pulling this policy into an existing checkout can leave CRLF files unchanged, even when `git status` is clean. To get an LF checkout, keep the existing directory intact and clone into a new, unused directory from its parent directory:

```bash
git clone https://github.com/openpi-dev/openpi.git openpi-lf
git -C openpi-lf ls-files --eol
```

The cloned revision must include this policy. The final command should report `w/lf` for tracked text files with line endings; files without line endings can report `w/none`, and binary files are excluded from this policy.

A fresh clone only includes commits available on the remote. It does not copy unpushed commits, uncommitted changes, untracked files, or ignored files such as local configuration and evidence. Keep the old checkout until you have deliberately transferred any local work you need.
