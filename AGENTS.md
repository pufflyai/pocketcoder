# Repo Rules

- **Lerna + Bun-managed monorepo** with **Nx caching**. **TypeScript only**.
- Use **bun**, never `npm`, `yarn`, or `pnpm`.
- Your work is not done until all tests are passing.
- **No long-lived credentials where a workspace can read them** — anything a workspace can read must be workspace-scoped and expire with it, in product code, examples, and docs alike. See `docs/security.md`.

# Language

Use simple English in plans, explanations, documentation, tickets, comments, and messages.

- Write short, direct sentences.
- Use plain words instead of jargon.
- Explain technical terms that readers may not know.

# Coding Rules

Readability and structure matter most — we're happy to make bigger changes to achieve them:

- Keep things simple; assume the happy path first
- No defensive or speculative code, no backwards compatibility unless requested
- Clean up legacy or unused code as you go
- Files stay under **~350 lines** — split early
- Prefer pure functions; comment **WHY**, not WHAT
- Let TypeScript infer return types; avoid nested ternaries
- No deep relative imports across packages

# Workflow: TDD

1. **Red** — write the smallest failing test first (reproduce bugs before fixing them). Skip only for config/docs-only changes.
2. **Green** — write the minimum code to pass.
3. **Refactor** — clean up, delete dead code, keep tests green.
4. **Prove it** — run `bun run check`, `bun run typecheck`, and `bun run test` before finishing. If publishable output changed, run `bun run pack:check`.

## Testing

- Tests live next to the file they test.
- Avoid mocks — test the real thing.
- Bug fixes require a regression test.
- No tests for config/docs changes, literal bundled copy, or proving removed code stays gone.

## Changesets

- Two packages are published: **`@pstdio/pocketcoder-cli`** and **`@pstdio/pocketcoder-remote`** — add a changeset (`bun changeset`, one-line summary) when a change affects one of them. Not for test/refactor-only changes.
- Every other workspace is private and gets **bundled into** the published packages at build time. A published package must never list a private workspace package under `dependencies` — npm cannot resolve it — so declare it in `devDependencies` and let the bundler inline it. `bun run check` enforces this.
- Never edit `package.json` versions manually.
- `packages/remote` ships two bundles: the launcher (`src/bin.ts`) and the extension entry (`src/extension.ts`) that Pi loads with jiti at runtime. The extension bundle inlines the private workspace packages, so `@earendil-works/*` stay external — they are exact-pinned and shared with the host Pi, so treat Pi upgrades as deliberate changes.

## Database Migrations

- Never write or edit Drizzle migration SQL by hand — change the schema, then run `bun run db:generate`.
- One migration entry per PR.

## Git

- **Branches**: `<category>/<kebab-description>` (`feature`, `bugfix`, `hotfix`, `test`, `chore`)
- **Commits**: `<category>(<PC-XXX>): <statement>` (`feat`, `fix`, `refactor`, `chore`)
- **PRs**: draft against `main`, named like commits.

## CI Timeouts

A timeout that trips means something got slower — that's the bug. Never widen `timeout-minutes` without explicit approval.

# Tickets (pstdio)

Tickets (`PC-XXX`) are managed with the pstdio CLI. After editing a ticket, save it: `pst tickets save --id PC-XXX`. See `pst --help`.
