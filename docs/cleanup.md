# Verifiable workspace cleanup

Termination, content purge, and key revocation are separate operations. A failed
workspace can keep files for recovery. Canceling it, deleting its transcript, or
deleting a checkpoint does not prove that every retained allocation is gone.

## Purge

Call `POST /v1/workspaces/{id}/purge` with scope `workspaces:purge`, a stable
`Idempotency-Key`, and `{}`. The body is limited to 1024 bytes and rejects extra
fields. The caller must own the workspace. The response is an operation with
`kind: purge`; poll `GET /v1/operations/{id}` with `workspaces:read`.

Admission commits a permanent deletion fence with the operation. New provider
admission, relay, uploads, preserve, restore, and content writes are blocked.
With filesystem checkpoints, already admitted copies finish before deletion.
The controller drains an active launch, proves provider termination, removes the
owned storage, and checks the backend inventory before marking the operation
`succeeded`.

### Purge during a checkpoint transfer

With Docker checkpoint transfers, purge does not wait for an active transfer to
reach its deadline. It cancels the source upload and every restore download of
the workspace's checkpoints, then waits for that work to stop. The canceled
preserve fails and the source is stopped. A restore that was copying from the
purged workspace can never become ready, so its destination fails with
`restore_failed`. Purging a restore destination cancels only its own download;
the source keeps its checkpoint. A restore that finished before the purge is an
independent workspace and keeps its own files.

Partial and final archives stay charged until their files are removed. If a
removal fails, the operation stays `pending` with `purge_storage_unavailable`
and the bytes stay charged. After the problem is fixed, the next scheduler pass
or a controller restart retries the same operation. Late uploads, old download
grants and restores of the purged checkpoint are rejected.

To check the flow against real Docker, run:

```sh
bun run example:e2e:docker-checkpoint-purge
```

It purges during a held upload, purges a source and then a destination during
held restore downloads, then blocks archive deletion, restarts the controller, and checks that the retry removes the files
and releases their charge.

Storage and provider errors keep the operation `pending`, with no completion
time. The controller retries it each scheduler interval and after restart. Its
reason is one of `purge_termination_unresolved`, `purge_operation_in_progress`,
`purge_storage_unavailable`, or `purge_ownership_unresolved`. The last reason
requires operator reconciliation; unknown ownership never authorizes deletion.
An unrecorded object in the storage backend blocks purge, even when its owner
cannot be identified. Reconcile those objects before claiming complete coverage.
Kubernetes workspaces that were admitted also require saved termination evidence.
A missing Job without that proof stays unresolved, including on deployments where
termination-evidence capture was not enabled. Live Kubernetes acceptance remains
a release gate.

Concurrent Kubernetes cleanup re-reads retained Job evidence after a Pod
disappears. It accepts that evidence only when the current Job UID and the
recorded proof UID match the original Job. If another finalizer already removed
the provider, the scheduler can use the proof saved on the same workspace
provider reference. A changed provider kind, ID, namespace or warm-pool identity
is rejected. Proof is saved before provider removal, and other controllers'
finalizers are preserved. Missing objects alone never authorize cleanup or
capacity release. Boundary race tests do not replace live cancellation,
controller-restart and node-loss validation.

`/readyz` reports `cleanup: pending` while a purge remains incomplete. The
`purge.pending` metric records the pending count without workspace labels.

Repeating the same key and target returns the same operation. A changed target
under that key returns `idempotency.conflict`. Different request keys create
separate verification executions, including after an earlier successful purge.

```ts
// Run in the consumer backend. Never give its machine key to a workspace.
const operation = await client.workspaces.purge(workspaceId, durableRequestId);
const result = await client.operations.get(operation.id);
if (result.state === "succeeded") {
  // This receipt covers this target at result.completed_at.
}
```

## Covered content and retained records

| Surface | Purge behavior |
| --- | --- |
| Workspace filesystem allocations | Delete every recorded allocation, including failed and partially created allocations |
| Attachments and harness conversation files | Removed with their allocation or runtime |
| Checkpoints | Delete owned final and interrupted `.creating-*` copies, then clear manifests, labels, and source provenance |
| Stored transcripts, logs, outputs, network events | Delete database content; reject or discard late writes |
| Failure tails, launch input, workspace metadata, health, source values | Clear stored values and block later content updates |
| Stored event payloads | Delete the workspace's outbox records and fence new payloads |
| Provider input files and Secrets | Remove workspace and egress inputs even when creation never saved a provider reference; retry failures |
| Runtime registration and reconnect credentials | Clear; the provider is stopped and removed |
| Workspace, storage, checkpoint, operation identifiers and ownership | Keep as tombstones for authorization, retry, lineage, and restore reconciliation |
| State history and terminal audit | Keep content-free state, timing, exit status, and byte-count records |

The fence and operation identities have no automatic expiry. Existing keys with
no issuance request ID are listed with `issuance_request_id: null`; no provenance
is invented. A purge does not remove the shared template catalog or principal.
Opaque external IDs and request IDs remain identifiers; do not put content in them.

