# Off-node account recovery

The manager captures one account into encrypted, versioned object storage. A restore
uses a fresh private volume and the latest independent deletion and revocation
journal. It stays private until source termination, writer transfer and controller
recovery finish. Manager database and whole-cell recovery are separate operations.

## Private configuration

Create a separate random 32-byte master encryption key and a mode 0600 JSON file on
the operator host. Keep both outside the manager data folder and every workspace.
The object storage credentials must allow object reads/writes, version listing,
multipart upload/list/abort and deletion of failed operation objects in the account
prefixes. Use a direct S3 endpoint with bucket versioning enabled. Current object
and version listings must reflect writer claims; cached or CDN listings cannot
establish the current writer. Do not infer conditional-write support from S3
compatibility.

```json
{
  "storage": {
    "endpoint": "https://YOUR_DIRECT_S3_ENDPOINT",
    "bucket": "YOUR_PRIVATE_BUCKET",
    "region": "YOUR_REGION",
    "accessKeyId": "YOUR_PRIVATE_STORAGE_ACCESS_KEY",
    "secretAccessKey": "YOUR_PRIVATE_STORAGE_SECRET",
    "forcePathStyle": true
  },
  "encryptionKeyFile": "/private/operator/off-node-master-key",
  "staging": {}
}
```

Set `POCKETCODER_MANAGER_OFF_NODE_CONFIG` to the absolute JSON path before creating
the account. The manager derives a separate account encryption key from the
master key. Its private account Secret supplies the storage configuration and
derived key to the controller only. The initializer copies them into
`/private/off-node`, outside `/private/pc_data`. They are not part of the database
archive or mounted in a workspace. Configuration and key paths are checked by
their physical location, including parent symlinks. An archive encryption key
cannot equal any archived controller key.

Keep the master key and private configuration available independently of the
controller volume. AES-256-GCM authenticates each object against its account and
object name. Backup receipts retain the exact object version, digest and snapshot
identity. A mismatched account, version, writer or digest leaves recovery closed.

The controller receives network access only to the configured storage endpoint's
resolved addresses and port. Workspace policies receive no storage access. If the
endpoint changes addresses, refresh the account policy through the manager before
retrying; an unresolved or unreachable endpoint remains pending.

## Capture and restore

Use the existing finite manager operator token, which expires within 24 hours.
Both operations use an `Idempotency-Key` and return 202 with one durable operation.
Poll `GET /v1/operations/{id}` until `succeeded`. Another account operation is
refused while one is pending. Capture requires a ready account; restore requires
a completed backup and a suspended account.

```sh
curl -X POST -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H 'Idempotency-Key: account-backup-one' \
  "http://127.0.0.1:8092/v1/accounts/$ACCOUNT_ID/backups"
# Poll the operation, then retain its backup ID from the account inventory.
curl -H "Authorization: Bearer $OPERATOR_TOKEN" \
  "http://127.0.0.1:8092/v1/accounts/$ACCOUNT_ID/backups"
curl -X POST -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H 'Idempotency-Key: before-restore' \
  "http://127.0.0.1:8092/v1/accounts/$ACCOUNT_ID/suspend"
# Poll suspension until succeeded before admitting restore.
curl -X POST -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: account-restore-one' \
  -d '{"backup_id":"YOUR_COMPLETED_BACKUP_UUID"}' \
  "http://127.0.0.1:8092/v1/accounts/$ACCOUNT_ID/restore"
```

Capture uses the existing bounded maintenance barrier. It encrypts the verified
archive before upload and records its receipt only after the current journal is
acknowledged off-node. An object store outage keeps deletion and revocation
enforced locally and prevents successful receipts or status responses. Workers
wait for that acknowledgement outside database transactions. Repeating an already
revoked key request still flushes pending journal records.

Receipts retain only runtime identities, without delegated workspace input. An
unsettled provider launch cannot enter a new archive. Suspension saves proof for
each retained backup from that source writer, including runtimes that finished
after capture. Recovery matches the exact archived Job UID or prepared Secret
receipt before applying that proof. A missing Job alone is not termination proof.

Private receipt, restore intent and capacity files have a 65,536-byte limit. Capture
checks the known receipt envelope before upload. If object completion metadata
exceeds the limit, it removes that operation's remote upload before releasing its
local temporary files and reservation. Failed remote cleanup retains ownership
for retry. Restore checks its metadata envelopes before publishing target data.

Capture and fresh restore admit staging against actual free bytes and file entries
on their private filesystem. They keep 64 MiB and 16 file entries free. The optional
`staging.maxBytes` and `staging.maxFiles` positive integer limits can tighten that
budget. The admitted budget includes simultaneous plaintext, ciphertext,
verification and extracted copies, plus bounded database recovery writes. Backup
uses the existing durable storage reservation. An interrupted operation retains
its reservation until its owned temporary files have been removed; expiry alone
does not release it. Verification uses the accounted private staging folder.

Suspension fences admission, settles accepted launches, preserves supported
workspaces, cancels others and revokes their leases. For configured accounts the
manager retains matching active, warm and controller container exit evidence
before removing the controller. Pod absence on an unreachable node does not prove
termination. Uncertain cleanup leaves the same operation pending.

Restore retains the original PVC and its identity, allocates a distinct 10 GiB
PVC and runs an operation-owned restore Job. Its result, placement and container
exit proof are saved before Job removal. The private recovery controller must
match that exact restored writer identity before it can claim the current remote
journal generation. It replays later deletion and revocation records and performs
the existing recovery checks before admission opens. A stable operation annotation
causes one controller restart; retries reuse the same operation and completed
effects. Account volume and recovery phase advance in one database transaction.

Checkpoint publication keeps each copied archive's inode. Under the fresh writer
lock, restore verifies its content and original custody fields before recording
the final change time caused by hard-link publication. A replacement inode remains
an error, even if its bytes are identical. Later journal deletion must remove the
restored bytes before recovery can finish.

The account quota permits the original and one fresh volume, with 20 GiB total
requested storage. Old volumes and backup object versions remain in durable
inventory for the separate account purge workflow. A further restore remains
pending if both volume slots are occupied. Do not remove the original volume to
work around that limit without provider deletion proof.

The CLI provides `backup create-off-node --dir ... --operation-id YOUR_UUID` for
the private controller capture route. `backup restore-off-node RECEIPT --dir ...
--journal-dir ... --checkpoint-dir ... --off-node-config ... --operation-id
YOUR_UUID` is the restore Job's private command. Its target folders must be fresh.
The caller must already have retained source compute-death proof. Restore publishes
recovery-only data; it does not independently authorize source writer transfer or
open traffic. Keep the configuration and receipt on the private operator path.

## Local proof and hosted limits

Run `bun run example:e2e:managed-off-node` with Docker, Kind and kubectl installed.
It owns and removes its Kind cluster, RustFS fixture and candidate controller
image. A supplied `POCKETCODER_E2E_WORKSPACE_IMAGE` is loaded into that cluster and
retained on the host. The example uses finite local manager and owner authority.
Its local controller fixture bundles the current source on the host with the
product build flags, then uses the same runtime recipe and tools. The log records
source, bundle and runtime hashes. This is local fixture evidence; the product
Dockerfile and published image checks remain separate.

Local RustFS and Kind checks exercise versioned storage, fresh-volume recovery,
later deletion/revocation, saved bytes and retry identity. They do not prove
DigitalOcean Spaces listing behavior, hosted block-volume placement, gVisor,
DNS/HTTPS or customer access. Hosted deployment still needs its separate resource,
cost and finite write-access approval. Current cloud access is read-only.
