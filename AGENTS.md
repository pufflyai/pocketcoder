# Repo Rules

- **Lerna + Bun-managed monorepo** with **Nx caching**. **TypeScript only**.
- Use **bun**, never `npm`, `yarn`, or `pnpm`.
- Your work is not done until all tests are passing.

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

- Only **`@pstdio/pocketcoder-cli`** and **`@pstdio/pocketcoder-remote`** are published — add a changeset (`bun changeset`, one-line summary) when a change affects one of them. Not for test/refactor-only changes.
- Never edit `package.json` versions manually.
- `packages/remote` intentionally ships `src/` in the tarball: Pi loads the extension entry (`src/extension.ts`) with jiti at runtime, so only the launcher (`src/bin.ts`) is bundled. Its `@earendil-works/*` dependencies are exact-pinned; treat Pi upgrades as deliberate changes.

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
