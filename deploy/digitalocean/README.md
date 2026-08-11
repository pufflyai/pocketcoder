# PocketCoder on DigitalOcean Kubernetes

This example deploys one PocketCoder server to DigitalOcean Kubernetes (DOKS).
It uses DigitalOcean Managed PostgreSQL and Network File Storage (NFS). The
default Service is private. The test workspace uses the credential-free
`persistent-echo` harness.

The example configures Kubernetes resources. It does not create or delete
DigitalOcean cloud resources.

## Before you start

Use an operator machine with Bash, Bun 1.3.14, `doctl`, and `kubectl`. Keep
`doctl` credentials on that machine. Never run `doctl auth init` in a
PocketCoder workspace.

Prepare these resources in one DigitalOcean project:

- A DOKS cluster on Kubernetes 1.33 or newer.
- A DigitalOcean NFS share reachable by that cluster. Use the same VPC and
  region. Record its private host, export path, size, and tier.
- A DigitalOcean Managed PostgreSQL database. Restrict its trusted sources to
  the DOKS cluster and use a private connection URL with `sslmode=require`.
- Exact server and workspace image references from one release.
- A registry pull Secret if either image is private.

DigitalOcean NFS enforces root squashing. The server therefore runs as uid/gid
10001. The NFS example follows DigitalOcean's static `ReadWriteMany` PV/PVC
setup and uses `nconnect=8`. See the [DigitalOcean NFS guide](https://docs.digitalocean.com/products/kubernetes/how-to/use-nfs-storage/).

Managed PostgreSQL requires TLS. `sslmode=require` encrypts traffic but does not
verify the server identity. Standard Edition can use `verify-full` with its CA,
but this example does not claim that mode until it is tested with Bun SQL and a
mounted CA. See [DigitalOcean database security](https://docs.digitalocean.com/products/databases/postgresql/how-to/secure/).

DOKS, PostgreSQL, NFS, a registry, and an optional load balancer are billed
separately. Check current prices before creating them.

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
- `digitalocean/migrate/kustomization.yaml`: replace the server repository and
  digest.
- `digitalocean/server/kustomization.yaml`: use the same server repository and
  digest.
- `digitalocean/server/templates/persistent-echo.json`: replace the workspace
  repository and digest.

Every image must use `repo@sha256:<64 lowercase hex>`. Mutable tags, repeated
placeholder digests, unresolved `REPLACE_` values, and mismatched migration and
server images fail preflight.

Render and check every phase before applying anything:

```bash
kubectl kustomize .pocketcoder/digitalocean/storage >/tmp/pocketcoder-storage.yaml
kubectl kustomize .pocketcoder/digitalocean/migrate >/tmp/pocketcoder-migrate.yaml
kubectl kustomize .pocketcoder/digitalocean/server >/tmp/pocketcoder-server.yaml
bun run example:digitalocean:check \
  /tmp/pocketcoder-storage.yaml \
  /tmp/pocketcoder-migrate.yaml \
  /tmp/pocketcoder-server.yaml
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
read -r -s -p "Private PostgreSQL URL: " database_url
printf '\n'
printf '%s' "$database_url" >"$secret_directory/database-url"
unset database_url
openssl rand -base64 32 >"$secret_directory/auth-pepper"
kubectl -n pocketcoder create secret generic pocketcoder-server \
  --from-file=database-url="$secret_directory/database-url" \
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

## Migrate, then start the server

The migration Job uses the exact server digest. It receives the database URL
through one Secret reference and has no service-account token.

```bash
kubectl -n pocketcoder delete job pocketcoder-migrate --ignore-not-found
kubectl apply -k .pocketcoder/digitalocean/migrate
kubectl -n pocketcoder wait job/pocketcoder-migrate \
  --for=condition=complete --timeout=5m
kubectl -n pocketcoder logs job/pocketcoder-migrate
kubectl apply -k .pocketcoder/digitalocean/server
kubectl -n pocketcoder rollout status deployment/pocketcoder-server --timeout=5m
```

Keep one server replica with the `Recreate` strategy. Server startup checks the
schema but never applies migrations.

Start a private port forward:

```bash
kubectl -n pocketcoder port-forward service/pocketcoder-server 7080:7080
```

In another terminal:

```bash
curl --fail http://127.0.0.1:7080/livez
curl --fail http://127.0.0.1:7080/readyz
```

## Issue a one-hour operator key

Create a principal with only the scopes used by this recipe. The server command
prints the key once. Keep it only in the operator shell.

```bash
kubectl -n pocketcoder exec deployment/pocketcoder-server -- \
  pcd principals create \
  --name digitalocean-example \
  --scopes templates:read,workspaces:create,workspaces:read,workspaces:cancel,workspaces:preserve,workspaces:restore,checkpoints:read,checkpoints:delete,services:relay,conversations:read \
  --templates persistent-echo

key_expiry="$(bun -e 'console.log(new Date(Date.now() + 3_600_000).toISOString())')"
export POCKETCODER_KEY="$(
  kubectl -n pocketcoder exec deployment/pocketcoder-server -- \
    pcd keys issue --principal digitalocean-example --expires "$key_expiry" | tail -n 1
)"
unset key_expiry
export POCKETCODER_URL=http://127.0.0.1:7080
```

Never use `--expires never` for this example.

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
bun test packages/drivers/src/kubernetes-conformance.test.ts
```

Save its JSON output with the DOKS version, region, NFS tier, path modes, and
probe result. This real-cluster result is required before calling the example
supported.

## Interactive access

The same private relay supports an interactive echo conversation:

```bash
bun run pcd -- workspaces chat --id '<ready-workspace-id>'
```

Or open the Pi terminal. Omit the workspace id to use its picker:

```bash
POCKETCODER_WORKSPACE_ID='<ready-workspace-id>' \
bunx @pstdio/pocketcoder-remote
```

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
  /tmp/pocketcoder-migrate.yaml \
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
kubectl delete namespace pocketcoder
kubectl delete persistentvolume pocketcoder-digitalocean-nfs
```

The retained NFS share, managed PostgreSQL database, DOKS cluster, registry,
and load balancer can continue to incur cost. Review each one in DigitalOcean
and delete it only through a separate, explicit operator action. Back up and
restore PostgreSQL and NFS together; NFS alone is not disaster recovery.
