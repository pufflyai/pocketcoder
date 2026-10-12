# Manager backup and recovery

A manager backup contains its own PGlite database, schema, seed identity, finite
operator digests, account inventory and operation IDs. It contains no account
transcript or plaintext operator or owner key. AES-256-GCM encrypts the archive
with a separate 32-byte key held outside the manager data folder and journal.
The receipt names the exact object version and both archive checksums.

Use the existing private `POCKETCODER_MANAGER_PURGE_CONFIG` and
`POCKETCODER_MANAGER_OFF_NODE_CONFIG`. Their object storage settings must match.
The backup configuration's `encryptionKeyFile` and `staging` settings also apply
to manager backups. Keep the key, configuration, receipt and purge authority
outside every workspace. Storage requires version listing and conditional writes.

## Capture

Stop the manager before capture. Account controllers keep running. The capture
command holds the manager's kernel writer lock, checks its independent purge
journal and copies the database under the engine's query barrier. It verifies the
archive, uploads it, then downloads and decrypts the exact version before returning
a receipt. The archive names the manager app, engine, schema and seed; controller
backups are rejected. Reads never return the encryption key.

```sh
export POCKETCODER_MANAGER_DIR=/private/operator/manager_data
export POCKETCODER_MANAGER_PURGE_CONFIG=/private/operator/purge.json
export POCKETCODER_MANAGER_OFF_NODE_CONFIG=/private/operator/off-node.json
bun run manager:start backup /private/operator/manager-receipt.json "$BACKUP_UUID"
```

Use one UUID for each backup. An exact retry returns its saved verified receipt.
A failed upload stays owned by that UUID; a retry cleans only its object prefix
and temporary files. Staging checks free bytes and file entries and keeps 64 MiB
and 16 entries free. Optional staging limits tighten these bounds. Start the
original manager again after capture.

## Restore and replay

Stop the source manager. Keep its original data folder and the independent purge
authority available. Choose a fresh target and one new UUID for the restore.

```sh
export POCKETCODER_MANAGER_DIR=/private/operator/restored-manager
bun run manager:start restore /private/operator/manager-receipt.json "$RESTORE_UUID"
bun run manager:start recover /private/operator/manager-receipt.json "$RESTORE_UUID"
bun run manager:start
```

Restore verifies the encrypted version, file graph, member checksums, schema and
account/operation inventory before publishing the database. A durable recovery
marker keeps the listener and all provisioning closed. Retry `restore` after an
interrupted download or publication, then retry `recover` with the same receipt
and UUID. Completion refuses an incomplete restore; it never creates an empty
manager in place of missing restored data. A changed receipt or UUID is refused.

The purge journal stays outside the database and every archive. Its private chain
and permanent versioned records cover the backup cursor. Missing, deleted or
conflicting evidence keeps recovery closed. Replay removes purged account rows
and their related metadata before any reconciliation. The original create request
is permanently refused, including when the backup predates the purge.

Completion holds the source installation's original kernel lock before moving
its remote writer claim. A running or replaced source refuses the transfer. The
old manager folder is retired. The database also records its journal identity;
removing a marker or copying only the database cannot authorize another writer.
Surviving controllers and volumes keep their IDs. Pending account operations reuse
their original IDs and provider checks. Operator tokens keep their original expiry;
recovery does not extend them or return their plaintext. Issue a new finite token
locally if the old token has expired.

This flow restores one manager database while keeping its original installation
and independent authority reachable. Whole-node loss and off-node journal/writer
recovery belong to the separate hosted failover flow. It does not enable customers,
change account recovery, or prove DigitalOcean storage and gVisor behavior.

## Local proof

```sh
bun build packages/supervisor/src/index.ts --target bun --outdir deploy/image/dist
docker build -t pocketcoder-workspace:manager-recovery deploy/image
POCKETCODER_E2E_WORKSPACE_IMAGE=pocketcoder-workspace:manager-recovery \
  bun run example:e2e:manager-recovery
PC102_S3_TEST=1 PC94_S3_TEST=1 bun test packages/manager/src/recovery packages/manager/src/purge
```

The demo owns a Kind cluster and versioned RustFS store. It creates two actual
accounts, captures the manager, purges one account and its physical volume, restores
the older manager snapshot, and checks that the deleted namespace stays absent.
The surviving deployment and volume retain their exact UIDs through recovery and
manager restart. The demo removes its cluster, temporary data and fixture images;
the supplied workspace image stays on the host.
