# Engineering

- **Lerna + Bun-managed monorepo** with **Nx caching**. **TypeScript only**.
- Use **bun**, never `npm`, `yarn`, or `pnpm`.
- Your work is not done until all tests are passing.
- **No long-lived credentials where a workspace can read them** — anything a workspace can read must be workspace-scoped and expire with it, in product code, examples, and docs alike. See [security model](../security.md).

## Code style

Readability and structure matter most — we're happy to make bigger changes to achieve them:

- Keep things simple; assume the happy path first
- No defensive or speculative code, no backwards compatibility unless requested
- Clean up legacy or unused code as you go
- Files stay under **~350 lines** — split early
- Prefer pure functions; comment **WHY**, not WHAT
- Let TypeScript infer return types; avoid nested ternaries
- No deep relative imports across packages
- Group package source and adjacent tests by feature. Keep entry points and composition at the package root.
- Compose services and repositories with explicit dependencies. Do not use inheritance just to split behavior across files.

## Database Migrations

- Use schema-backed Drizzle queries for application reads and writes. Pass one transaction through atomic operations; keep PostgreSQL-specific SQL in focused helpers.
- Never write or edit Drizzle migration SQL by hand — change the schema, then run `bun run db:generate`.
- One migration entry per PR.
