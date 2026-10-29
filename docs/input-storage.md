# Immutable input storage

The controller owns input bytes and descriptors. Workload home files and sidecars
are never evidence of canonical input content. The existing attachment PUT route
streams directly into a private filesystem root. It does not need a live supervisor.
Old supervisor upload frames reject writes.

Set `POCKETCODER_INPUT_STORAGE` to a JSON object to enable staging. Every bound is
required. For example, these are small test settings, not production defaults:

```json
{
  "root": "/private/pocketcoder-inputs",
  "limits": {
    "fileBytes": 1048576,
    "stagedBytes": 8388608,
    "files": 16,
    "transfers": 2,
    "transferMs": 30000,
    "retentionMs": 600000
  },
  "principal": { "bytes": 16777216, "files": 32 },
  "instance": { "bytes": 33554432, "files": 64 },
  "headroom": { "bytes": 1048576, "files": 16 }
}
```

Keep this root outside every workload mount, including parents and aliases. The
filesystem adapter rejects overlap with configured workspace and launch-input roots.
The controller needs durable local storage with working file and directory sync.
It creates private directories and regular files with opaque UUID names. Logical
filenames are metadata, never path components. No storage credentials enter workloads.
An operator must also prevent mounts outside PocketCoder from exposing this root.

Before reading the request body, one PGlite transaction claims the workspace/file
ID and reserves staged bytes, file count and a transfer slot. Physical reservations
also enforce workspace, principal, instance and sampled free-disk capacity. Ready
objects and pending cleanup remain charged. Exhaustion never evicts another input.
No capacity or retention value has an implicit production default.

The caller declares exact size and SHA-256. The controller hashes each streamed
chunk, syncs the complete payload, renames it and syncs the publication directory.
It then commits the descriptor and reservation together. Only this database commit
makes an input ready. A retry with the same descriptor returns the ready reference
without reading another body. Changed metadata or content conflicts. An active
same-ID transfer returns `operation.conflict`. A failed unpublished upload can reuse
its ID after cleanup; an accepted expired or lost ID requires a new ID.

Startup and periodic reconciliation verify ready bytes, remove expired partial
transfers and unowned objects, and retry failed deletion. Capacity is released only
after removal. Cleanup runs at startup and every minute; an interrupted live upload
also attempts cleanup immediately. The finite transfer lease bounds an idle body.

`InputStorage.freeze` selects an ordered set of ready objects, stores a digest-bound
manifest and pins its exact versions. Repeating the manifest ID must select the
same workspace, incarnation and order. Pins remain through finalization. The
operation owner must call `finalize` after its bounded finalization phase, including
cancellation and failure. The retention clock restarts when a manifest is finalized.
Unreferenced inputs expire after the configured interval. A failed verification
records unavailable evidence. The operation owner must finalize the manifest even
when the first freeze attempt fails. Retrying verification never releases a pin
owned by an accepted operation. Dispatch must be fenced against finalization in
the operation owner (PC-129).

The provider-neutral projection reference contains workspace/file/version IDs and
the frozen manifest. It contains no host or PVC path. A trusted driver can read
verified canonical bytes to rebuild a lost projection. Docker uses the optional
daemon-host projection below. Kubernetes enforcement remains PC-130. Legacy AgentAPI attachment
messages fail with `attachment.unsupported` until a qualified projection and
operation owner are installed. Text-only messages keep working.

Canonical loss is explicit: a missing, corrupt, linked or non-regular payload marks
the input unavailable and prevents dispatch. Uploads cannot repair accepted IDs.
Restore must stage new workspace-scoped references; it never migrates old references
or treats a checkpoint of workload home files as canonical storage. This is a
bounded staging store, not a dataset store or an archive.

## Docker projection

Add `projection` to `POCKETCODER_INPUT_STORAGE` to enable the Docker publisher:

```json
{
  "root": "/srv/pocketcoder/projections",
  "probeImage": "your-trusted-helper@sha256:<64-lowercase-hex-digits>",
  "capacity": { "bytes": 16777216, "files": 256 }
}
```

This is the value of the nested `projection` field. The capacity values are fixture
examples, not production defaults. They bound all copied bytes, manifests and
receipts in one runtime incarnation, separately from canonical storage. Publication
reserves space before copying. It fails when the ceiling is reached. Finalization
may release an execution directory, but its small receipt remains until workspace
cleanup to prevent reusing the execution ID with different content. Set finite
ceilings for the deployment's expected number of operations and mount the root on
storage with enough capacity. Failed private copies are removed; restart removes
orphaned copies before another publication.

The root must be a private controller-owned directory on the **Docker daemon host**.
This first profile also requires the private canonical root to be available at its
same absolute path on that host, so the probe can identify and reject backing
aliases. When the controller runs in a container, bind both roots at their same
absolute paths. Keep the projection root
separate from canonical, writable work, output and launch-input storage. Public
requests and templates cannot choose host paths. The helper must be a trusted,
pinned Linux image containing `/bin/sh` and `cat`. The controller probes a
fresh marker through the daemon and reads the actual mount table with a short-lived
helper in the workspace PID namespace. The separate host probe receives
`DAC_READ_SEARCH` to read its markers in the private roots. The live namespace
helper receives `SYS_PTRACE` to inspect the workload process root. These short-lived
trusted helpers have no network. The workload drops **all** capabilities and has a read-only root.
No storage credential or publisher endpoint enters the workspace.

Creation mounts a fresh stable directory at `/run/pocketcoder/inputs` read-only,
with private propagation and recursive mounts disabled. Aliases of backing roots,
parent mounts, nested mounts, image target symlinks and extra capabilities are
rejected. A fresh challenge read through the actual container view detects a
replaced mount directory. Missing daemon-host access fails creation; absent
configuration advertises no input storage profile. Warm pools and Kubernetes do
not support this Docker setting.

The execution owner first freezes and pins its ordered selection, then awaits
`WorkspaceDriver.publishInputs(ref, selection)` before dispatch. The returned
directory contains `manifest.json` and one regular file per file UUID. Logical
names never become paths. The driver verifies canonical bytes and the complete
copy, syncs it privately, and atomically adds the directory. Later publication
appears through the same mount and cannot replace earlier entries. Lost execution
directories rebuild from the same pinned objects and receipt. Loss of the stable
mount root fails closed and needs a fresh runtime; it cannot be rebound in place.

The execution owner owns acceptance, dispatch fencing and finalization. Qualified
no-export service operations release their projection after durable terminal
acknowledgment, then finalize canonical pins through the same execution owner.
Release records a durable tombstone. A delayed publisher cannot recreate a
released directory, including after controller restart. Provider removal deletes only that incarnation's copies;
workspace purge waits for container removal. Neither operation deletes canonical
objects or releases their pins. The Docker workload verifier combines this observed input boundary with measured
image-owned runtime and adapter evidence before it binds canonical service support. Attachment-bearing legacy relay remains rejected.
