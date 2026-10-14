# Attach, checkpoints, and restore

Attach is ordinary use of the existing workspace and allowlisted relay; it
creates no human session credential. It is valid only while the execution is
`ready`.

```text
POST /v1/workspaces/{id}/preserve       scope workspaces:preserve
GET  /v1/workspaces/{id}/checkpoints    scope checkpoints:read
GET  /v1/checkpoints/{id}               scope checkpoints:read
POST /v1/checkpoints/{id}/verify        scope checkpoints:read
DELETE /v1/checkpoints/{id}             scope checkpoints:delete
POST /v1/checkpoints/{id}/restore       scope workspaces:restore
POST /v1/workspaces/{id}/recreate       scope workspaces:restore
POST /v1/workspaces/{id}/resume         scope workspaces:restore
GET  /v1/operations/{id}                scope workspaces:read
GET  /v1/workspaces/{id}/outputs        scope outputs:read
```

All mutating checkpoint routes require `Idempotency-Key`. Preserve rejects new
relay work; native workspaces wait for stable AgentAPI, synchronize its final
messages, and gracefully terminate it. PocketCoder then snapshots
only template-declared mounts, verifies the manifest, and makes the source
terminal `preserved`. Restore never reopens it: a new queued workspace gets
the exact template snapshot, fresh provider and credentials, lineage fields,
and an independent writable storage allocation.

`conversation_restore` is `supported`, `filesystem_only`, or `unknown`; the
workspace also exposes `conversation_resume: {status, reason}`. `recreate`
and checkpoint `restore` are generic filesystem recovery. `resume` is the
stricter conversation operation: it selects the latest ready checkpoint,
creates a new workspace with source/checkpoint lineage only when capability is
`supported`, and otherwise returns `409 resume.unsupported` with stable
`details.reason` (`filesystem_only` or `capability_unknown`). No operation
promises process-memory, socket, in-flight request, or external side-effect
restoration.
Ready checkpoint content is immutable. Expired checkpoints are removed by the
retention sweep through the same durable delete operation.

Administrative storage inspection is available at `GET
/v1/storage/inventory`; `POST /v1/storage/prune` runs an immediate retention
sweep. The sweep also physically removes expired transcript rows while keeping
their expiry tombstones, and reports `transcripts_deleted`. Both routes require
`admin`. Inventory returns opaque IDs only, never physical paths or backend
references.

