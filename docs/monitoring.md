# Hosted health alerts

The manager serves authenticated Prometheus metrics at `GET /metrics`.
It samples account controllers through their private admin sockets and reads cell Nodes and Pods.
No public controller route exposes health inventory.
The default sample interval is 15 seconds. Up to four accounts are sampled at once.
An alert condition must remain true for two minutes before notification.
The owned demo uses shorter thresholds and no hold time to prove the same rules quickly.
Each Kubernetes monitoring command has an eight-second process limit.
A failed sample is a gap. An old sample has an explicit age.

Metrics contain counts, ages, disk bytes, health flags, and opaque account IDs.
They exclude account names, workspace IDs, template names, paths, conversations, credentials, and backup object identities.
Keep metrics on the operator network. They still reveal service usage and account IDs.

## Scraping and delivery

The initial response operator is **au-re**. Set the actual receiving operator in each installation.
The webhook receiver must deliver to that person or their agreed on-call route.
The local demo delivers only to its owned localhost receiver; it does not contact a production operator.

Stop the manager briefly to release its database lock. Keep its usual private configuration environment.
Run its built entry point with `metrics-operator` and an explicit ISO expiry, at most 24 hours away:

```sh
umask 077
bun packages/manager/dist/index.js metrics-operator 2026-10-13T08:00:00Z > /secure/operator/issued-key.json
```

Choose a current expiry when running this command. Restart the manager after issuance.
Account controllers keep running while the manager is stopped.
Extract only the returned `token` into a private credentials file, then remove the issuance file.
The key can only read `/metrics`. It cannot list accounts or change them.
Store both files outside account and workspace volumes. Use mode 0600 and the scraper's system user.
Never put the key in a repository, command line, workspace environment, or example config.

Create an operator-owned input file. It contains file paths and routing settings, not the key:

```json
{
  "managerTarget": "127.0.0.1:8092",
  "credentialsFile": "/secure/operator/metrics-token",
  "alertmanagerTarget": "127.0.0.1:9093",
  "receiverUrl": "https://alerts.example.org/pocketcoder",
  "operator": "au-re",
  "runbookUrl": "https://github.com/pufflyai/pocketcoder/blob/feature/pocketcoder-1-0/docs/monitoring.md"
}
```

Run `bun deploy/monitoring/write-config.ts input.json /secure/operator/monitoring`.
Mount its three JSON files at `/etc/pocketcoder` in the existing monitoring services.
JSON is accepted by their YAML configuration readers.
Use `prometheus.json` and `alertmanager.json` as the services' configuration files.
The digest-pinned images in `deploy/monitoring/config.ts` are Prometheus 3.15.0 and Alertmanager 0.34.1.
Run `promtool check config` and `amtool check-config` against the mounted files before starting services.
The manager needs read access to Nodes and Pods across its cell, and its existing private controller exec access.
The scraper gets only the metrics key. It never gets Kubernetes authority.

Verify `up{job="pocketcoder-manager"} == 1`, fresh account observations, and real webhook delivery.
Keep the manager HTTP listener on the same private operator network as the scraper.
If they run in different networks, secure the transport through the installation's private network or TLS proxy.
The generated scrape target uses HTTP for that private listener.

## Credential

The expiry alert starts one hour before the metrics key expires.
Issue another finite metrics-only key before expiry.
Write it to a new mode-0600 file, then atomically rename it over the credentials file.
Prometheus reads that file for each scrape. Verify the next scrape and the new expiry metric.
An expired key returns 401 and fires the observation-gap alert.
Do not extend key lifetime or use a full operator key to avoid rotation.

## Disk

The default alert is less than 15% available space or less than 1 GiB.
Account data comes from `statfs` on the private data volume; runtime disk comes from the controller root filesystem.
Manager disk comes from its data filesystem. These are physical filesystem headroom readings.
Pause new work. Inspect the affected filesystem. Remove only confirmed unused data or grow the volume.
Do not remove journals, recovery records, retained checkpoints, or backup receipts to clear an alert.

## Queue

Queued work older than two minutes alerts.
Check account work and runtime capacity. Cancel abandoned requests or add approved capacity.
Confirm the queue drains and a new workspace becomes ready.

## Heartbeat

A missing connection or heartbeat older than one minute alerts for active workspaces.
Idle workspaces still send heartbeats. User activity is not used as a heartbeat timestamp.
Check supervisor Pods and the control channel. Restore connectivity before restarting work.
Warm Pod requests contribute to cell capacity; heartbeat lag measures assigned workspaces.

