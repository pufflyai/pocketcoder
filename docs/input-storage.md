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
verified canonical bytes to rebuild a lost projection. Docker and Kubernetes mount
enforcement are separate tickets, PC-128 and PC-130. Legacy AgentAPI attachment
messages fail with `attachment.unsupported` until a qualified projection and
operation owner are installed. Text-only messages keep working.

Canonical loss is explicit: a missing, corrupt, linked or non-regular payload marks
the input unavailable and prevents dispatch. Uploads cannot repair accepted IDs.
Restore must stage new workspace-scoped references; it never migrates old references
or treats a checkpoint of workload home files as canonical storage. This is a
bounded staging store, not a dataset store or an archive.
