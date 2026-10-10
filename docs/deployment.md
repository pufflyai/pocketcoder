# Deployment

## Container images

The [candidate image workflow](../.github/workflows/images.yml) builds six roles
from one source commit for Linux amd64 and arm64:

| Role | Contents | Recipe |
| --- | --- | --- |
| `server` | Controller, public `pocketcoder` command, Docker CLI and kubectl | [server.Dockerfile](../deploy/image/server.Dockerfile) |
| `workspace` | Supervisor, AgentAPI and echo harness | [Dockerfile](../deploy/image/Dockerfile) |
| `desktop` | Workspace runtime with an X11 desktop and VNC | [desktop.Dockerfile](../deploy/image/desktop.Dockerfile) |
| `browser` | Workspace runtime with Chromium | [browser.Dockerfile](../deploy/image/browser.Dockerfile) |
| `egress` | Restricted-network sidecar proxy | [Egress Dockerfile](../packages/egress/Dockerfile) |
| `manager` | Managed-account operator service and kubectl | [manager.Dockerfile](../deploy/image/manager.Dockerfile) |

Every image must pass Trivy 0.74.0 with zero HIGH or CRITICAL findings, including
findings without an upstream fix. CI keeps the scanner/database versions, scan
reports, SBOMs and exact image archives. Native Ubuntu runners exercise those
archives through Docker and Kubernetes before any registry writes. Desktop
images must stay below 1.5 GB. See [candidate images](candidate-images.md) for
the build, scan and role checks.

Publication uses only `ghcr.io/<owner>/<repo>/<role>:candidate-<full-commit>`
and architecture tags ending in `-amd64` or `-arm64`. The `published.json`
artifact records immutable architecture and multi-architecture digests. Use
those recorded digests in deployments; candidate publication does not update
`stable` or `latest`.