## Cleanup

Pending cleanup or a manager operation older than five minutes alerts.
Cleanup counts include termination, preservation, deletion, revoking leases, warm drains, and staged transfer cleanup.
These count pending items, so one workspace may contribute more than one item.
Check the durable operation and its provider or storage error. Restore access and let the same operation retry.
Confirm provider objects are gone and the pending count clears. Never erase the intent to hide a failure.

## Backup

An account configured for off-node backups alerts when it has no receipt or its newest recovery point is older than one day.
Age uses the verified receipt's snapshot time, including delayed receipt acceptance.
Run a backup with a new request ID. Verify its saved receipt and off-node object version.
The rule does not schedule backups. Operators must arrange the account backup schedule.
Manager disaster-recovery backups remain governed by the manager recovery runbook.

## Journal

A configured journal without an acknowledged cursor, or pending journal work older than one minute, alerts.
An idle journal with no pending work does not alert just because its last acknowledgement is old.
Restore off-node storage access. Retry failed actions or run a verified backup for each affected account to acknowledge its current cursor.
Check that revoked keys remain revoked and deleted data stays deleted.

## Observation

Failed scraping, missing expected controllers, failed controller readiness, failed cell reads, or samples older than two minutes alert.
Check manager health, finite key expiry, Kubernetes read access, and private controller access.
A failed manager database or independent purge-authority read also fails scraping. Restore that source; do not bypass its purge fence.
Restore scraping and verify fresh observations for all ready accounts.
Suspended accounts do not require a running controller, but their backup age is still checked.

## Capacity

Unavailable Nodes, DiskPressure, zero usable storage capacity, less than 15% unrequested storage, or excess unplaced requests alert.
Cell storage is **requested scheduling capacity**, not measured free bytes on every node.
It includes all unfinished Pods, including warm Pods and deleting Pods, plus init sidecars and Pod overhead.
Physical controller volumes are measured separately. Idle-node physical disk pressure is covered by Kubernetes DiskPressure.
Check node readiness and requests. Pause new work and restore or add approved capacity.
Production node sizing and failure recovery belong to PC-103.

## Reproduce

Run `bun run example:e2e:managed-monitoring` with Docker, kind, and kubectl available.
The demo owns its Kind cluster, RustFS bucket, Prometheus, Alertmanager, and localhost receiver.
It uses finite host-only keys and validates both monitoring configurations with the real binaries.
It applies bounded disk pressure, real scheduler pressure, a stopped supervisor, denied provider deletion,
an unavailable controller, unavailable cell capacity, stale backups, and failed off-node journal writes.
The owned proxy forwards real signed storage requests and returns 503 for writes during the journal fault.
Reads remain available so the fault reaches the enforced mutation and its pending journal acknowledgement.
The heartbeat fault keeps the production 60-second threshold; its deliberate stopped interval must exceed it.
Each fault records its notification boundary and checks the full labels of the firing alert and its recovery.
An earlier account alert cannot count as delivery for a later scrape or credential fault.
Each alert must fire, reach the named receiver with response instructions, and resolve after its operator action.
The demo checks that a missing controller does not block its healthy peer.
It records local validation, not hosted pilot acceptance.

## Response commands

Use the account ID from the alert to look up its namespace with a finite full operator key.
Keep curl's bearer header in a private mode-0600 file outside all account and workspace volumes.
The metrics-only key cannot run these administration requests.

```sh
curl --config /secure/operator/http.conf http://127.0.0.1:8092/v1/accounts/<account-id>
kubectl -n <account-namespace> get pods
kubectl -n <account-namespace> get events --field-selector type=Warning
kubectl -n <account-namespace> exec deployment/controller -c controller -- df -Pk /private /
kubectl get nodes
kubectl describe node <affected-node>
curl --config /secure/operator/http.conf http://127.0.0.1:8092/v1/operations/<saved-operation-id>
curl --config /secure/operator/http.conf --request POST --header 'idempotency-key: <new-request-id>' http://127.0.0.1:8092/v1/accounts/<account-id>/backups
curl --config /secure/operator/http.conf http://127.0.0.1:8092/v1/accounts/<account-id>/backups
```

Read the response before taking a destructive action. Save accepted operation IDs for retries and investigation.

Configuration references: [Prometheus](https://prometheus.io/docs/prometheus/latest/configuration/),
[Alertmanager](https://prometheus.io/docs/alerting/latest/configuration/),
and [Kubernetes init sidecar resource requests](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/#resource-sharing-within-containers).