Independent restored workspaces keep their own allocations. Consumers must list
all pages from `client.workspaces.all()`, follow `origin_workspace_id` and
`restored_from_checkpoint_id`, and purge every authorized generation recorded in
their own deletion journal. A purge never implicitly deletes a separate job.

The receipt covers managed live storage. It does not erase external backups,
controller stdout/stderr, already exported telemetry, or delivered event-sink
copies. Configure and enforce retention at those destinations before deployment.
An in-flight event delivery can still reach its sink; the sink owns that copy's
retention. Do not include secrets or payloads in operator logs. These external
retention policies remain a deployment acceptance requirement, not a claim made
by a successful live purge.

## Principal-key administration

| Public endpoint | Required scope |
| --- | --- |
| `GET /v1/principals/{principalId}/keys` | `keys:read` |
| `POST /v1/principals/{principalId}/keys` | `keys:write` |
| `DELETE /v1/principals/{principalId}/keys/{keyId}` | `keys:write` |
| `DELETE /v1/principals/{principalId}/keys` | `keys:write` |
| `POST /v1/principals/{principalId}/workspaces/{id}/purge` | `workspaces:recover` |
| `GET /v1/principals/{principalId}/operations/{id}` | `workspaces:recover` |

A delegated recovery key must name the exact target in `managed_principal_ids`.
Purge and recovery-operation routes always require that exact grant. For key
inventory and issuance, explicit owner admin also permits bounded administration;
an ordinary key issuer can only manage targets within its current grants.

With a running server and a bounded owner key in `POCKETCODER_KEY`, create a
dedicated recovery principal, then use its returned ID:

```sh
pcd principals create --name cleanup-operator \
  --scopes keys:read,keys:write,workspaces:recover \
  --templates "$TENANT_TEMPLATE" --json
pcd keys issue --principal-id "$RECOVERY_PRINCIPAL_ID" \
  --scopes keys:read,keys:write,workspaces:recover \
  --templates "$TENANT_TEMPLATE" --manage-principals "$TENANT_PRINCIPAL_ID" \
  --request-id "$OPERATOR_ISSUANCE_ID" --expires "$SHORT_EXPIRY" --json
```

Keep this expiring key in the operator backend, outside every workspace. It has
no workload creation or relay scope. Delegated issuance cannot create admin or
recovery authority. Explicit owner issuance can create those grants with a bounded
expiry. Inventory and recovery commands only need the server URL and machine key;
they do not open the data folder or read the authentication pepper.

Public issuance accepts `request_id`, nonempty `scopes`, and a future
`expires_at`. Request identity, normalized input digest, and key metadata commit
atomically. The first response is `201` with `{ key, token }`. A replay is `200`
with the same key and `token: null`. Changed inputs return `idempotency.conflict`.
The secret is never kept for replay. After a lost response, list with
`request_id`, revoke that key, and issue a replacement with a new request ID.

Inventory accepts `limit` (1–100), `cursor`, and optional `request_id`. It returns
restricted/effective scopes, delegated targets, and creation, expiry, revocation,
and last-use times. It never returns secrets or digests. `client.keys.all()` reads
every page. Inventory may change while issuance is allowed; close issuance before
claiming a final inventory. Revoke-all disables the target principal and revokes
all its keys in one transaction, serialized with both local and public issuance.
The independent operator remains able to reconcile and purge the disabled target.

## Backup replay and rollout

The controller records every purge, checkpoint deletion, conversation deletion, key revocation,
principal disable or scope narrowing, secret retirement or replacement and template retirement in
its deletion journal before the database changes. The journal lives outside the data folder and
is never part of a backup.

1. Upgrade the controller first. Startup applies known forward migrations.
2. Pin compatible reviewed CLI/controller and SDK artifacts. The workspace protocol is unchanged.
3. Restore with `pcd backup restore` into a new folder. The restored controller starts in recovery
   with only its private admin socket open, so client traffic and admission stay closed.
4. Run `pcd recovery complete`. It requires the original journal to reach the backup's position,
   repeats every journaled revocation and retirement, fails and removes the runtimes the backup
   lists as running, revokes their issuer leases, and runs every journaled purge and deletion
   again with operation keys that belong to this recovery. A historical successful receipt is
   never proof about restored physical data.
5. Completion moves the journal's writer claim to the restored folder, so the old folder cannot
   start again. Restart `pcd serve` to open service. If any step fails, recovery stays closed;
   fix the cause and run `pcd recovery complete` again.

Consumers that keep their own deletion journal can still repeat purges after service opens with
`client.recovery.purge(principalId, workspaceId, freshExecutionId)` and
`client.recovery.operation(principalId, operationId)`.

Kito K-2 owns downstream integration and hosted acceptance. Its capacity, shared
storage, external retention, and live Kubernetes failure gates remain separate
from the local controller release. Review delegated grants and those retention
policies before enabling hosted deletion.
