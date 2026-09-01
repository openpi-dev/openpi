# Releasing OpenPI to npm

OpenPI releases `@tt-a1i/openpi` through [the Release workflow](.github/workflows/release.yml). The repository workflow keeps the release triggers and OIDC permission while following the reusable implementation on the [`openpi-dev/automation`](https://github.com/openpi-dev/automation) `main` branch. Do not publish from a local checkout.

## One-time repository setup

Before the first workflow release:

1. Configure the npm trusted publisher for GitHub organization/user `openpi-dev`, repository `openpi`, workflow `release.yml`, and environment `npm`. The published npm package remains `@tt-a1i/openpi`.
2. Protect the GitHub `npm` environment with a required reviewer and prevent unreviewed deployment from other branches or tags. Allow only the protected `main` branch and version tags matching `v*.*.*`.

The workflow has no long-lived npm token. Its publish job receives an OIDC identity only after the unprivileged validation job succeeds and the `npm` environment permits the deployment. The publish job consumes only the validated package artifact and does not run repository lifecycle scripts.

## Release by version tag

The version tag is the canonical release entry point:

1. Update `package.json` to the intended version through a pull request and merge it to `main`.
2. Create and push `v<package.json version>` at that merged commit, for example `v0.5.0`.
3. Approve the `npm` environment deployment when the Release workflow reaches the publish job.
4. Confirm the workflow succeeded and the npm package version and provenance are visible.

The workflow rejects tags whose name differs from `package.json`, and rejects tagged commits that are not contained in `main`.

## Manual dispatch

Use `workflow_dispatch` only to publish an existing version tag explicitly. Run the workflow from `main` and supply the tag in the required `tag` input. The same version, ancestry, validation, environment, and publication checks apply. A workflow can also be rerun after a transient failure without creating or moving a tag.
