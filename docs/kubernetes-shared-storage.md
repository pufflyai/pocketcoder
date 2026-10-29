# Kubernetes shared storage

The `kubernetes-shared` backend adds provider-owned PVC subdirectories. Callers
and templates cannot choose a claim, physical path or sibling allocation.
It requires a qualified `shared-writer-readonly/v1` filesystem, ReadWriteMany,
a bound PVC and PV in the configured storage class, and PV reclaim policy
`Retain`. Local and hostPath volumes are rejected. RuntimeClass selection stays
unchanged. Shared storage uses cold launches; warm pools are unsupported.

Mount the PVC root into the trusted controller. Keep the database, canonical
input root and checkpoint archive on private controller storage outside workload
mounts. Never put PGlite on NFS. The controller copies verified canonical bytes
into private projection staging, syncs them, then publishes an execution directory
by rename. Workloads receive only `inputs/<workspace-id>/published` at `/inputs`,
read-only. They cannot see staging, canonical bytes, allocation metadata or a
writable alias. Later execution directories do not replace earlier publications.
Names are metadata; UUIDs select directories and file names.

The publisher runs outside workload pods. The workload storage init container
only handles disposable emptyDir mounts. It never receives the shared PVC.
Workload containers drop all capabilities and receive no Kubernetes API token or
storage credential. ReadWriteMany describes attachment support; the read-only
mount and network boundary enforce input immutability.

## Network boundary

Untrusted workloads must not reach any storage data or management endpoint.
NFS AUTH_SYS lets a client claim another UID over ordinary TCP; no mount capability
is needed. A read-only mount alone is insufficient.

The first profile requires an IPv4 deployment with an enforced NetworkPolicy
implementation. Use a dedicated workload namespace with exactly one egress policy:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: storage-isolation
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except: [192.0.2.10/32]
```

Replace that documentation address with every actual storage endpoint. Nodes and
the trusted publisher must still reach storage. The controller checks the exact
policy before creating launch resources, rejects additive policies, and checks an
NFS PV's server against the blocked endpoints. For CSI storage, qualification must
identify and isolate every endpoint used by that driver. An API object cannot prove
that the network plugin enforces the policy. Run the real qualification probe for
each installed driver, network plugin, image and storage configuration. Deny admission
if that configuration has not been qualified. Changes to those identities require
new qualification. DNS-only storage endpoints and IPv6 profiles are unsupported.

## Deployment settings and bounds

Select `POCKETCODER_STORAGE_BACKEND=kubernetes-shared`, configure
`POCKETCODER_CHECKPOINT_DIR`, and set `POCKETCODER_KUBERNETES_SHARED_STORAGE` to JSON.
This is a bounded **test fixture**, not a production default:

```json
{
  "root": "/shared",
  "claimName": "shared",
  "volumeName": "qualified-shared-pv",
  "storageClassName": "qualified-nfs",
  "networkPolicyName": "storage-isolation",
  "storageCidrs": ["192.0.2.10/32"],
  "profile": "shared-writer-readonly/v1",
  "maxBytes": 16777216,
  "maxFiles": 64
}
```

`maxBytes` and `maxFiles` bound combined output allocation reservations and copied
input payloads, including abandoned private copies. Published manifest count is
also bounded by `maxFiles`. Provision physical storage and metadata headroom for
the declared limits. Unknown incomplete allocation metadata fences admission until
its owner retries or explicit cleanup removes it. A retry of an unpublished allocation
reclaims its private staging; an acknowledged allocation preserves its identity.

These are admission and extraction bounds, not per-directory writable filesystem
quotas. A deployment that needs write quotas must enforce them in its storage
provider. Workload writes can exhaust backing storage; failed writes/publication
must remain visible, and must not release owned capacity. The qualification fixture
physically caps the whole export at 64 MiB and does not claim durable backing beyond
its test lifetime. Production requires a durable qualified shared filesystem.

Use one `KubernetesSharedStorage` instance under the controller's existing single
coordinator lease. Pass it to the runtime driver and the storage owner. Its queue
serializes allocation and publication admission. Multiple independent publishers
against one root are unsupported.

## Publication and retained output owners

After the input store freezes and pins an ordered manifest, the execution owner
calls `publishInputs(projection, canonicalStorage)`. Dispatch waits for that promise.
Its mount is stable across late publications and provider recreation. Publication
returns `/shared/inputs/<workspace-id>/published/<manifest-id>` to trusted code;
the workload path is `/inputs/<manifest-id>/<file-id>`. The manifest is `manifest.json`.
Missing or corrupt bytes fail publication. Canonical loss requires new staging refs.

Finite output owners allocate declared mounts with `retainForExtraction: true`.
Deleting the Job or pod leaves those bytes and their reservations owned. The trusted
finalizer stops all writers, extracts bounded regular files, commits its result or
explicit loss outcome, then calls `completeExtraction(ref)`. Only afterward may
cleanup call `deleteStorage(ref)`. A failed deletion leaves capacity charged and
can be retried. Pod deletion and emptyDir cleanup never stand in for extraction.

Existing checkpoint mounts omit that output hold. Shared checkpoint/restore keeps
the controller archive protocol; physical allocation removal must succeed before
its database row becomes deleted. Checkpoints never include immutable input roots.

This ticket provides storage enforcement and lifecycle primitives. Execution dispatch
and automatic finite finalization belong to PC-129 and PC-131. The storage setting
alone does not advertise a complete canonical workload profile or enable legacy
attachment relay. Installed producer evidence must support the full capability set.

## Qualification

Run `bun run example:e2e:kubernetes-shared-storage` or
`bun run example:e2e:kubernetes-launch --shared-storage` with Docker, Kind and kubectl.
The command creates and removes its own two-node cluster, installs the pinned Calico
network plugin, and uses a pinned NFS-Ganesha image outside workload pods. The probe
uses a namespace-scoped, expiring controller credential outside workload mounts.
It checks actual NFS mounts, late publication, denied mutation, isolated sibling
allocations, publisher restart, cross-node recreation and bytes after pod deletion.
It also checks unsupported storage rejection and measured 1/5/20 allocation attempts.
Image/config digests and storage identities are printed with the results.
