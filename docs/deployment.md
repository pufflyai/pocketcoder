# Deployment

## Container images

CI publishes two images to the GitHub Container Registry on every push to
`main` and on version tags (see `.github/workflows/ci.yml`):

- `ghcr.io/<owner>/<repo>/server` — pocketcoder-server plus `pcd`
  (`/usr/local/bin/pcd`, backed by `/opt/pocketcoder/pcd.js`), Docker CLI, and
  `kubectl`.
  Built from [`deploy/image/server.Dockerfile`](../deploy/image/server.Dockerfile).
- `ghcr.io/<owner>/<repo>/workspace` — a minimal workspace base image with the
  `pocketcoder-agent` supervisor and a loopback echo harness, useful for probe
  templates and as a starting point for real agent images. Built from
  [`deploy/image/Dockerfile`](../deploy/image/Dockerfile).

Real coding-agent images extend the pattern: install AgentAPI by checksum,
your agent CLI, and the supervisor; keep everything runnable by the template's
non-root uid. Always reference images by digest in templates — mutable tags
are rejected.

Publishing the versioned CLI automatically creates the matching `v<version>`
tag. That tag publishes semver image tags and creates or updates the matching
GitHub release with a `pocketcoder-image-digests.txt` asset and the exact
server and workspace digest references in the release notes. Pin a deployment
to the recorded value, for example:

```yaml
services:
  server:
    image: ghcr.io/pufflyai/pocketcoder/server@sha256:<release-digest>
```

While the repository/package is private, authenticate Docker with a classic
GitHub personal access token that has `read:packages`; authorize the token for
organization SSO when required:

```sh
export CR_PAT='<classic-personal-access-token>'
printf '%s' "$CR_PAT" | docker login ghcr.io -u '<github-user>' --password-stdin
docker pull ghcr.io/pufflyai/pocketcoder/server@sha256:<release-digest>
```

GitHub Actions in another repository can use `GITHUB_TOKEN` after that
repository has been granted read access to the package; give the job
`packages: read` and log in with `github.actor` plus
`secrets.GITHUB_TOKEN`. Do not put registry tokens into templates, launch
input, or workspace images.

Build locally:

```sh
docker build -f deploy/image/server.Dockerfile -t pocketcoder-server:dev .
bun build apps/pocketcoder-agent/src/index.ts --target bun --outdir deploy/image/dist
docker build -t pocketcoder-workspace:dev deploy/image
```

## Docker compose

[`deploy/compose/docker-compose.yaml`](../deploy/compose/docker-compose.yaml)
provides a local PostgreSQL. For a full containerized control plane, run the
server image with:

- the docker socket mounted (`/var/run/docker.sock`) and the socket's gid in
  `group_add`, so the Docker driver can create workspace containers;
- a template directory mounted read-only at `POCKETCODER_TEMPLATE_DIR`;
- **an input directory mounted at the same absolute path on host and
  container**, with `POCKETCODER_INPUT_DIR` pointing at it. The driver writes
  one-time provider input files there and bind-mounts them into workspaces;
  since the host daemon resolves mount paths, the paths must match.
- `POCKETCODER_WORKSPACE_SERVER_URL=http://host.docker.internal:<port>` so
  workspace containers can reach the server.

A complete, disposable worked example (server + PostgreSQL + a locally
content-addressed workspace image) lives in
[`examples/`](../examples/README.md). Run
`bun run example:e2e:local` for the credential-free echo harness, or use the
same runner with the Pi example and an OpenAI-compatible model gateway.

The compose file also has a `full` profile for a containerized server with
persistent workspaces:

```sh
export POCKETCODER_AUTH_PEPPER="$(openssl rand -base64 32)"
export POCKETCODER_HOST_DATA_ROOT=/absolute/host/path/pocketcoder-data
mkdir -p "$POCKETCODER_HOST_DATA_ROOT"/{input,workspaces,checkpoints}
docker compose -f deploy/compose/docker-compose.yaml --profile full up -d
```

Set `POCKETCODER_SERVER_IMAGE` to an exact release digest and use `--no-build`
to consume the published control plane without a local checkout build:

```sh
export POCKETCODER_SERVER_IMAGE='ghcr.io/pufflyai/pocketcoder/server@sha256:<release-digest>'
docker compose -f deploy/compose/docker-compose.yaml --profile full pull server
docker compose -f deploy/compose/docker-compose.yaml --profile full up -d --no-build server
```

`POCKETCODER_HOST_DATA_ROOT` must be absolute and mounted at the identical
path inside the server. The host Docker daemon, not the server container,
resolves bind sources for child workspace containers. Running the server
directly on the host needs no path mirroring:

