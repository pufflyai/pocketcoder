# pocketcoder

A lightweight control plane for coding agents in isolated
workspaces. **Documentation lives in [docs/](docs/README.md)**: [getting
started](docs/getting-started.md), [CLI reference](docs/cli.md),
[templates](docs/templates.md), [HTTP API](docs/api.md),
[deployment](docs/deployment.md), and [architecture](docs/architecture.md). It replaces a full Coder deployment for the machine-to-machine
coding-agent use case while keeping the two concepts that matter:

- a **template** is a reviewed, versioned definition of a coding-agent
  environment;
- a **workspace** is one isolated instance of a template and the lifecycle
  record for a single coding-agent session.

There is exactly one execution path:

```text
caller (machine key)
  → pocketcoder-server (Hono REST/WSS on Bun)
  → durable workspace queue (PostgreSQL)
  → workspace driver (Docker locally, Kubernetes in production)
  → one isolated container/Job
  → pocketcoder-agent (PID 1)
  → harness (e.g. AgentAPI wrapping a coding-agent CLI)
```

No browser login, no session tokens, no Terraform, no IDE/SSH surface. Callers
authenticate with named, scoped, revocable machine keys; workspaces talk back
over one outbound WSS connection carrying lifecycle, health, logs, signals,
and an exact allowlisted HTTP relay.

## Custom setup commands and harnesses

Templates own the whole execution surface, so different coding agents need no
code changes, only a new reviewed template:

```jsonc
// deploy/templates/claude-code-agent.json (excerpt)
"spec": {
  "image": "example.registry/coding-agent@sha256:…",   // digest-pinned
  "setup": [                                            // custom setup commands,
    { "name": "clone-workspace-repo", "command": ["/usr/local/bin/clone-repo.sh"] },
    { "name": "install-deps", "command": ["bun", "install", "--frozen-lockfile"] }
  ],
  "harness": {                                          // custom harness
    "command": ["agentapi", "server", "--port", "3284", "--", "claude", "--dangerously-skip-permissions"],
    "cwd": "/home/agent/workspace"
  },
  "services": {                                         // exact relay allowlist
    "agent": {
      "baseUrl": "http://127.0.0.1:3284",
      "routes": [
        { "method": "GET", "path": "/status" },
        { "method": "GET", "path": "/messages", "query": ["after"] },
        { "method": "POST", "path": "/message" }
      ]
    }
  }
}
```

`setup` steps run sequentially before the harness starts; the `harness` is the
long-running conversation service (AgentAPI plus any coding-agent CLI, or
anything else that serves the declared loopback routes). The supervisor
receives both from the server at registration time, so changing them is a
template version bump, not an image rebuild.

## Repository layout

```text
apps/
  pocketcoder-server/   Hono REST/OpenAPI/WSS control plane, scheduler, relay, outbox
  pocketcoder-agent/    PID 1 workspace supervisor (setup, harness, health, logs, relay)
packages/
  cli/                  public bundled pocketcoderctl npm package
  contracts/           zod schemas: templates, workspace states, WSS protocol, events
  auth/                machine keys, one-time secrets, event signing, redaction
  runtime-core/        Store contract, scheduler, template registry, outbox, reconcile
  db/                  PostgreSQL store, Drizzle schema/migrations, advisory lock
  drivers/             workspace-driver contract + Docker provider
  testkit/             in-memory store, fake driver, fake AgentAPI, fixtures
deploy/
  templates/           reviewed template manifests (JSON or YAML)
  compose/             local PostgreSQL for development
examples/
  e2e/                 reusable create → converse → cancel harness contract
  clients/             host-side clients, including local Pi as a remote-agent UI
  harnesses/           runnable echo and Pi harness examples
```

## Quick start (development)

```sh
bun install
bun test                       # full suite (in-memory store; no Docker needed)

# In-memory dev server with the bundled templates:
POCKETCODER_STORE=memory \
POCKETCODER_TEMPLATE_DIR=deploy/templates \
bun run start
```

With PostgreSQL (dedicated database or an existing one; pocketcoder only
touches its own schema, default `pocketcoder`):

```sh
docker compose -f deploy/compose/docker-compose.yaml up -d
export POCKETCODER_DATABASE_URL=postgres://pocketcoder:pocketcoder@127.0.0.1:5433/pocketcoder
export POCKETCODER_DATABASE_SCHEMA=pocketcoder
export POCKETCODER_AUTH_PEPPER=$(openssl rand -base64 32)

bun run ctl db migrate
bun run ctl principals create --name my-backend --scopes workspaces:create,workspaces:read,workspaces:cancel,services:relay,templates:read,logs:read --templates '*'
bun run ctl keys issue --principal my-backend --expires never   # shown once

POCKETCODER_TEMPLATE_DIR=deploy/templates bun run start
```

