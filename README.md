# pocketcoder

A lightweight control plane for coding agents in isolated
workspaces. **Documentation lives in [docs/](docs/README.md)**: [getting
started](docs/getting-started.md), [CLI reference](docs/cli.md),
[templates](docs/templates.md), [HTTP API](docs/api.md),
[deployment](docs/deployment.md), [migration guide](docs/migration.md), and
[architecture](docs/architecture.md). The durable history change has a
[validation playbook](docs/durable-conversation-validation.md). It replaces a full Coder deployment for the machine-to-machine
coding-agent use case while keeping the two concepts that matter:

- a **template** is a reviewed, versioned definition of a coding-agent
  environment;
- a **workspace** is one isolated instance of a template and the lifecycle
  record for a single coding-agent session.

## AgentAPI-native workspaces

Templates declare the coding agent; PocketCoder owns AgentAPI startup,
readiness, relay routes, durable transcript capture, and checkpoint shutdown:

```jsonc
// examples/templates/claude-code-agent.json (excerpt)
"spec": {
  "image": "example.registry/coding-agent@sha256:…",   // digest-pinned
  "setup": [                                            // custom setup commands,
    { "name": "clone-workspace-repo", "command": ["/usr/local/bin/clone-repo.sh"] },
    { "name": "install-deps", "command": ["bun", "install", "--frozen-lockfile"] }
  ],
  "agent": {                                            // coding agent only
    "type": "claude",
    "command": ["claude", "--dangerously-skip-permissions"],
    "cwd": "/home/agent/workspace"
  },
  "terminal": {                                         // optional, fixed command only
    "command": ["/bin/sh"],
    "cwd": "/home/agent/workspace"
  }
}
```

`setup` steps run sequentially before PocketCoder launches its pinned
`/usr/local/bin/agentapi` around `agent.command`. The fixed, bounded
conversation API is `/v1/workspaces/{id}/agent/{status|messages|message}`, plus
a streamed `events` route on snapshots created under workspace protocol v5.
Legacy `harness` and `services` templates remain readable for one migration
release, but cannot be mixed with `agent`.

## Quick start (development)

```sh
bun install
bun test                       # full suite (in-memory store; no Docker needed)

# In-memory control plane with no durable state:
POCKETCODER_STORE=memory bun run pcd -- server start --foreground
```

The manifests in `examples/templates` intentionally contain placeholder image
and gateway values. Validate them offline, but do not use that directory as a
runnable server catalog.

With PostgreSQL (dedicated database or an existing one; pocketcoder only
touches its own schema, default `pocketcoder`):

```sh
docker compose -f deploy/compose/docker-compose.yaml up -d
export POCKETCODER_DATABASE_URL=postgres://pocketcoder:pocketcoder@127.0.0.1:5433/pocketcoder
export POCKETCODER_DATABASE_SCHEMA=pocketcoder
export POCKETCODER_AUTH_PEPPER=$(openssl rand -base64 32)

bun run pcd db migrate
bun run pcd principals create --name my-backend --scopes workspaces:create,workspaces:read,workspaces:cancel,workspaces:restore,conversations:read,conversations:delete,services:relay,attachments:write,templates:read,logs:read,terminal:attach,terminal:read --templates '*'
bun run pcd keys issue --principal my-backend --expires never   # shown once

POCKETCODER_TEMPLATE_DIR=/absolute/path/to/reviewed/runtime-templates \
bun run pcd -- server start
```

Keys issued without `--scopes` inherit live principal scopes. Use `pcd
principals update --name my-backend --scopes ...` to change them without direct
database edits; pass `keys issue --scopes ...` for a key-specific restriction.

For the included Pi harness, the repository convenience builds and
materializes that runtime catalog before starting the gateway and server:

```sh
OPENAI_API_KEY=... OPENAI_MODEL=... \
bun run local:up -- --template pi-harness --openai
```

To manage the server independently, run `local:prepare`, keep
`local:gateway` in a separate terminal, configure
`POCKETCODER_TEMPLATE_DIR`/`POCKETCODER_SECRET_ROOT`, and use `pcd server
start|status|stop`; see the [getting-started guide](docs/getting-started.md).

Then add the machine key to `.env` in the repository root:

```dotenv
POCKETCODER_URL=http://127.0.0.1:7080
POCKETCODER_KEY=pkt_…
```

The CLI discovers this file automatically:

```sh
bun run pcd -- workspaces create --template claude-code-agent --wait
bun run pcd -- workspaces list --active
bun run pcd -- workspaces logs --id $WS
bun run pcd -- workspaces chat --id $WS
bun run pcd -- workspaces terminal --id $WS
bun run pcd -- workspaces preserve --id $WS

# Converse through the relay once the workspace is ready:
curl -s -X POST "$POCKETCODER_URL/v1/workspaces/$WS/agent/message" \
  -H "Authorization: Bearer $POCKETCODER_KEY" -H "content-type: application/json" \
  -d '{"content":"fix the failing test"}'

# Durable history remains available after the relay closes:
curl -s "$POCKETCODER_URL/v1/workspaces/$WS/conversation?limit=100" \
  -H "Authorization: Bearer $POCKETCODER_KEY"
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
bun run pcd -- server start|status|stop  # manage only the configured server process
bun run pcd -- …    # pcd
bun run local:prepare -- --template pi-harness --openai  # build/materialize only
bun run local:gateway -- --openai  # host gateway only
bun run local:up -- --template pi-harness --openai  # persistent local Pi deployment convenience
bun run example:e2e:local  # disposable full-stack E2E with the echo harness
bun run example:e2e:pi     # remote Pi reads a workspace fixture through AgentAPI
bun run example:e2e:codex  # real Codex CLI through AgentAPI and the live relay
bun run example:e2e:opencode # real OpenCode ACP harness through AgentAPI
bun run example:e2e:oss    # combined Codex and OpenCode full-stack matrix
bun run example:pi:ui      # local Pi TUI connected to that remote agent (uses OpenAI)
```

Bun installs and links workspace dependencies and runs each package's scripts.
Lerna coordinates tasks across `apps/*` and `packages/*`; its Nx integration
provides the project graph and task cache configured in `nx.json`.

## Releasing packages

`@pstdio/pocketcoder-cli` is the only public npm package. It bundles the private
implementation packages into the `pcd` executable. Every other
workspace remains private, is linked by Bun with `workspace:*`, and is imported
through its `@pstdio/pocketcoder-*` package boundary. The server and agent are
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
those packages, creates GitHub releases, and pushes the matching `v<version>`
tag. The tag build publishes multi-architecture server/workspace images and
records their immutable digests on that release.

For tokenless publishing, configure an npm trusted publisher for
`@pstdio/pocketcoder-cli`, using organization `pufflyai`, repository
`pocketcoder`, and
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