Set `POCKETCODER_EGRESS_IMAGE` to the recorded egress digest. Without it,
restricted templates cannot start. The bundled kubectl 1.35.9 permits Kubernetes
API server versions 1.34–1.36 under the [version skew policy](https://kubernetes.io/releases/version-skew-policy/#kubectl).
The candidate flow uses a pinned Kind 0.33.0 fixture with Kubernetes 1.35 nodes;
existing checks with Kubernetes 1.37 nodes do not prove supported kubectl version compatibility.

Real coding-agent images extend the workspace base and install only their agent
CLI and application environment. If they use another base, they must provide
the supported AgentAPI at `/usr/local/bin/agentapi` and the
supervisor. Keep everything runnable by the template's non-root uid. Always
reference images by digest in templates — mutable tags are rejected.

Promote a source template after building its workspace image with `pocketcoder
templates render`. The renderer accepts the immutable image reference and
typed deployment overrides, validates the final manifest, and derives its
version from the normalized content:

```sh
pocketcoder templates render templates/codex.yaml \
  --image "registry.example/codex@sha256:<64-hex-digest>" \
  --out deploy/templates
```

Mount only the rendered output directory at `POCKETCODER_TEMPLATE_DIR`. Keep
the source manifest unchanged so the same build inputs reproduce the same
deployment file and version.

Pin a deployment to the candidate digest recorded in `published.json`:

```yaml
services:
  server:
    image: ghcr.io/pufflyai/pocketcoder/server@sha256:<candidate-digest>
```

Private pulls require expiring, read-only registry authority held outside all
workspaces. GitHub Actions can use its job-scoped `GITHUB_TOKEN` after the
repository has package read access; give the job `packages: read` and log in
with `github.actor` and `secrets.GITHUB_TOKEN`. Keep registry credentials out
of templates, launch input and workspace images.

Build locally:

```sh
docker build -f deploy/image/server.Dockerfile -t pocketcoder-server:dev .
bun build packages/supervisor/src/index.ts --target bun --outdir deploy/image/dist
docker build -t pocketcoder-workspace:dev deploy/image
```

## Docker compose

[`deploy/compose/docker-compose.yaml`](../deploy/compose/docker-compose.yaml)
runs the server with an embedded PGlite database. For a full containerized control plane, run the
server image with:

- the docker socket mounted (`/var/run/docker.sock`) and the socket's gid in
  `group_add`, so the Docker driver can create workspace containers;
- a template directory mounted read-only at `POCKETCODER_TEMPLATE_DIR`;
- **an input directory mounted at the same absolute path on host and
  container**, with `POCKETCODER_INPUT_DIR` pointing at it. The driver writes
  one-time provider input files there and bind-mounts them into workspaces;
  since the host daemon resolves mount paths, the paths must match.
- `POCKETCODER_WORKSPACE_SERVER_URL=http://host.docker.internal:7081` so
  workspace containers can reach the server.

A complete, disposable worked example (server + PGlite + a locally
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

Set `POCKETCODER_SERVER_IMAGE` to an exact candidate digest and use `--no-build`
to consume the published control plane without a local checkout build:

```sh
export POCKETCODER_SERVER_IMAGE='ghcr.io/pufflyai/pocketcoder/server@sha256:<candidate-digest>'
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

The Docker filesystem path uses size-bounded disposable tmpfs mounts for live
workspace files. Preserved bytes travel over authenticated agent HTTP into
controller-owned archives. Checkpoint directories are never mounted into a
workspace. Restore installs verified bytes before setup and harness readiness.
See the [local checkpoint runbook](docker-checkpoint-round-trip.md) for the tested
development slice and its support boundary.

Use `POCKETCODER_SECRET_PROVIDER=file` plus an absolute
`POCKETCODER_SECRET_ROOT` for local `secretRef:` values. Only bounded regular
files beneath that root are accepted and they must be outside the
workspace/checkpoint roots. Runtime environment secrets are projected
read-only; repository credentials are read by the server and delivered only to
create-time setup over the authenticated supervisor connection.

## Kubernetes

The Kubernetes runtime driver creates one namespaced Job and short-lived input
Secret per workspace. Each declared persistence mount uses a bounded `emptyDir`.
Checkpoint bytes stream through the separate authenticated agent listener into a
private controller archive. A restore uses a new pod and fresh mounts on any
allowed node. The supervisor verifies and installs exact files before setup and
agent readiness. Workspace pods never mount controller storage.

Set `POCKETCODER_STORAGE_BACKEND=controller-archive` and
`POCKETCODER_CHECKPOINT_DIR` inside the controller's private block volume. No
shared live or checkpoint PVC is required. Set each template's
`resources.ephemeralStorage` to at least the sum of its mount limits plus 64 MiB
for logs and its writable layer. Requests and limits use the same value. The
trusted egress sidecar has its own resource budget. Writable memory paths,
including transfer staging in `/tmp`, remain bounded by their 256 MiB volume
limit and the workspace memory limit.

Set `POCKETCODER_KUBERNETES_RUNTIME_CLASS` to the installed RuntimeClass name,
for example `gvisor`. Every workspace and warm pod requests that exact class.
Missing or unusable handlers fail admission; there is no runtime fallback.
Install the handler on each selected node and review its scheduling and overhead
settings. See [RuntimeClass](https://kubernetes.io/docs/concepts/containers/runtime-class/)
and [local ephemeral storage](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/#local-ephemeral-storage).

Run `bun run example:e2e:kubernetes-checkpoint` with Docker, kind and kubectl.
The isolated two-node fixture verifies exact binary files before restore setup,
a working echo agent, RuntimeClass selection and owned pod cleanup. It deletes
its own cluster and private controller data. Hosted gVisor proof is tracked in PC-84.

Restricted templates require Kubernetes 1.29 or newer with the `SidecarContainers` feature
enabled; 1.33 or newer is recommended because native sidecars are stable there. PocketCoder adds a
restartable init sidecar and startup probe. Only that trusted sidecar receives `NET_ADMIN` plus the
transient `SETUID`/`SETGID` capabilities needed to drop to UID 999 after installing the rules; the
UID transition clears all three before the proxy begins serving. The sidecar alone mounts the
per-workspace egress Secret holding the compiled allow rules and the audit callback credential; the
workspace container remains non-root, capability-free, read-only, and unable to mount it.

[`deploy/kubernetes/pocketcoder.yaml`](../deploy/kubernetes/pocketcoder.yaml)
contains separate controller/workspace service accounts, least-privilege
Role/RoleBinding, a single-replica server Deployment, Service, and PVC:

For a DOKS recipe with a private controller block volume, strict image preflight
and optional public HTTPS, see the
[DigitalOcean Kubernetes example](../deploy/digitalocean/README.md).

```sh
kubectl create namespace pocketcoder
kubectl -n pocketcoder create configmap pocketcoder-templates \
  --from-file=/path/to/reviewed/templates
kubectl -n pocketcoder apply -f deploy/kubernetes/pocketcoder.yaml
```

Supply deployment-reviewed template manifests, then replace the image and PVC
storage class/size first. The manifests under `examples/templates` contain
placeholder image references and are not production defaults. Run one
server replica—the connection hub and scheduler are intentionally
single-active. Workspace Jobs use the unprivileged `pocketcoder-workspace`
service account, not the controller account.

Use driver-level scheduling settings to keep all workspace and warm-pool Jobs
on a labeled, tainted node pool:

```sh
export POCKETCODER_KUBERNETES_NODE_SELECTOR='{"onefin.com/workload":"agent-workspace"}'
export POCKETCODER_KUBERNETES_TOLERATIONS='[{"key":"onefin.com/workload","operator":"Equal","value":"agent-workspace","effect":"NoSchedule"}]'
```

The selector must be a JSON object with string values. Tolerations must be a
JSON array. This release supports only the `NoSchedule` effect.

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
bun test packages/drivers/src/kubernetes/kubernetes-conformance.test.ts
```

To test a labeled, tainted workspace node pool, also set
`POCKETCODER_KUBERNETES_CONFORMANCE_IMAGE` to a digest-pinned image and set the
two scheduling variables above. Then run:

```sh
POCKETCODER_KUBERNETES_CONFORMANCE=1 \
bun test packages/drivers/src/kubernetes/kubernetes-scheduling-conformance.test.ts
```

With `POCKETCODER_SECRET_PROVIDER=kubernetes`, a template value
`secretRef:git-credentials/token` resolves key `token` from Secret
`git-credentials`. Repository credentials travel only in the authenticated
setup contract and are cleared before the harness starts; runtime environment
secrets remain read-only projected files. Secret names/values are not stored in
checkpoint manifests.

## Data folder

`POCKETCODER_DIR` defaults to `./pc_data`. The server stores PGlite in its `db/`
subdirectory, with the fixed `pocketcoder` schema. Use local disk or a block
volume, never NFS or EFS. In a container, mount a private volume at `/pc_data`.
Do not mount this folder into workspaces.

The process holds a kernel lock on `LOCK` before opening the database. A second
process fails with "data folder is in use". The operating system releases the
lock when the process dies. Keep the lock file in place; its PID is not a lock.
Only one controller may use a data folder. Kubernetes must fence a failed node
before moving its block volume; `ReadWriteOnce` does not provide a writer lock.

First start loads the bundled, migrated seed into a staging folder, syncs it to
disk and publishes it atomically. Startup checks the embedded migration history
and applies pending migrations in one transaction. Unknown histories, gaps and
checksum drift stop startup. Schema changes require `bun run db:generate`;
`bun run db:seed` rebuilds the seed and embedded SQL registry.

Local principal, key and template database commands take the same folder lock.
Run them while the server is stopped. Keep the auth pepper stable across restarts.
Use `pcd backup create --out <file>` on the running server to capture the database,
keys and checkpoint archives at one point in time (see [getting started](getting-started.md#back-up-the-controller)).
Copying files from a running server is not a consistent backup. Keep the deletion journal
(`POCKETCODER_JOURNAL_DIR`) outside every backup; `pcd backup restore` and `pcd recovery complete`
replay it so a restore cannot revive deleted data.

## Configuration reference

| Variable | Default | Purpose |
|----------|---------|---------|
| `POCKETCODER_DIR` | `./pc_data` | Private embedded database folder on local disk or a block volume |
| `POCKETCODER_JOURNAL_DIR` | folder recorded in the database, else `<POCKETCODER_DIR>-journal` | Deletion journal outside the data folder; restores replay it |
| `POCKETCODER_AUTH_PEPPER` | required (pglite store) | Keyed digest secret for machine keys and registration secrets |
| `POCKETCODER_EVENT_SIGNING_KEY` | pepper | HMAC key for lifecycle event signatures |
| `POCKETCODER_EVENT_SINK_URL` | none | Callback URL for signed lifecycle events |
| `POCKETCODER_EGRESS_IMAGE` | required for restricted templates | Separately published `pocketcoder-egress` image as an immutable `repo@sha256:...` reference |
| `POCKETCODER_TEMPLATE_DIR` | none | Directory of reviewed template manifests |
| `POCKETCODER_HOST` / `POCKETCODER_PORT` | `127.0.0.1` / `8090` | Listen address |
| `POCKETCODER_AGENT_HTTP` | `0.0.0.0:8091` | Separate agent listener |
| `POCKETCODER_WORKSPACE_SERVER_URL` | `http://host.docker.internal:8091` | Agent origin reachable from workspaces; Kubernetes uses the private `pocketcoder-agent` Service |
| `POCKETCODER_INPUT_DIR` | OS tempdir | Provider input files (must be host-shared when the server is containerized) |
| `POCKETCODER_DRIVER` | `docker` | `docker` or `kubernetes` runtime |
| `POCKETCODER_STORAGE_BACKEND` | `disabled` | `filesystem` for Docker or `controller-archive` for Kubernetes |
| `POCKETCODER_WORKSPACE_DATA_DIR` | required with storage | Docker filesystem adapter root |
| `POCKETCODER_CHECKPOINT_DIR` | required with storage | Private controller archive directory |
| `POCKETCODER_SECRET_PROVIDER` | `disabled` | `file` or `kubernetes` |
| `POCKETCODER_SECRET_ROOT` | required for file secrets | Deployment-owned local secret root |
| `POCKETCODER_KUBERNETES_NAMESPACE` | `default` | Namespace for Jobs and input Secrets |
| `POCKETCODER_KUBERNETES_SERVICE_ACCOUNT` | none | Service account assigned to workspace Jobs |
| `POCKETCODER_KUBERNETES_NODE_SELECTOR` | none | JSON object that selects nodes for workspace and warm-pool Jobs |
| `POCKETCODER_KUBERNETES_TOLERATIONS` | `[]` | JSON array of `NoSchedule` tolerations for workspace and warm-pool Jobs |
| `POCKETCODER_KUBERNETES_RUNTIME_CLASS` | none | Exact RuntimeClass for workspace and warm pods; no fallback |
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
- **Protocol upgrades are server-first**: the server accepts workspace
  protocol v1–v5, so deploy it before rolling new workspace images.
  Connected older supervisors keep the capabilities of their version:
  attachment requests below v3 return `attachment.unsupported`. Terminal opens
  below v4 return `terminal.protocol_unsupported`, and streamed relay routes
  below v5 return `relay.streaming_unsupported` until the workspace image
  carries a newer supervisor.
- **Secrets**: never put provider/LLM credentials in templates or launch
  input. An LLM gateway (e.g. agentgateway) should remain the only credential
  boundary; env names that look like secrets are rejected unless they are
  `secretRef:` references. Any credential a workspace *can* read must be
  per-workspace and expire with it — never a shared or standing bearer
  ([security model](security.md)).
- **Backups**: checkpoints survive runtime removal but are not disaster recovery.
  `pcd backup create` captures the database, keys and controller checkpoint archives
  together for Docker and Kubernetes.
- **Retention**: the server sweeps expired ready checkpoints every minute.
  `pcd storage doctor|list-orphans|prune` provides explicit
  inventory and maintenance; unknown physical objects are reported and never
  auto-deleted.

The controller needs namespaced Pod patch permission to retain termination evidence, plus read-only Node identity access. Bind `pocketcoder-node-identity` to the controller ServiceAccount in the deployed namespace. Workspace ServiceAccounts have no API token. Missing evidence keeps cleanup and capacity release pending.
