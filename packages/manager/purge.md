# Account purge

Purge permanently closes an account. It fences its original create request,
revokes controller keys and workspace leases, drains active and warm compute,
and verifies physical storage removal before reporting success. Keep the
manager listener private. Use the existing finite operator token and finite
host-side Kubernetes authority; never place either in a workspace.

Set `POCKETCODER_MANAGER_PURGE_CONFIG` to a mode 0600 JSON file outside
`manager_data` and every workspace:

```json
{
  "directory": "/private/operator/purge-authority",
  "storage": {
    "endpoint": "https://YOUR_REGION.digitaloceanspaces.com",
    "region": "YOUR_REGION",
    "bucket": "YOUR_PRIVATE_VERSIONED_BUCKET",
    "accessKeyId": "YOUR_PRIVATE_MANAGER_KEY",
    "secretAccessKey": "YOUR_PRIVATE_MANAGER_SECRET"
  },
  "physical": {
    "provider": "digitalocean",
    "credentialFile": "/private/operator/finite-volume-credential.json"
  }
}
```

The provider credential file is also mode 0600 and outside manager data:

```json
{"token":"YOUR_FINITE_PROVIDER_TOKEN","expiresAt":"YOUR_FUTURE_ISO_EXPIRY"}
```

The adapter checks expiry before and after every provider request. Grant only
the volume and volume-snapshot access needed for inventory and deletion. The
manager does not infer provider deletion from Namespace, PVC or PV absence.
Missing provider configuration, expired access, uncertain inventory or provider
outage leaves a started account purge pending.

Object storage must support version listings, multipart inventory, conditional
immutable creation and exact-version reads. Use the direct private origin, not
a cached endpoint. The authority directory holds a single writer lock and
fsynced local intents. Permanent remote indexes and receipts live under
`manager/purge/`, outside removable `accounts/<UUID>/` data. Preserve both the
authority directory and remote indexes across manager backup restoration.
Never remove them to clear a pending purge.

Backup-enabled accounts use their existing private off-node configuration.
Its storage configuration must exactly match purge storage; startup rejects a
mismatch. Backup-disabled managed controllers receive a separate private
purge configuration under `/private/purge`, outside `pc_data`. Only the private
controller init container mounts its Secret. No workspace receives these
credentials or the backup outer encryption key.

```sh
curl -X POST -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H 'Idempotency-Key: purge-account-one' \
  "http://127.0.0.1:8092/v1/accounts/$ACCOUNT_ID/purge"
# Poll the operation ID returned above.
curl -H "Authorization: Bearer $OPERATOR_TOKEN" \
  "http://127.0.0.1:8092/v1/operations/$OPERATION_ID"
```

Admission returns 202 with an irreversible intent. Repeating the same purge
key returns the same operation; another key conflicts. Creation, owner
bootstrap, lifecycle changes, backup and restore are refused after the fence.
Original create-request aliases remain fenced after an older manager database
is loaded. Completed replay erases restored account, plan, bootstrap, operation,
backup-catalog and usage rows before reporting success again. Permanent receipts
retain opaque IDs, request hashes, timestamps and physical proof; they do not
retain account names, plans, tokens or customer content.

The manager first settles admitted work, then retains exact controller/runtime
and node identities. It acknowledges actual exits before releasing finalizers.
It retains physical volume handles before Kubernetes removal, verifies provider
volumes and associated snapshots are absent, then removes account-owned node
RBAC and Namespace resources by UID. It removes all account object versions,
delete markers and multipart uploads. Shared deployment DNS and certificates
are retained; this manager does not create per-account public DNS or certificate
resources. Account authority keeps shared routing closed after purge.

If a node is offline or storage deletion cannot be verified, keep the same
operation pending. Restore the same node or provider access and let the manager
retry. Restarting the manager does not discard retained ownership or exit proof.
Do not force-delete finalizers, substitute a replacement node or delete unknown
resources. Older accounts lacking positive admission or exact historical
placement evidence stay pending rather than assuming compute died.

Local validation uses an isolated Kind cluster and private versioned object
storage. `bun run example:e2e:managed-account-purge` checks an actual active
runtime, encrypted backup, retained PVC bytes, node outage and manager restart,
blocked physical deletion and retry, then stale-database replay. Its Kind
storage adapter is fixture-only. It does not prove DigitalOcean block-volume
deletion, hosted DNS/HTTPS or customer enablement; those need separate approved
provider acceptance.