Then add the machine key to `.env` in the repository root:

```dotenv
POCKETCODER_URL=http://127.0.0.1:7080
POCKETCODER_KEY=pkt_…
```

The CLI discovers this file automatically:

```sh
bun run ctl -- workspaces create --template claude-code-agent
bun run ctl -- workspaces list --active
bun run ctl -- workspaces logs --id $WS

# Converse through the relay once the workspace is ready:
curl -s -X POST "$POCKETCODER_URL/v1/workspaces/$WS/services/agent/message" \
  -H "Authorization: Bearer $POCKETCODER_KEY" -H "content-type: application/json" \
  -d '{"content":"fix the failing test"}'
```

The OpenAPI document is served at `/v1/openapi.json`. CI publishes
`ghcr.io/<owner>/<repo>/server` and `ghcr.io/<owner>/<repo>/workspace` images
on pushes to `main` and version tags (see `.github/workflows/ci.yml`).

## Commands

```sh
bun run check       # Biome formatting and lint checks
bun run format      # format supported files with Biome
bun run test        # all package test suites through Lerna
bun run typecheck   # strict TypeScript across the Lerna workspace
bun run build       # bundle packages through Lerna with Nx caching
bun run db:generate -- --name=<change>  # generate + embed a Drizzle migration
bun run packages    # list packages managed by Lerna
bun run start       # pocketcoder-server
bun run ctl -- …    # pocketcoderctl
bun run example:e2e:local  # disposable full-stack E2E with the echo harness
bun run example:e2e:pi     # remote Pi reads a workspace fixture through AgentAPI
bun run example:pi:ui      # local Pi TUI connected to that remote agent (uses OpenAI)
```

Bun installs and links workspace dependencies and runs each package's scripts.
Lerna coordinates tasks across `apps/*` and `packages/*`; its Nx integration
provides the project graph and task cache configured in `nx.json`.

## Releasing packages

`@pocketcoder/cli` is the only public npm package. It bundles the private
implementation packages into the `pocketcoderctl` executable. Every other
workspace remains private, is linked by Bun with `workspace:*`, and is imported
through its `@pocketcoder/*` package boundary. The server and agent are
distributed as binaries or container images.

The `Release Packages` workflow and Changesets configuration version and
publish only non-private packages. Add a changeset for user-visible CLI changes;
do not add changesets for changes that affect only private packages.

Add a changeset with every user-visible CLI change:

```sh
bun run changeset
```

After changes land on `main`, `Release Packages` opens or updates a version pull
request for non-private packages only. Merging that pull request publishes
those packages and creates GitHub releases.

For tokenless publishing, configure an npm trusted publisher for
`@pocketcoder/cli`, using organization `pufflyai`, repository `pocketcoder`, and
workflow filename `release-packages.yml`. An `NPM_TOKEN` repository secret can
bootstrap the package before trusted publishing is configured.

`POCKETCODER_TEST_DATABASE_URL=postgres://…` additionally runs the PostgreSQL
integration suite (migrations, schema isolation, store behavior).

Harness and client integrations live under [`examples/`](examples/). The
deterministic Pi E2E runs the remote Pi CLI through AgentAPI and proves a real
workspace file read. The interactive variant runs Pi on the host as the UI,
while the coding agent and tools remain inside the workspace. Consumer
applications remain separate projects and integrate through the machine API.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `POCKETCODER_DATABASE_URL` | required (postgres store) | PostgreSQL server/database |
| `POCKETCODER_DATABASE_SCHEMA` | `pocketcoder` | Runtime schema (dedicated or shared DB) |
| `POCKETCODER_STORE` | `postgres` | `memory` for tests/single-process development |
| `POCKETCODER_AUTH_PEPPER` | required (postgres store) | Keyed digest secret for machine keys |
| `POCKETCODER_EVENT_SIGNING_KEY` | pepper | HMAC key for lifecycle event signatures |
| `POCKETCODER_EVENT_SINK_URL` | none | Callback URL for signed lifecycle events |
| `POCKETCODER_TEMPLATE_DIR` | none | Directory of reviewed template manifests |
| `POCKETCODER_HOST` / `POCKETCODER_PORT` | `127.0.0.1:7080` | Listen address |
| `POCKETCODER_WORKSPACE_SERVER_URL` | `http://host.docker.internal:<port>` | URL workspaces use to reach the server |
| `POCKETCODER_MAX_ACTIVE_WORKSPACES` | `100` | Global concurrency limit |
| `POCKETCODER_MAX_ACTIVE_PER_PRINCIPAL` | `20` | Per-principal concurrency limit |
| `POCKETCODER_MAX_QUEUED_WORKSPACES` | `1000` | Durable queue bound |


## License

[MIT](LICENSE)