```sh
export POCKETCODER_STORAGE_BACKEND=filesystem
export POCKETCODER_WORKSPACE_DATA_DIR=/var/lib/pocketcoder/workspaces
export POCKETCODER_CHECKPOINT_DIR=/var/lib/pocketcoder/checkpoints
```

Use `POCKETCODER_SECRET_PROVIDER=file` plus an absolute
`POCKETCODER_SECRET_ROOT` for local `secretRef:` values. Only regular files
beneath that root are projected read-only and they must be outside the
workspace/checkpoint roots.

## Kubernetes

The Kubernetes runtime driver creates one namespaced Job and short-lived input
Secret per workspace. The PVC storage adapter gives every execution an opaque
subdirectory on a server-mounted claim; restore copies an immutable checkpoint
into a new subdirectory before Job admission.

[`deploy/kubernetes/pocketcoder.yaml`](../deploy/kubernetes/pocketcoder.yaml)
contains separate controller/workspace service accounts, least-privilege
Role/RoleBinding, a single-replica server Deployment, Service, and PVC:

```sh
kubectl create namespace pocketcoder
kubectl -n pocketcoder create secret generic pocketcoder-server \
  --from-literal=database-url='postgres://…' \
  --from-literal=auth-pepper="$(openssl rand -base64 32)"
kubectl -n pocketcoder create configmap pocketcoder-templates \
  --from-file=/path/to/reviewed/templates
kubectl -n pocketcoder apply -f deploy/kubernetes/pocketcoder.yaml
```

Supply deployment-reviewed template manifests, then replace the image and PVC
storage class/size first. The manifests under `examples/templates` contain
placeholder image references and are not production defaults. Multi-node deployments
need an RWX-capable claim because the server and workspace Jobs mount it;
single-node development clusters may use an appropriate RWO class. Run one
server replica—the connection hub and scheduler are intentionally
single-active. Workspace Jobs use the unprivileged `pocketcoder-workspace`
service account, not the controller account.

Memory-backed writable paths are mounted with the template uid/gid. Kubernetes
Jobs set pod `fsGroup` to the template gid with
`fsGroupChangePolicy: OnRootMismatch`; Docker tmpfs mounts set `uid`, `gid`,
and `mode=0700`. Do not rely on image-directory ownership beneath an
`emptyDir` or tmpfs mount.

Run the real-cluster ownership probe against the production storage/runtime
context before rollout:

```sh
POCKETCODER_KUBERNETES_CONFORMANCE=1 \
POCKETCODER_KUBERNETES_NAMESPACE=pocketcoder \
bun test packages/drivers/src/kubernetes.test.ts
```

With `POCKETCODER_SECRET_PROVIDER=kubernetes`, a template value
`secretRef:git-credentials/token` projects key `token` from Secret
`git-credentials` as a read-only file. Secret names/values are not stored in
checkpoint manifests.

## PostgreSQL placement

One migration/query path serves both layouts:

```text
POCKETCODER_DATABASE_URL      the PostgreSQL server and database
POCKETCODER_DATABASE_SCHEMA   table namespace, default pocketcoder
```

The URL may target a dedicated database or an existing application database.
Runtime queries are schema-qualified, while generated Drizzle migrations run
with `search_path` pinned to the configured schema on a reserved connection.
Pocketcoder never touches `public`, other schemas, extensions, or application
tables, and creates no cross-schema dependencies. Migrations run under a
schema-scoped advisory lock via `pcd db migrate` (the server also
migrates on startup). Recommended roles: a migration role owning the schema,
an application role with connect/usage/DML only.

## Configuration reference

