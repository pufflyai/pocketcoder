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
