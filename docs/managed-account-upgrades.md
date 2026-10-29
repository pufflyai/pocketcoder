# Upgrade a managed account

The manager upgrades one account through a saved operation. Other accounts keep
their controllers and workspaces. A failed upgrade keeps admission closed to new
mutations. The manager retries the recorded phase after restart.

## Approve a release manifest

Set `POCKETCODER_MANAGER_RELEASE_MANIFEST` to a file outside account workspaces.
It has `format: "pocketcoder-releases/v1"` and a `releases` array. Each entry binds
a version to a digest-pinned image, engine versions, full migration names and
hashes, agent protocol and a link to its test evidence.

Produce an entry from the exact source used to build the image:

```sh
bun run candidate:controller-manifest 0.9.0-rc.2 \
  ghcr.io/YOUR_TEAM/controller@sha256:YOUR_IMAGE_DIGEST \
  https://YOUR_TEST_EVIDENCE 0.9.0-rc.1 > candidate-release.json
```

Combine the approved source and target entries into the manifest. `upgradesFrom`
lists source versions tested against that image. A fifth argument lists
`rollbackTo` versions. Add these only after testing the old image against data
written by the new image. Comma-separated arguments allow several versions.
Generating a file does not approve its evidence; the operator owns this allowlist.

The current path requires the same PostgreSQL/PGlite versions and agent protocol,
and an unchanged prefix of migration history. Appended migrations are supported.
Engine changes need a separately tested migration path. The controller reports
its compiled format through its private socket. A mismatch leaves admission
closed. `GET /v1/releases` lists configured entries.

## Upgrade

Use the manager's finite operator token from the operator host:

```sh
curl -X POST -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: upgrade-one' \
  --data '{"version":"0.9.0-rc.2"}' \
  "http://127.0.0.1:8092/v1/accounts/$ACCOUNT_ID/upgrade"
```

Poll `GET /v1/operations/{id}` until `state` is `succeeded`. Repeating the key and
version returns the same operation, even if the manifest changes. A different
version with that key is refused. The account must be ready and have off-node
backups configured. Another lifecycle operation cannot start meanwhile.

Admission also needs one free PVC slot for a fresh-volume restore. The existing
account quota allows two PVCs. If a previous recovery retained its old volume,
the manager returns `upgrade_recovery_capacity` before creating an operation or
changing the account. It never deletes a retained recovery copy automatically.

An operator can retire the inactive recovery volume after verifying the restored
account and a fresh encrypted backup. Match the old claim's name and UID to the
saved recovery operation's source-volume and controller-exit evidence. Confirm
that no pod or workload can mount it, and that it differs from the current account
volume. Use the provider's deletion procedure with that exact UID; confirm both
the claim and backing volume are removed. A retained backing volume needs physical
deletion too. Keep the independent journals and approved backup copies. Then
retry the upgrade. If any identity or exit evidence is missing, keep the volume
and do not upgrade; never increase the quota just to bypass this check.

The operation suspends the account, preserves supported active workspaces,
revokes workspace leases and drains runtimes. It captures and verifies an
encrypted off-node backup while admission stays fenced. It retains controller
exit evidence before changing either controller image. The new controller opens
the existing volume, applies migrations and writes its coordinator lease. The
manager checks its format and reconciles data, leases and checkpoints before
resuming admission. Existing owner expiry dates stay unchanged.

After success, restore a saved checkpoint and run a workspace through the existing
APIs. The manager records the selected release and recovery mode in the operation.
It does not automatically restart old workspaces.

## Recover a failed upgrade

`upgrade_retry` keeps the saved phase and admission fence. Restore any failed
dependency and let the same operation retry. To replace a failed image during
`install` or `verify`, use the recovery endpoint:

```sh
curl -X POST -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"operation_id":"YOUR_OPERATION_UUID","action":"forward_fix","version":"0.9.0-rc.3"}' \
  "http://127.0.0.1:8092/v1/accounts/$ACCOUNT_ID/upgrade-recovery"
```

Choose one action:

- `rollback`: replace the image only if the saved target lists the source in
  `rollbackTo` and both have the same engine, migration history and agent protocol.
  This preserves new-version writes. A health failure alone is not proof of
  compatible data.
- `forward_fix`: use an approved release whose `upgradesFrom` includes the failed
  target. It keeps the existing data and extends its known schema.
- `restore`: recover the verified pre-upgrade backup into a fresh volume using
  the source image. It gives up writes after that snapshot. Current independent
  deletion and revocation journals replay before admission, so old data cannot
  revive deleted content or revoked keys.

Each action retains the replacement controller's exit evidence. It uses the same
operation and backup. The restore recovery point is the backup's `createdAt` and
journal cursor, visible in `GET /v1/accounts/{id}/backups`. Keep the original volume
and journals until recovery is verified. Account purge removes retained volumes
and backup versions through the existing purge flow.

An error after admission opens retries `open`. It does not restore automatically.
A later problem after a completed upgrade needs a new tested upgrade from the
installed release. Do not change images or migration files by hand.

## Local proof

```sh
bun build packages/supervisor/src/index.ts --target bun --outdir deploy/image/dist
docker build -t pocketcoder-workspace:pc92-upgrade deploy/image
POCKETCODER_E2E_WORKSPACE_IMAGE=pocketcoder-workspace:pc92-upgrade \
  bun run example:e2e:managed-upgrade
```

The demo owns its Kind cluster and RustFS store. It generates a fixture migration
with Drizzle, builds distinct pinned images and pauses real controllers after
migration and after a durable application write. It checks compatible rollback,
forward fix, fresh-volume restore with later key revocation, operation identity
after manager restart, one backup version, exact saved files and a new agent turn.
These releases are synthetic test artifacts. They do not approve a DigitalOcean
upgrade or a production release.
