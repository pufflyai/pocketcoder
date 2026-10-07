# PocketCoder on DigitalOcean Kubernetes

This example deploys one PocketCoder server to DigitalOcean Kubernetes (DOKS).
It uses embedded PGlite on a private block volume and workspace Network File Storage (NFS). The
default Service is private. The test workspace uses the credential-free
`persistent-echo` harness. A second flow runs the real Pi coding agent through
a private, single-session model gateway.

The example configures Kubernetes resources. It does not create or delete
DigitalOcean cloud resources.

## Before you start

Use an operator machine with Bash, Bun 1.4.2, `doctl`, and `kubectl`. Keep
`doctl` credentials on that machine. Never run `doctl auth init` in a
PocketCoder workspace.

Prepare these resources in one DigitalOcean project:

- A DOKS cluster on Kubernetes 1.33 or newer.
- A DigitalOcean NFS share reachable by that cluster. Use the same VPC and
  region. Record its private host, export path, size, and tier.
- A DigitalOcean block volume through the `do-block-storage` class for PGlite.
  The controller data folder must never use the workspace NFS share.
- Exact server and workspace image references from one release.
- Exact Pi and Pi gateway image references if you will run the coding-agent
  flow.
- A registry pull Secret if either image is private.

DigitalOcean NFS enforces root squashing. The server therefore runs as uid/gid
10001. The NFS example follows DigitalOcean's static `ReadWriteMany` PV/PVC
setup and uses `nconnect=8`. See the [DigitalOcean NFS guide](https://docs.digitalocean.com/products/kubernetes/how-to/use-nfs-storage/).

Keep the controller data separate from workspace storage. PGlite needs local
or block storage. Keep one writer and fence a failed node before moving its
volume. A `ReadWriteOnce` claim does not replace the process's kernel lock.

## Prepare an ignored working copy

Do not put deployment secrets in this directory. It holds only non-secret
render inputs.

```bash
mkdir -p .pocketcoder
cp -R deploy/kubernetes .pocketcoder/kubernetes
cp -R deploy/digitalocean .pocketcoder/digitalocean
```

Edit these files under `.pocketcoder/`:

- `digitalocean/storage/nfs.yaml`: replace the NFS host and export path. Set
  both storage sizes to the NFS share size.
- `digitalocean/server/pvc-patch.yaml`: set the same PVC size.
- `digitalocean/bootstrap/kustomization.yaml`: replace the server repository and
  digest.
- `digitalocean/server/kustomization.yaml`: use the same server repository and
  digest.
- `digitalocean/server/templates/persistent-echo.json`: replace the workspace
  repository and digest.
- `digitalocean/server/templates/pi-harness.json`: replace the Pi repository,
  digest, and allowed model.
- `digitalocean/pi-gateway/kustomization.yaml`: replace the gateway repository
  and digest.
- `digitalocean/pi-gateway/gateway.yaml`: set the same allowed model.

Every image must use `repo@sha256:<64 lowercase hex>`. Mutable tags, repeated
placeholder digests and unresolved `REPLACE_` values fail preflight.
Use the same exact image for the admin Pod and server.

Render and check every phase before applying anything:

```bash
kubectl kustomize .pocketcoder/digitalocean/storage >/tmp/pocketcoder-storage.yaml
kubectl kustomize .pocketcoder/digitalocean/bootstrap >/tmp/pocketcoder-bootstrap.yaml
kubectl kustomize .pocketcoder/digitalocean/server >/tmp/pocketcoder-server.yaml
kubectl kustomize .pocketcoder/digitalocean/pi-gateway >/tmp/pocketcoder-pi-gateway.yaml
bun run example:digitalocean:check \
  /tmp/pocketcoder-storage.yaml \
  /tmp/pocketcoder-bootstrap.yaml \
  /tmp/pocketcoder-server.yaml \
  /tmp/pocketcoder-pi-gateway.yaml
```

The rendered files contain no secret values.

## Apply storage

Connect `kubectl` to the intended cluster and confirm its version and nodes:

```bash
doctl kubernetes cluster kubeconfig save <cluster-name>
kubectl version
kubectl get nodes
kubectl apply -k .pocketcoder/digitalocean/storage
kubectl -n pocketcoder wait pvc/pocketcoder-workspaces \
  --for=jsonpath='{.status.phase}'=Bound --timeout=120s
```

The PV uses `Retain`. Removing the Kubernetes object does not delete the NFS
share.

## Create server secrets

Use an external secret manager when one is available. This local alternative
uses hidden input and a mode-0700 temporary directory. Values do not enter shell
history or the repository.

```bash
secret_directory="$(mktemp -d)"
chmod 0700 "$secret_directory"
openssl rand -base64 32 >"$secret_directory/auth-pepper"
kubectl -n pocketcoder create secret generic pocketcoder-server \
  --from-file=auth-pepper="$secret_directory/auth-pepper"
rm -r -- "$secret_directory"
unset secret_directory
```

If the Secret already exists, update it through the same trusted process. Do
not copy its values into a manifest, ConfigMap, template, log, or report.

For private images, create one namespace pull Secret from a Docker config held
outside the repository, then attach it to both service accounts:

```bash
kubectl -n pocketcoder create secret generic pocketcoder-registry \
  --type=kubernetes.io/dockerconfigjson \
  --from-file=.dockerconfigjson=/path/outside/repository/config.json
kubectl -n pocketcoder patch serviceaccount pocketcoder-controller \
  -p '{"imagePullSecrets":[{"name":"pocketcoder-registry"}]}'
kubectl -n pocketcoder patch serviceaccount pocketcoder-workspace \
  -p '{"imagePullSecrets":[{"name":"pocketcoder-registry"}]}'
```

The kubelet reads this Secret. Workspace containers do not mount it, have no
service-account token, and have no controller RBAC.

## Bootstrap and start the server

Run the temporary admin Pod while the controller is stopped. It mounts only
controller data and receives no Kubernetes API token. On an existing install,
first scale the controller to zero and wait for its old Pod to terminate.

```bash
kubectl apply -k .pocketcoder/digitalocean/bootstrap
kubectl -n pocketcoder wait pod/pocketcoder-admin --for=condition=Ready --timeout=5m
```

## Issue a one-hour operator key

Create a principal before starting the server. Local admin commands hold the
same data-folder lock as the controller. Keep the key only in the operator shell.

```bash
kubectl -n pocketcoder exec pod/pocketcoder-admin -- \
  pcd principals create \
  --name digitalocean-example \
  --scopes templates:read,workspaces:create,workspaces:read,workspaces:cancel,workspaces:preserve,workspaces:restore,checkpoints:read,checkpoints:delete,services:relay,conversations:read,terminal:attach,terminal:read \
  --templates persistent-echo,pi-harness

key_expiry="$(bun -e 'console.log(new Date(Date.now() + 3_600_000).toISOString())')"
export POCKETCODER_KEY="$(
  kubectl -n pocketcoder exec pod/pocketcoder-admin -- \
    pcd keys issue --principal digitalocean-example --expires "$key_expiry" | tail -n 1
)"
unset key_expiry
export POCKETCODER_URL=http://127.0.0.1:7080
```

Never use `--expires never` for this example.

Delete the admin Pod before starting the controller so the volume has one user:

```bash
kubectl -n pocketcoder delete pod pocketcoder-admin --wait=true
kubectl apply -k .pocketcoder/digitalocean/server
kubectl -n pocketcoder rollout status deployment/pocketcoder-server --timeout=5m
kubectl -n pocketcoder port-forward service/pocketcoder-server 7080:7080
```

Keep one server replica with the `Recreate` strategy. Startup loads the seed or
opens the existing database, checks history and applies pending migrations.
In another terminal, check `/livez` and `/readyz` before running the flow below.

## Run the echo and persistence checks

First prove launch, relay, response, cancellation, and terminal state:

```bash
POCKETCODER_EXAMPLE_TEMPLATE=persistent-echo \
POCKETCODER_EXAMPLE_EXPECT='pocketcoder example ok' \
bun run example:e2e
```

Then create a second workspace and exercise NFS checkpoint restore. Every
identifier below comes from JSON output, not human-formatted text.

```bash
workspace_id="$(
  bun run pcd -- workspaces create \
    --template persistent-echo \
    --external-id digitalocean-persistence-check \
    --wait --json | \
  bun -e 'const value = await new Response(Bun.stdin.stream()).json(); console.log(value.id)'
)"
preserve_json="$(bun run pcd -- workspaces preserve --id "$workspace_id")"
checkpoint_id="$(
  printf '%s' "$preserve_json" | \
  bun -e 'const value = await new Response(Bun.stdin.stream()).json(); console.log(value.checkpoint.id)'
)"
unset preserve_json

for attempt in $(seq 1 60); do
  checkpoint_state="$(
    bun run pcd -- checkpoints get --id "$checkpoint_id" | \
    bun -e 'const value = await new Response(Bun.stdin.stream()).json(); console.log(value.state)'
  )"
  [ "$checkpoint_state" = ready ] && break
  [ "$checkpoint_state" = failed ] && exit 1
  sleep 2
done
[ "$checkpoint_state" = ready ]
bun run pcd -- checkpoints verify --id "$checkpoint_id"

restored_workspace_id="$(
  bun run pcd -- workspaces restore \
    --checkpoint "$checkpoint_id" \
    --external-id digitalocean-persistence-restore | \
  bun -e 'const value = await new Response(Bun.stdin.stream()).json(); console.log(value.workspace.id)'
)"

for attempt in $(seq 1 60); do
  restored_state="$(
    bun run pcd -- workspaces get --id "$restored_workspace_id" | \
    bun -e 'const value = await new Response(Bun.stdin.stream()).json(); console.log(value.state)'
  )"
  [ "$restored_state" = ready ] && break
  sleep 2
done
[ "$restored_state" = ready ]
bun run pcd -- workspaces cancel --id "$restored_workspace_id"
bun run pcd -- checkpoints delete --id "$checkpoint_id"
```

The evidence to record is the workspace id, ready time, echo response, terminal
state, checkpoint id, and restored workspace id. Redact the machine key and
database URL.

## Run DOKS/NFS conformance

Use a digest-pinned small image that contains POSIX `sh`, `stat`, and core file
tools. This opt-in test creates server-owned opaque paths, mounts only one
workspace `subPath`, writes as uid 10001, checks that a sibling path cannot be
read, checks checkpoint I/O, and cleans up its Job, Pods, allocations, and
checkpoint path even after failure.

```bash
POCKETCODER_KUBERNETES_CONFORMANCE=1 \
POCKETCODER_KUBERNETES_NAMESPACE=pocketcoder \
POCKETCODER_KUBERNETES_WORKSPACE_CLAIM=pocketcoder-workspaces \
POCKETCODER_KUBERNETES_WORKSPACE_SUBPATH=workspaces \
POCKETCODER_KUBERNETES_CONFORMANCE_IMAGE='registry.example/conformance@sha256:<64-hex-digest>' \
POCKETCODER_DIGITALOCEAN_REGION='<region>' \
POCKETCODER_DIGITALOCEAN_NFS_TIER='<tier>' \
bun test packages/drivers/src/kubernetes/kubernetes-conformance.test.ts
```

Save its JSON output with the DOKS version, region, NFS tier, path modes, and
probe result. This real-cluster result is required before calling the example
supported.

## Run Pi remotely

Follow the [Pi session guide](./PI.md) to create the short-lived gateway
Secret, start one bounded gateway, launch Pi, connect a terminal or remote Pi
client, and tear the session down.

## Optional public HTTPS

Public access is outside the default apply path. Edit
`digitalocean/public-https/kustomization.yaml` in the ignored copy. Provide a
real DigitalOcean certificate name and explicit source CIDRs. Preflight rejects
unresolved certificates and `0.0.0.0/0` or `::/0`.

```bash
kubectl kustomize .pocketcoder/digitalocean/public-https \
  >/tmp/pocketcoder-public.yaml
bun run example:digitalocean:check \
  /tmp/pocketcoder-storage.yaml \
  /tmp/pocketcoder-public.yaml
kubectl apply -k .pocketcoder/digitalocean/public-https
curl --fail https://<pocketcoder-host>/readyz
```

DigitalOcean terminates TLS on port 443 and forwards HTTP inside the cluster.
Machine-key authentication still applies. See the [DOKS load balancer settings](https://docs.digitalocean.com/products/kubernetes/how-to/configure-load-balancers/).

## Cleanup

Unset the short-lived key first:

```bash
unset POCKETCODER_KEY POCKETCODER_URL
kubectl delete -k .pocketcoder/digitalocean/pi-gateway --ignore-not-found
kubectl -n pocketcoder delete secret pocketcoder-pi-gateway-session --ignore-not-found
kubectl delete namespace pocketcoder
kubectl delete persistentvolume pocketcoder-digitalocean-nfs
```

The retained NFS share, controller block volume, DOKS cluster, registry,
and load balancer can continue to incur cost. Review each one in DigitalOcean
and delete it only through a separate, explicit operator action. Back up and
restore the embedded database, auth pepper, signing identity and NFS checkpoints
together while the controller is stopped. NFS alone is not disaster recovery.
