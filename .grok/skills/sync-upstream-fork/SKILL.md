---
name: sync-upstream-fork
description: >
  Synchronize this fork with the configured upstream repository while preserving fork-specific behavior, resolving conflicts deliberately, and validating the result through GitHub Actions only. Use when the user asks to merge or sync upstream updates, refresh this fork, update CI workflows, build remote artifacts, or runs /sync-upstream-fork.
---

# Sync Upstream Fork

Execute this workflow end to end. Keep the current branch safe and never merge directly into `main` unless the user explicitly requests it.

## 1. Inspect Before Changing

- Read `AGENTS.md` and any repository handoff or architecture documents that govern the affected areas.
- Run `git status --short --branch` and inspect existing changes. Never discard or reset changes that are not part of this task.
- Inspect `git remote -v`, identify the upstream remote and its default branch, and verify the fork remote before fetching.
- Inspect `.github/workflows/` and the build/package scripts before changing CI.
- Record the current branch and the fork-specific features that must survive the merge. In this repository, pay particular attention to custom quota, Sub2API quota, quota refresh, monitoring, manager configuration redaction, and related API behavior.

## 2. Fetch and Merge

- Fetch upstream tags and branches with `git fetch upstream --tags`.
- Create or use a dedicated synchronization branch such as `chore/sync-upstream-<version>`; do not work directly on `main`.
- Merge the upstream default branch with a merge commit: `git merge --no-ff upstream/<default-branch> -m "merge: sync upstream <default-branch>"`.
- For every conflict, inspect both parent versions and the surrounding call sites. Preserve the upstream behavior and reapply fork behavior at the correct abstraction boundary. Do not resolve conflicts by blindly taking one side.
- Preserve generated-file rules. In this repository, `apps/manager-server/internal/httpapi/web/management.html` is generated and must not be edited manually; regenerate it only through the project build process on CI.
- After conflict resolution, search all affected directories for conflict markers and run `git diff --check`.

## 3. Validate the Merge Statically

- Review the merge diff against both parents, especially files where fork features overlap upstream changes.
- Confirm imports, switch branches, response types, secret redaction, request scopes, and persistence paths remain internally consistent.
- Use focused source inspection and repository search for static checks.
- Do not run local compilation, builds, type checks, linters that invoke a build, or tests. This repository requires compilation and test verification through GitHub Actions only.

## 4. Keep the Workflow Surface Intentional

When the request includes workflow cleanup:

- Retain the project PR check workflow and ensure it is triggered by `pull_request` for the supported target branches.
- Add one dedicated CI build workflow with `push` and `workflow_dispatch` triggers. It must use the repository-pinned action SHAs, Node.js 24, Go 1.24, `npm ci`, the full web build, the demo-isolation check, and `bin/release/package-native.sh`.
- Upload a normal Actions artifact with `actions/upload-artifact`, containing the generated management page, all native packages, and `checksums.txt`.
- Make artifact names include the built commit SHA. The native package script produces Linux/macOS/Windows amd64 and arm64 packages.
- Remove workflows the user explicitly identifies as unnecessary. If only PR check and CI build are requested, the final `.github/workflows/` directory should contain only those two workflows. State clearly that removing release, Pages, Docker publish, Issue, or notification workflows disables their automation.
- Run static checks after workflow edits: workflow file listing, trigger inspection, `git diff --check`, and conflict-marker search.

## 5. Commit, Push, and Use Remote CI

- Commit the merge and workflow changes in focused commits on the synchronization branch.
- Push the branch to the fork remote.
- Use `gh run list --workflow <workflow-file> --branch <branch>` to locate the run created by the push.
- Wait with `gh run watch <run-id> --exit-status`. On failure, read `gh run view <run-id> --log-failed`, fix the underlying source or workflow issue, push again, and repeat. Never reproduce a prohibited build locally.
- Treat a successful run as verified only when the build job and artifact upload both succeed.

## 6. Download and Check the CI Version

- Download the artifact from the successful run with `gh run download <run-id> --name <artifact-name> --dir dist/ci`.
- Verify the local artifact layout and run the provided checksum manifest from its directory, for example `cd dist/ci/native && sha256sum -c checksums.txt`.
- Keep downloaded CI output in the repository's ignored `dist/` directory unless the user explicitly asks to replace a tracked release file. Report the exact local path, commit SHA, run URL, and artifact contents.

## 7. Final Review

- Confirm `git status --short --branch` is clean apart from intentionally ignored CI output.
- Confirm the synchronization merge commit is an ancestor of `HEAD` and the pushed branch points to the final commit.
- Confirm only the intended workflows remain and no conflict markers exist.
- For web-facing changes, use available browser tools to exercise affected routes and check desktop and mobile layouts. If browser tools are unavailable, state that limitation and report the remote CI/static checks used instead.
- Summarize preserved fork features, removed automation, CI run result, artifact path, and any remaining limitations.
