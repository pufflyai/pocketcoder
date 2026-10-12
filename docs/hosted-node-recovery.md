# Hosted backup schedule and node recovery

Response owner: **au-re**. This is PC-103's prepared operating procedure.
The production layout and named disposable trial need their saved cost approval
before apply. Hosted failure acceptance remains open. See
[the concrete layout and budget](../deploy/digitalocean/production/README.md).

## Backup schedules

The runners reuse PC-93/102's account API and encrypted manager capture.
Account snapshots run at 00:00 and 12:00 UTC. Manager snapshots run at 00:45
and 12:45 UTC, after any running account backup service finishes.
Two snapshots per day leave room to detect and retry a failed capture before
the 24-hour recovery-point target. A scheduled start is not a verified backup.

Create `/etc/pocketcoder-private/account-backups.json`, mode 0600, owned by
`pocketcoder-operator`. Its token file is also mode 0600:

```json
{
  "managerUrl": "http://127.0.0.1:8092",
  "tokenFile": "/etc/pocketcoder-private/schedule-operator-token"
}
```

Use a finite full manager operator key, with the existing maximum 24-hour
expiry. A metrics-only key is refused. Rotate before expiry; never extend the
lifetime to make scheduling unattended. Keep all operator paths outside
account and workspace volumes.

The account runner requests one capture per ready account per twelve-hour UTC
window and polls its durable operation. It requires a saved receipt for a
successful operation. Retrying within the window reuses the operation, including
after a manager restart. All ready accounts are admitted before polling starts,
using one shared fifteen-minute polling deadline. A failed account does not
prevent attempts for its healthy peers; the cycle fails if any capture fails
or times out.
Non-ready accounts are reported as unavailable without changing their state.
For a suspended account, verify its last backup covers its last data changes;
never silently resume it to make the schedule green.

Create `/etc/pocketcoder-private/manager.env`, mode 0600, with paths only:

```ini
POCKETCODER_MANAGER_DIR=/mnt/pc103-manager/manager_data
POCKETCODER_MANAGER_PURGE_CONFIG=/etc/pocketcoder-private/purge.json
POCKETCODER_MANAGER_OFF_NODE_CONFIG=/etc/pocketcoder-private/off-node.json
POCKETCODER_MANAGER_BACKUP_RECEIPTS=/mnt/pc103-journal/backup-receipts
```

The receipt directory's parent must exist. The manager and backup runner use
the same private configuration and user. The backup service stops
`pocketcoder-manager.service`, captures under the real kernel lock, and starts
the manager through `ExecStopPost`, including after capture failure.
Account controllers remain running. A persistent request file keeps one manager
capture identity per UTC window. A retry downloads and verifies its saved
encrypted object; it does not create another archive version.
The capture runs as the operator user in the backup unit's own process group.
Only service stop/start commands run as root. Timeout or explicit stop ends
the capture group before the manager is started again.

Install the four units from `deploy/recovery` in `/etc/systemd/system` on the
operator host. Install the checked-out candidate in `/opt/pocketcoder` and Bun
at `/usr/local/bin/bun`. The manager service must already be configured.
Validate all units with that host's `systemd-analyze verify` before enabling.
Terraform and local tests do not enable them.

```sh
systemctl daemon-reload
systemctl start pocketcoder-account-backups.service
systemctl start pocketcoder-manager-backup.service
systemctl enable --now pocketcoder-account-backups.timer pocketcoder-manager-backup.timer
systemctl list-timers 'pocketcoder-*'
journalctl -u pocketcoder-account-backups.service -u pocketcoder-manager-backup.service
```

Keep the [PC-53 scraper and receiver](monitoring.md) active. Account backup age,
journal acknowledgement, observation gaps and pending work use existing alerts.
Confirm notification reaches au-re before the trial. Manager timer failure and
receipt age still need actual alert wiring on the host; PC-53's account backup
rule does not monitor them. Backup coverage is incomplete until that route
is demonstrated too.

## Close admission and establish fencing

Use only PC-103's named disposable resources and synthetic accounts.
Never run a failure on Kito staging. Before the fault, retain cluster ID, Node
UID, provider Droplet ID, Pod/container identities, PVC/PV UIDs, CSI handles,
encrypted receipts and snapshot times. Save UTC failure/recovery timestamps.
Keep evidence content-free and credentials outside the record.

