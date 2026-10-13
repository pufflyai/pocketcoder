# Hosted backup schedule and node recovery

Response owner: **au-re**. This is PC-103's prepared operating procedure.
The full monthly operating boundary is $200, including tax, variable charges,
recovery tests and cleanup. There is no extra trial allowance. The named trial
cell has been created. Worker customization, compatible backup storage and
the operator deployment inputs remain pending. Hosted failure acceptance remains open. See
[the concrete layout and budget](../deploy/digitalocean/production/README.md).

## Backup schedules

The runners reuse PC-93/102's account API and encrypted manager capture.
Account snapshots run at 00:00 and 12:00 UTC. Manager snapshots run at 00:45
and 12:45 UTC, after any running account backup service finishes.
Two snapshots per day leave room to detect and retry a failed capture before
the 24-hour recovery-point target. A scheduled start is not a verified backup.

The deployment generates private schedule, manager, purge and off-node configuration
under `/etc/pocketcoder-private`. Generated files use mode 0600 and their directory
uses mode 0700. They stay outside manager data, independent journal and workspace
volumes. The separate archive key remains recoverable in private operator storage.

The account runner captures ready accounts once per twelve-hour UTC window and
polls durable operations. A retry reuses its capture identity and requires a
verified receipt. It reports non-ready accounts as unavailable and does not
silently resume them. Failures remain visible to the existing alert route.

The manager backup service stops the manager and captures under its real kernel
lock. Its systemd cleanup stops the exact capture container before restarting
the manager, including after timeout or cancellation. The same maintenance lock
serializes finite key rotation. A retry verifies the saved encrypted object and
retains the last successful receipt; it does not create another archive version.

Use the [repeatable operator deployment](../deploy/digitalocean/production/DEPLOYMENT.md).
Terraform startup configuration installs the checked release and generates the
services. Each boot refreshes Kubernetes access, verifies the storage contract,
rotates finite manager keys, waits for authenticated readiness, runs account and
manager captures in order, and starts their timers. The boot service owns this
order; the timers do not start independently with stale credentials.

The private readiness ConfigMap records the exact operator Droplet ID, source
commit and archive checksum after successful initial captures. Match all three
to the deployment plan. This proves startup, not node-failure recovery or alert
delivery. No interactive SSH installation is part of the deployment.

Keep the [PC-53 scraper and receiver](monitoring.md) active. Account backup age,
journal acknowledgement, observation gaps and pending work use existing alerts.
The manager's receipt directory also feeds the manager backup failure, age
and observation-gap alerts through its existing metrics endpoint. Failed
captures preserve the last verified receipt. An attempt left started past the
twenty-minute capture limit alerts after manager restart. Confirm notification
reaches au-re before the trial, including a failed manager capture and its
successful retry. Local delivery tests do not prove this route is installed
on the host. Backup coverage is incomplete until host delivery is demonstrated.

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
