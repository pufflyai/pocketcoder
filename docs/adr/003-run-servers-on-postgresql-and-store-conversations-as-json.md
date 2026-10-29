# 003: Run servers on PostgreSQL and store conversations as JSON documents

Status: Accepted for PC-143. Supersedes PC-58's PGlite-only store and the
per-revision message rows in ADR 001.

PC-58 replaced the PostgreSQL store with embedded PGlite. The first server
consumer, Onefin, could not upgrade: 1.0 cannot read a 0.8.x database, so Alpha
needed a fresh controller with new principals, keys and an admission map. Its
deploys failed for a week, and an attempt to automate the cutover left the
runtime down. PGlite gave server deployments nothing in return. Both lines run
one controller, and PGlite gave up managed backups, point-in-time recovery and
multi-AZ storage for an AZ-pinned volume. Conversation history also grew badly:
one row per streamed revision, a full history scan on every append, and seven
days of default retention.

Select the store by configuration. PostgreSQL is the default for servers;
PGlite stays for local, desktop and single-binary use. Both share the existing
Postgres schema, migrations and repository queries. Paths that normal operation
needs, such as admission and warm-pool claims, get a PostgreSQL implementation.
Operator features that only make sense for a data folder (folder backups,
off-node backup, writer fencing) refuse in PostgreSQL mode; backups come from
the database. The deletion journal stays in both modes. After a database
restore, the controller replays it so revoked keys, retired secrets and deleted
conversations stay deleted.

Every release upgrades the previous release's database in place. Shipped
migrations are never edited. The 0.8.1/1.0 split (`tiny_marvel_zombies` vs
`marvelous_praxagora`) is reconciled by an upgrade step that detects the 0.8.1
migration, applies only the missing constraints and records the 1.0 migration
with its real hash. That keeps the prefix check in the migrator. Legacy
double-encoded JSON from 0.7.1 is normalised once. Principals, keys, admission
state and history carry over. Old workspaces and checkpoints return the explicit
unsupported result from PC-125.

PocketCoder owns conversation history. Each conversation is one JSON document,
keyed by the caller's conversation identity, with many per workspace. It is
written at turn boundaries, never per streaming delta. The live turn is served
from memory and the event stream. Request receipts stay durable as in ADR 001.
After a crash, a receipt without a stored result becomes an explicit
`interrupted` turn. PocketCoder never rebuilds history from harness or native
session files. Totals are kept on the conversation row instead of scanned.
Existing rows convert once; rows without a conversation identity become one
flagged legacy document per workspace, since ADR 001 forbids made-up identities.
Storage sits behind an interface so documents can move to object storage later.
Retention stays a template value, capped and overridable by the server, and a
server may keep history until it is deleted.

Configured principals are issued keys by the controller, which writes each
token once to a secret target the consumer declares. Digests stay
`HMAC(pepper, keyId:secret)`, so consumers never hold the pepper. Keys rotate
with an overlapping successor. While external admission is unavailable,
launches keep queueing and policy reconciliation stays fail-closed. Admin and
principal APIs answer once the process is live, so bootstrap code waits on
`/livez`, not `/readyz`.

## Decisions made during implementation

- **Per-turn records, not whole-document rewrites.** A conversation document is
  assembled on read from immutable per-turn JSON records. A turn costs one insert
  of its own size, whatever the length of the history, and object storage can
  later hold each record as one object. Cursor reads page by message sequence;
  the record's sequence range finds the records to read.
- **Store selection.** A database URL selects PostgreSQL; without one the
  embedded store stays the default for local and desktop use.
  `POCKETCODER_STORE=pglite` keeps the embedded store even with a URL.
  PostgreSQL needs the existing auth pepper from the environment, so upgraded
  key digests keep working, and the deletion journal volume.
- **Restore rule.** On PostgreSQL the controller replays the whole deletion
  journal at every start, not only after a detected restore. Records name exact
  targets and every runtime access change is journaled, so a replay changes
  nothing that is still current. Writer fencing by data folder is replaced by the
  coordinator advisory lock. A database bound to a journal refuses to start with
  a missing or different one.
- **Migrations on PostgreSQL** run only through `pcd db migrate`. Controllers
  refuse to start with pending migrations, so startup never changes a shared
  schema.
- **Unidentified messages** (AgentAPI messages and harness lines without a
  request identity) are single message records in a document of their
  workspace. Converted pre-1.0 messages without identity form legacy records in
  that document, in their original order.
- **Turn boundaries.** An identified turn is written when its `turn_terminal`
  fact arrives. A turn left open is written as `interrupted` when its workspace
  ends or, after a controller restart, from its request receipt. A request that
  is still waiting for dispatch is left alone.
- **Old checkpoints.** 0.8.x checkpoints live on storage backends 1.0 does not
  use (`kubernetes-pvc`). Restore and resume return `409 checkpoint.unsupported`
  with the provider kind instead of failing inside a restore. Old workspaces stay
  readable; their alpha snapshots are still supported by the 1.0 runtime.
- **AgentAPI reads.** AgentAPI 0.12 has no incremental message read. The
  supervisor now reads `/messages` while the agent runs and once after it
  settles, instead of on every health probe of an idle agent. A truly
  incremental read waits for the AgentAPI events stream (PC-136).

This brings back a PostgreSQL context, migrator and lease from 0.8.1, an upgrade
step, a conversation document store, and CI for both drivers plus upgrades from
the previous release. It does not add controller replicas, an object storage
backend or changes to the manager's own PGlite database.