Close public ingress and stop the manager's admission listener before any
relocation. Account controllers have their own admission; close their traffic
and keep uncertain recovery controllers private. Pod absence, NotReady,
a successful detach request or RWO storage alone do not prove source death.

Record the provider's completed power-off action and verify the exact source
Droplet is still off before releasing Pods or attachments. Prevent restart until
the new writer is established. Match the Node's provider ID to the saved source.
If fencing cannot be proved, leave admission closed and retry the same operation.
Never erase termination evidence.

[Kubernetes non-graceful shutdown](https://kubernetes.io/docs/concepts/cluster-administration/node-shutdown/)
requires a verified shut-down node before its out-of-service taint. Only after
that proof exists, the operator may run:

```sh
kubectl --kubeconfig /private/operator/finite-kubeconfig \
  taint node <verified-powered-off-node> node.kubernetes.io/out-of-service=nodeshutdown:NoExecute
```

Retain the original volume handle and inspect provider attachment state before
relocation. [DigitalOcean detachment instructions](https://docs.digitalocean.com/products/volumes/how-to/delete-detach/)
also require the old writer to stop. Never force-delete the PVC, wipe `LOCK`,
alter `MANAGER.json`, or manufacture container-exit proof.

## Account/controller recovery

For a surviving volume, retain its original PVC and writer identities.
Prove the failed provider node is off and the old attachment is released before
placing one controller on the surviving system worker. Validate its private
writer/journal checks, later revocations and deletions, and readiness before
opening traffic. Restore a saved checkpoint and verify exact bytes. Launch
a fresh workspace on a live gVisor worker and complete an agent turn.
Record an attempted second writer being refused and the source staying fenced.

For an encrypted fresh-volume restore, use
[account recovery](off-node-account-recovery.md). It requires completed
suspension with retained compute-death proof. Current APIs do not turn missing
containers on a dead node into that proof. Until provider-backed failure transfer
is implemented and validated, abrupt-failure fresh restore remains closed.
Never bypass suspension or rewrite database state.

If current deletion/revocation evidence cannot be read, recovery stays private.
Restore object storage access and replay the current independent journal;
an older backup cursor does not authorize admission.

## Manager recovery

Keep manager data, independent purge authority and archive key separate.
Stop or provider-fence the original manager before starting a replacement.
Use [encrypted manager restore and replay](manager-recovery.md) with a fresh
target, saved receipt and one restore UUID. Surviving account deployment/PVC
IDs must remain unchanged. A later purged account and its old create request
must remain absent/refused after restore.

Current manager recovery acquires the source folder's kernel lock and checks
its device/inode. Relocation can change the device number. Missing source or
changed identity refuses transfer. This is an unresolved PC-103 implementation
requirement, not permission to rewrite the claim. Preserve independent authority
and remote records while that check is closed. Operator keys retain their expiry;
issue a new finite key locally if needed. Never extend a saved token's expiry.

## Measurements and completion

RPO is the interval from the fault to the latest verified snapshot used for
recovery. RTO is the interval from the fault to a working authenticated account
and completed workspace turn, including manager restore and replay.
Use snapshot time, not upload time. Require RPO <=24 hours and RTO <=60 minutes.
No hosted measurement is recorded yet.

Final evidence must include failed provider identity, fence acknowledgement,
original/new attachments, refused second writer, current journal/deletion replay,
working workspace, alert delivery/recovery, and UTC measurements.
Keep the source stopped until the proof finishes. Remove only named fixture
resources and verify their volumes, object versions and DNS records are gone
before revoking finite trial credentials.

## Local schedule proof

```sh
PC103_S3_TEST=1 bun test deploy/recovery
bun run example:e2e:managed-scheduled-backups
```

Tests use real manager HTTP/database state and versioned RustFS storage.
The demo owns its Kind cluster/store, captures an account and manager, retries
both schedules, and verifies unchanged inventory after restart. This proves
encrypted scheduling and retries. It does not prove a powered-off DigitalOcean
node, CSI relocation, systemd installation, gVisor or hosted RPO/RTO.
