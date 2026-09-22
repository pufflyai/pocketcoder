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
Already admitted copies finish before deletion. The controller drains an active
launch, proves provider termination, removes the owned storage, and checks the
backend inventory before marking the operation `succeeded`.

Storage and provider errors keep the operation `pending`, with no completion
time. The controller retries it each scheduler interval and after restart. Its
reason is one of `purge_termination_unresolved`, `purge_operation_in_progress`,
`purge_storage_unavailable`, or `purge_ownership_unresolved`. The last reason
requires operator reconciliation; unknown ownership never authorizes deletion.
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

Every endpoint also requires the exact target principal ID in the calling key's
`managed_principal_ids`. There is no implicit cross-principal admin bypass.
Bootstrap that grant locally using an operator principal with `admin` authority:

```sh
pcd principals create --name cleanup-operator --scopes admin
pcd keys issue --principal cleanup-operator \
  --scopes keys:read,keys:write,workspaces:recover \
  --manage-principals "$TENANT_PRINCIPAL_ID" \
  --request-id "$OPERATOR_ISSUANCE_ID" --expires "$SHORT_EXPIRY" --json
```

Keep this expiring key in the operator backend, outside every workspace. It has
no workload creation or relay scope. Public issuance cannot create an admin key
or another delegated operator. Inventory and recovery keys do not need a database
URL or the authentication pepper. Local bootstrap commands use those controller
secrets only in the operator environment.

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

1. Upgrade the controller first and run `pcd db migrate`. This release adds one
   forward migration; it preserves existing allocations and credentials.
2. Pin compatible reviewed CLI/controller and SDK artifacts. The existing
   workspace protocol is unchanged; no new workspace credential is introduced.
3. Restore database and storage backups into an isolated environment. Keep normal
   client traffic and admission closed. Restore the independent deletion journal.
4. Disable ordinary target-principal access before starting normal service.
   Bootstrap a separate, explicitly constrained recovery operator if needed.
5. Use `client.recovery.purge(principalId, workspaceId, freshExecutionId)` for each
   journal entry. Poll `client.recovery.operation(principalId, operationId)`.
   A historical successful receipt is never proof about restored physical data.
6. Verify live content removal, reconcile authoritative keys, and call
   `client.keys.revokeAll(principalId)` as authorized. Do not reactivate tenant
   access to obtain cleanup authority. Open service only after all journals pass.

Kito K-2 owns downstream integration and hosted acceptance. Its capacity, shared
storage, external retention, and live Kubernetes failure gates remain separate
from the local controller release. Review delegated grants and those retention
policies before enabling hosted deletion.
