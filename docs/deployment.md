# Deployment

## Container images

CI publishes two images to the GitHub Container Registry on every push to
`main` and on version tags (see `.github/workflows/ci.yml`):

- `ghcr.io/<owner>/<repo>/server` — pocketcoder-server plus `pocketcoderctl`
  (at `/opt/pocketcoder/ctl.js`) and the docker CLI for the Docker driver.
  Built from [`deploy/image/server.Dockerfile`](../deploy/image/server.Dockerfile).
- `ghcr.io/<owner>/<repo>/workspace` — a minimal workspace base image with the
  `pocketcoder-agent` supervisor and a loopback echo harness, useful for probe
  templates and as a starting point for real agent images. Built from
  [`deploy/image/Dockerfile`](../deploy/image/Dockerfile).

Real coding-agent images extend the pattern: install AgentAPI by checksum,
your agent CLI, and the supervisor; keep everything runnable by the template's
non-root uid. Always reference images by digest in templates — mutable tags
are rejected.

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

## PostgreSQL placement

One migration/query path serves both layouts:

```text
POCKETCODER_DATABASE_URL      the PostgreSQL server and database
POCKETCODER_DATABASE_SCHEMA   table namespace, default pocketcoder
```

The URL may target a dedicated database or an existing application database.
Every identifier is schema-qualified; the runtime never touches `public`,
other schemas, extensions, or application tables, and creates no cross-schema
dependencies. Migrations run under a schema-scoped advisory lock via
`pocketcoderctl db migrate` (the server also migrates on startup). Recommended
roles: a migration role owning the schema, an application role with
connect/usage/DML only.

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
| `POCKETCODER_MAX_ACTIVE_WORKSPACES` | `100` | Global concurrency limit |
| `POCKETCODER_MAX_ACTIVE_PER_PRINCIPAL` | `20` | Per-principal concurrency limit |
| `POCKETCODER_MAX_QUEUED_WORKSPACES` | `1000` | Durable queue bound |
| `POCKETCODER_SCHEDULER_INTERVAL_MS` | `1000` | Admission/sweep tick |
| `POCKETCODER_OUTBOX_INTERVAL_MS` | `1000` | Event delivery tick |

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
- **Kubernetes**: the Job driver for production containment is planned; the
  driver contract (`create/inspect/terminate/list`) is identical to Docker's,
  and production deployments should refuse the Docker driver.