| Variable | Default | Purpose |
|----------|---------|---------|
| `POCKETCODER_DATABASE_URL` | required (postgres store) | PostgreSQL server/database |
| `POCKETCODER_DATABASE_SCHEMA` | `pocketcoder` | Runtime schema |
| `POCKETCODER_STORE` | `postgres` | `memory` for tests/dev only |
| `POCKETCODER_AUTH_PEPPER` | required (postgres store) | Keyed digest secret for machine keys and registration secrets |
| `POCKETCODER_EVENT_SIGNING_KEY` | pepper | HMAC key for lifecycle event signatures |
| `POCKETCODER_EVENT_SINK_URL` | none | Callback URL for signed lifecycle events |
| `POCKETCODER_TEMPLATE_DIR` | none | Directory of reviewed template manifests |
| `POCKETCODER_HOST` / `POCKETCODER_PORT` | `127.0.0.1` / `7080` | Listen address |
| `POCKETCODER_WORKSPACE_SERVER_URL` | `http://host.docker.internal:<port>` | URL workspaces use to reach the server |
| `POCKETCODER_INPUT_DIR` | OS tempdir | Provider input files (must be host-shared when the server is containerized) |
| `POCKETCODER_DRIVER` | `docker` | `docker` or `kubernetes` runtime |
| `POCKETCODER_STORAGE_BACKEND` | `disabled` | `filesystem`/`docker-local` or `kubernetes-pvc` |
| `POCKETCODER_WORKSPACE_DATA_DIR` | required with storage | Active allocation root or mounted PVC directory |
| `POCKETCODER_CHECKPOINT_DIR` | required with storage | Immutable checkpoint root or mounted PVC directory |
| `POCKETCODER_SECRET_PROVIDER` | `disabled` | `file` or `kubernetes` |
| `POCKETCODER_SECRET_ROOT` | required for file secrets | Deployment-owned local secret root |
| `POCKETCODER_KUBERNETES_NAMESPACE` | `default` | Namespace for Jobs and input Secrets |
| `POCKETCODER_KUBERNETES_SERVICE_ACCOUNT` | none | Service account assigned to workspace Jobs |
| `POCKETCODER_KUBERNETES_WORKSPACE_CLAIM` | required for PVC | Claim mounted by server and workspace Jobs |
| `POCKETCODER_KUBERNETES_WORKSPACE_SUBPATH` | `workspaces` | Opaque allocation prefix in the claim |
| `POCKETCODER_MAX_RETAINED_BYTES` | `500Gi` | Global checkpoint quota |
| `POCKETCODER_MAX_RETAINED_BYTES_PER_PRINCIPAL` | `100Gi` | Per-principal checkpoint quota |
| `POCKETCODER_MAX_CHECKPOINTS_PER_PRINCIPAL` | `100` | Per-principal ready checkpoint count |
| `POCKETCODER_MAX_CHECKPOINT_FILES` | `1000000` | Measured files per checkpoint |
| `POCKETCODER_MAX_CHECKPOINT_OPERATIONS` | `4` | Concurrent durable checkpoint operations |
| `POCKETCODER_MAX_ACTIVE_WORKSPACES` | `100` | Global concurrency limit |
| `POCKETCODER_MAX_ACTIVE_PER_PRINCIPAL` | `20` | Per-principal concurrency limit |
| `POCKETCODER_MAX_QUEUED_WORKSPACES` | `1000` | Durable queue bound |
| `POCKETCODER_SCHEDULER_INTERVAL_MS` | `1000` | Admission/sweep tick |
| `POCKETCODER_OUTBOX_INTERVAL_MS` | `1000` | Event delivery tick |
| `POCKETCODER_WARM_POOLS` | `[]` | Operator-only JSON array of stateless template pools |

## Warm workspace pools

Warm pools are disabled unless `POCKETCODER_WARM_POOLS` names an eligible template. Each entry resolves to an exact immutable template digest during startup:

```sh
export POCKETCODER_WARM_POOLS='[{"template":"fixture-echo","version":"1.0.0","min_ready":1,"max_warm_age":"15m","miss_policy":"cold","wait_timeout":"5s"}]'
```

`min_ready` defaults to `1`, `max_warm_age` to `15m`, and `miss_policy` to `cold`. The optional `wait` policy leaves a miss queued only through `wait_timeout`, then falls back to cold provisioning. Startup rejects unknown/retired templates, duplicate digests, desired capacity above the global workspace limit, persistence mounts, and any `secretRef:` because Docker and Pod mounts cannot be added after creation.

Unbound providers contain only template identity and a single-use pool enrollment credential. Workspace identity, registration authority, source, and launch input arrive in memory after an atomic lease. Assigned providers are destroyed after one workspace and are never recycled. Use `pcd pools list` or `GET /v1/warm-pools` with an admin key to inspect inventory and counters.

## Operational notes

- **One server replica** is the supported topology: workspaces survive server
  restarts, reconnect within their `disconnectGrace`, and state is reconciled
  against provider objects at startup.
- **Rotation**: issue a new machine key, switch the caller, revoke the old
  one; old and new overlap safely.
- **Secrets**: never put provider/LLM credentials in templates or launch
  input. An LLM gateway (e.g. agentgateway) should remain the only credential
  boundary; env names that look like secrets are rejected unless they are
  `secretRef:` references.
- **Backups**: filesystem/PVC checkpoints survive runtime removal but are not
  disaster recovery unless the checkpoint root and PostgreSQL are backed up
  together.
- **Retention**: the server sweeps expired ready checkpoints every minute.
  `pcd storage doctor|list-orphans|prune` provides explicit
  inventory and maintenance; unknown physical objects are reported and never
  auto-deleted.
