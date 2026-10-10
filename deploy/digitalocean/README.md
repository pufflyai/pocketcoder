# DigitalOcean Kubernetes example

Run one controller with embedded PGlite and checkpoint archives on its own
`do-block-storage` volume. Workspace Jobs use bounded `emptyDir` mounts. They
never mount the controller volume. No shared workspace storage is required.

This is a synthetic deployment recipe. Hosted gVisor and production recovery
acceptance are tracked in PC-84 and the later hosted tickets.

## Prepare the deployment

Use a DOKS cluster with enough CPU, memory and ephemeral storage for the declared
workspace limits. Install the selected RuntimeClass handler on the workspace
node pool. Set `POCKETCODER_KUBERNETES_RUNTIME_CLASS` in the deployment patch;
PocketCoder requests that exact class without a fallback.

Build and publish immutable server and workspace images. Replace every
`REPLACE_` image and model field in `server`, `bootstrap` and `pi-gateway`.
The persistent echo and Pi template examples include pod storage budgets. Keep
mount limits plus at least 64 MiB for the writable layer and logs within each
budget. Transfer staging also needs enough workspace memory.

Render the storage and server resources:

```sh
kubectl apply -k deploy/digitalocean/storage
kubectl kustomize deploy/digitalocean/server > /tmp/pocketcoder-server.yaml
kubectl kustomize deploy/digitalocean/bootstrap > /tmp/pocketcoder-admin.yaml
bun run example:digitalocean:check /tmp/pocketcoder-server.yaml /tmp/pocketcoder-admin.yaml
kubectl apply -f /tmp/pocketcoder-server.yaml
kubectl -n pocketcoder rollout status deployment/pocketcoder-server
```

The private controller generates and stores its keys once. Its data and deletion
journal stay on the private block volume. Never mount that volume in a workspace.
Run one controller replica with the Recreate strategy. A block volume does not
replace the controller writer lock. Fence a failed node before moving its volume.

## Claim finite owner authority

After the controller is ready, use its local administration socket through an
operator-only `kubectl exec`:

```sh
kubectl -n pocketcoder exec deployment/pocketcoder-server --   pcd superuser create --dir /var/lib/pocketcoder-controller/pc_data   --automation --expires '<UTC timestamp at most 24 hours ahead>'   --request-id '<new UUID>' --json
```

The token is returned once. Store it only in the operator's process or private
credential store. Repeating the same request reconciles the issued key without
returning its plaintext. Replace a lost key through the explicit local admin
replacement path. Never put owner or operator authority in a workspace Secret.

Port-forward the operator Service to localhost. Publish reviewed templates with
`pcd templates import`, create an echo workspace, preserve it, and restore its
checkpoint after moving scheduling to a different node. Readiness requires the
verified restore and a working agent. The local equivalent is
`bun run example:e2e:kubernetes-checkpoint`.

## Optional Pi gateway and public HTTPS

The `pi-gateway` manifests keep provider credentials outside workspace pods. Mint
a separate workspace-scoped gateway bearer with a finite expiry before launch.
The bearer must expire with that workspace; never reuse a standing session
bearer across workspaces. Restricted egress and the selected RuntimeClass must
be tested together on the actual cell.

The public Service overlay requires a real DigitalOcean certificate and narrow
`loadBalancerSourceRanges`. Review it before applying. Embedded public views
also require a separate registrable domain and the forwarding configuration in
[deployment.md](../../docs/deployment.md).

## Backup and cleanup

Use `pcd backup create` to freeze and capture the controller database, keys and
referenced archives together. Keep the deletion journal outside the backup
rollback boundary. Encrypt off-node archives with a separately held key and
include retained versions in account purge. Test fresh-volume restore before
using customer data.

Delete owned workspace data through the API and wait for successful operations
before removing the controller. Deleting a namespace or PVC is not proof that
retained backups are gone. Remove the deployment and retained block volume only
when its current deletion and backup inventory proves cleanup.
