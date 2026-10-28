# 003: Run servers on PostgreSQL and store conversations as JSON documents

Status: Proposed for PC-143. Supersedes PC-58's PGlite-only store and the
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

Open: whether a conversation document is rewritten whole at each turn, or
assembled on read from immutable per-turn JSON records. Per-turn records give
constant write cost and simpler object storage, at the price of an extra read
step. Decide before PC-153 starts.

This brings back a PostgreSQL context, migrator and lease from 0.8.1, an upgrade
step, a conversation document store, and CI for both drivers plus upgrades from
the previous release. It does not add controller replicas, an object storage
backend or changes to the manager's own PGlite database.
