# Finite exports

A finite-process operation declares output roots and finite file, byte, retention
and finalization limits. Docker allocates these roots with the configured managed
filesystem storage. Admission requires installed `stop-before-export` capability;
unsupported storage fails admission. Kubernetes qualification is separate work.

The existing scheduler owns this order:

1. Observe exact process exit, cancellation, deadline or proved runtime loss.
2. Stop and remove the exact provider incarnation. Confirm stop proof for every
   writer, including workspace services, before reading output storage.
3. Keep output storage allocated while the trusted filesystem driver reads declared
   regular files. It rejects symlinks, hard links, special files, cross-device
   traversal and changed file identities, and enforces byte/file/deadline bounds.
4. Commit retained bytes, immutable object references, one manifest and execution
   finalization in one database transaction. Input pins and storage reservations
   change in that transaction too. PostgreSQL and PGlite use the same owner.
5. Remove extraction resources and staging storage. Mark `cleanupState: complete`
   only after that succeeds. A retry uses the saved manifest and retries cleanup.

No collector acknowledgement holds compute open. A controller crash before the
transaction leaves no published result; recovery reads the stopped allocation
again. A crash after commit returns the same frozen result without rereading lost
staging bytes. Bytes are private database payloads bounded by deployment storage
capacity, not host paths or temporary download credentials.

Execution outcome and collection completeness are separate. A failed command can
publish complete diagnostics. Empty complete means collection succeeded with no
files. Missing storage, an exceeded finalization budget or an unsafe selection
produces partial/lost evidence with safe error codes. A file listing is never the
receipt for collection. `manifestDigest` commits to execution identity, ordered
immutable objects, completeness and errors. Availability and staging cleanup can
change without rewriting that commitment.

The [collection API](api.md#finite-result-collection) remains readable after compute
removal. Retention starts at manifest publication. Content reads check principal,
workspace ownership, purge, expiry and deletion. Explicit deletion removes bytes
and releases retained storage capacity in one transaction. Expiry does the same
through background retention. Receipts keep their immutable object references so
an unavailable result is not mistaken for successful empty output. Workspace
content purge still removes this physical API's retained content. PC-165 will add
logical session ownership so replacement workspace purge cannot remove session
objects; that API is not implemented here.

Shared publication lives in `db/src/modules/outputs/retained-exports.ts` and accepts
an existing execution reference. Interactive collection can reuse it. Finite
extraction lives in `server/src/persistence/finite-exports.ts`; it is not a second
scheduler or transcript owner.
