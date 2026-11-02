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
and an independent writable storage allocation. A request can name another
compatible version of the same template instead; see below.

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

## Restore onto a newer template version

A checkpoint remembers the template version it was taken from, and a plain
restore, recreate or resume always runs that version again. To move a
long-lived workspace onto a new image or new resource limits, publish a new
version of the same template and name it in the request. Any compatible,
non-retired version works; PocketCoder does not compare version numbers, so
it does not stop you from going back to an older one.

```json
{ "external_id": "task-42-v2", "template_version": "1.1.0" }
```

`template_version` works on `restore`, `recreate` and `resume`. The template
name always stays the checkpoint's template. PocketCoder resolves the version
once, checks it, and records it on the new workspace. The saved files are
restored unchanged, so the target version must be compatible with the
checkpoint's version:

| Rule | Rejected with `details.reason` |
| --- | --- |
| Same `persistence.conversationRestore`, `persistence.sessionCompatibility` and `agent.stateFile` | `session_format` |
| Same mounts in the same order, with the same `name` and `target`; `maxBytes` and `maxFiles` may grow but not shrink | `persistence_mounts` |
| Same `security.uid` and `security.gid`, because restored files keep their owner | `file_ownership` |
| The checkpoint manifest was written for the checkpoint's template and lists the same mounts | `checkpoint_manifest` |

Everything else may change, for example the image, resources, timeouts,
harness command, services, or network policy. PocketCoder cannot see how a
harness stores its session. When a new version changes that format, change
`sessionCompatibility` too, so old checkpoints are rejected instead of
resumed into a harness that cannot read them.

Checkpoints that the Docker and Kubernetes drivers send to the controller as
archives may not keep their manifest in the database. For them the server checks the template rules above, and the
workspace checks the archive's mount list against the new version when it
downloads the archive. A mismatch there fails the restore operation; the
source workspace and checkpoint stay usable.

A rejected request returns one of these errors:

- `403 restore.template_not_authorized`: the caller may no longer use the
  template.
- `404 template.version_not_found`: the version does not exist or is retired.
- `409 restore.incompatible`: the version breaks a rule above. `details` also
  carries `checkpoint_id` and `template_version`.

Changing the session format or the mount layout needs a data migration, which
an upgrade does not do. Nothing upgrades on its own; omit `template_version`
to keep the checkpoint's version.

PocketCoder checks the target before it records any operation or workspace.
A rejected upgrade leaves the source workspace `preserved` and its checkpoint
`ready`, and records nothing, so a retry with the same `Idempotency-Key`
checks again. Publish a compatible version, or omit `template_version`, and
retry. Retried and concurrent requests with the same key and body return the
same new workspace, or the same error. A request that arrives while the first
one is still queuing waits up to 5 seconds for its result, then returns
`409 operation.conflict`; retry it with the same key.

The checkpoint keeps its original template digest, and storage is restored
against that digest, not the new one.

To see which version a workspace runs, read `template.version` and
`template.digest` from `GET /v1/workspaces/{id}` (or `pcd workspaces get`).
The new workspace also reports `restored_from_checkpoint_id` and
`origin_workspace_id`, and its own later checkpoints record the new version.

Administrative storage inspection is available at `GET
/v1/storage/inventory`; `POST /v1/storage/prune` runs an immediate retention
sweep. The sweep also physically removes expired transcript rows while keeping
their expiry tombstones, and reports `transcripts_deleted`. Both routes require
`admin`. Inventory returns opaque IDs only, never physical paths or backend
references.

