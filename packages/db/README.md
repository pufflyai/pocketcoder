# `@pstdio/pocketcoder-db`

The PostgreSQL persistence adapter for PocketCoder.

## Why it exists

Production control-plane state must survive server restarts and support safe
coordination between operations. This package keeps PostgreSQL and Drizzle
details behind the runtime's driver-neutral store contract.

## What it does

- Implements the full runtime `Store` interface with `PostgresStore`.
- Defines the Drizzle schema for principals, keys, templates, workspaces,
  conversations, logs, persistence, warm pools, terminals, and the event
  outbox.
- Runs generated migrations under a PostgreSQL advisory lock and reports
  migration status.
- Supports configurable PostgreSQL schemas for deployment and isolated tests.

Change the TypeScript schema first, then run `bun run db:generate` from the
repository root. Do not edit generated migration SQL by hand.

## Source layout

`store.ts` composes feature repositories under `src/modules/`. They share one
Drizzle client and schema-qualified table set from `src/database/context.ts`.
The runtime contract stays in `runtime-contracts`; only this adapter imports
Drizzle. Ordinary queries use table objects and inferred row types.

`src/schema/` contains table factories shared by runtime queries and Drizzle
Kit. Kit receives unqualified tables, while runtime queries use the configured
PostgreSQL schema. A TypeScript type or file move must not create a migration.

Workspace state changes pass one transaction to history and outbox writes.
PostgreSQL advisory locks remain in focused helpers, and the coordinator keeps
its session lock on a reserved connection until shutdown.

Run database conformance tests against a disposable PostgreSQL database by
setting `POCKETCODER_TEST_DATABASE_URL` in your test environment, then running
`bun test packages/db/src` from the repository root. Tests create isolated
schemas and remove them when they finish.
