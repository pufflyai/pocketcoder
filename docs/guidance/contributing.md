# Contributing

## Changesets

- Three packages are published: **`@pstdio/pocketcoder-cli`**, **`@pstdio/pocketcoder-remote`**, and **`@pstdio/pocketcoder-sdk`** — add a changeset (`bun changeset`, one-line summary) when a change affects one of them. Not for test/refactor-only changes.
- Private workspace dependencies used by published packages get **bundled into** those packages at build time. A published package must never list a private workspace package under `dependencies` — npm cannot resolve it — so declare it in `devDependencies` and let the bundler inline it. `bun run check` enforces this.
- Never edit `package.json` versions manually.
- `packages/remote` ships two bundles: the launcher (`src/bin.ts`) and the extension entry (`src/extension.ts`) that Pi loads with jiti at runtime. The extension bundle inlines the private workspace packages, so `@earendil-works/*` stay external — they are exact-pinned and shared with the host Pi, so treat Pi upgrades as deliberate changes.

## Git

- **Branches**: `<category>/<kebab-description>` (`feature`, `bugfix`, `hotfix`, `test`, `chore`)
- **Commits**: `<category>(<PC-XXX>): <statement>` (`feat`, `fix`, `refactor`, `chore`)
- **PRs**: draft against `main`, named like commits.
- Before creating or updating a PR, read `.github/pull_request_template.md`. Keep its headings in order and fill in every section. Keep validation results, dependencies, and remaining work under the relevant headings.
- Write the completed PR body to a file and pass it with `gh pr create --body-file` or `gh pr edit --body-file`. These commands replace the template, so the file must contain the full completed template.
- After creating or updating a PR, read its saved body with `gh pr view --json body` and check that every template section is present and filled in.
- When a branch requires a merge queue, use the queue and let its required checks pass. Do not bypass it with `--admin`.

## Finishing a PR

Follow [CI and merges](../ci.md). After pushing, wait for all applicable checks
on the latest commit. Inspect failures and fix their causes. Pending, failed,
cancelled and timed-out checks mean validation is unfinished.

Keep a blocked PR open as a draft. Explain the blocker and link its evidence.
For an unrelated failure, verify it on the base branch and link a separate fix.
Do not describe opening a PR or passing local checks as completed CI.

Read review comments, including inline comments. Fix valid findings and run the
affected checks before pushing again. Use `gh pr ready` only when the required
local checks and CI pass on the latest commit.

When asked for a PR stack, keep separate PRs, base each on the preceding branch,
and preserve dependency order. Create a combined PR only when requested.
