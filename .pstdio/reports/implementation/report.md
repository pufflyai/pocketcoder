---
report_name: "implementation"
kind: "validation"
created: "2026-07-30T11:34:30.592Z"
draft: false
---

# PC-1 Persistent, Reconnectable Workspaces

## Confidence Score

4/5

## Summary

PC-1 is implemented end to end for host-local Docker deployments and the
portable Kubernetes Job/PVC topology. Persistence is opt-in and
template-controlled. A live workspace can be reattached, a stopped execution
can be preserved into an immutable verified checkpoint, and every restore
creates a fresh execution with independent writable storage and audit lineage.

The implementation adds:

- durable storage, checkpoint, operation, source, output, and restore-lineage
  contracts in the in-memory and PostgreSQL stores;
- reviewed persistence/source/secret/setup/output template declarations;
- separate runtime and storage driver contracts;
- host-filesystem and Kubernetes PVC storage backends;
- Docker and Kubernetes Job runtime projection;
- filesystem-safe snapshots with quotas, manifests, hashes, path/type/mode
  validation, immutable checkpoint contents, and independent restore clones;
- idempotent preserve/restore/verify/delete operations, policy preservation,
  retention, reconciliation, inventory, and explicit pruning;
- scoped REST/OpenAPI, protocol v2 with v1 compatibility, lifecycle events,
  CLI attach/preserve/restore/checkpoint/output/storage commands, and docs;
- Compose and Kubernetes deployment examples plus a persistence probe template.

## Validation Evidence

- Repository quality gate: `bun run check` passed. Biome reports 15
  warning-level complexity notices but no errors; Knip passed.
- Full application suite: `bun test` passed with 96 tests and one
  PostgreSQL-only skip in that invocation.
- Real PostgreSQL integration: 3 tests and 25 assertions passed against the
  project Compose PostgreSQL, including generated migrations and persistence
  table/store round trips.
- Type safety: all nine workspace projects passed `bun run typecheck`.
- Production builds: agent, server, and CLI passed `bun run build`.
- Persistence E2E: REST preserve, idempotency, verification, independent
  restore, lineage, restore launch mode, and declared outputs passed.
- Storage security/portability: safe symlinks, modes, mtimes, quota rejection,
  escaping-symlink rejection, checksum corruption detection, opaque-ref
  enforcement, independent forks, and PVC mapping passed.
- Runtime portability: Docker host mounts/secrets and Kubernetes Job/PVC/
  Secret/tmpfs/security projection passed driver tests.
- Configuration: local filesystem, Kubernetes PVC/Secret, and fail-closed
  partial setup tests passed.
- Compose configuration resolved successfully.
- All seven Kubernetes manifest resources parsed successfully. The Job
  contract is exercised through a fake `kubectl`; no live cluster context was
  configured in this workspace.
- The final production server image built successfully and contains Docker
  28.5.2 plus kubectl 1.34.1.
- `npm pack --dry-run --json` passed and produced the intended four-file CLI
  package. The changeset schedules a minor CLI release.
- `git diff --check` passed.

## Change Requests

None.

## Artifacts

- `files/pc-1-validation.md`
- `files/pc-1-deployment.md`

## Operational Notes

- Kubernetes uses one active server replica and an RWX-capable claim for
  multi-node clusters. Single-node clusters may adapt the manifest to their
  supported RWO storage class.
- Filesystem/PVC checkpoints survive runtime removal, but disaster recovery
  still requires coordinated PostgreSQL and checkpoint-root backups.
- Existing templates remain ephemeral until they explicitly opt in.
