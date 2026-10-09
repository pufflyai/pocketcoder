# `@pstdio/pocketcoder-db`

The embedded PGlite store for PocketCoder. `PGliteStore.create(dataDir)` opens
`dataDir/db/`, migrates it and returns the full runtime `Store`. Omit `dataDir`
for a fresh in-memory PGlite instance in tests. Close the store when finished.

The fixed core schema is `pocketcoder`. Its generated SQL registry, seed, WASM
and filesystem bundle ship with the application. No source checkout or adjacent
migration folder is needed. The core seed contains only core tables; a future
manager must build its own seed and registry.

Disk instances take a kernel `flock` on the canonical data folder's stable
`LOCK` file before database writes. The descriptor stays open until close;
SIGKILL releases it. Do not delete `LOCK`. Use local disk or block storage,
never NFS or EFS. A Kubernetes node must be fenced before volume reattachment.

First start stages the seed, syncs its files and atomically publishes `db/`.
Startup rejects incompatible engine versions, unknown migration history, gaps
and checksum drift. PostgreSQL fsync is enabled and routed to native file and
directory fsync. PGlite relaxed durability is disabled; shared buffers are 16 MB.

`store.ts` composes adjacent feature repositories under `src/modules/` using
one Drizzle client and schema-backed queries. Transactions share one connection;
keep driver, network and timer waits outside their callbacks. Workspace state,
history and outbox changes use the same transaction.

Change the TypeScript schema first, then run `bun run db:generate`. Do not edit
migration SQL by hand. `bun run db:seed` rebuilds the core seed and SQL registry;
`bun run check` verifies those assets against generated migrations and the
pinned engine. Type-only changes do not need a new migration.

`bun test packages/db/src` runs memory and disk conformance, rollback, migration
drift, process locking, SIGKILL recovery and a compiled fixture without adjacent
assets. The compiled fixture also checks the 512 MB first-start memory budget.
CI runs the disk and compiled checks on macOS and Linux, on arm64 and x64.
Real hosted block-volume crash and node-fencing checks remain release gates.
